// POST /api/assistant/chat/resume — M2.2 confirmation gate.
// When /api/assistant/chat detects a mutation tool_use, it persists the full
// loop state to pending_chat_runs and emits an inline <<BRAINDUMP_PAUSE>>
// marker. The client parses the marker, renders an Accept/Reject card, and
// POSTs here with { run_id, decision }. This handler:
//   1. Loads the pending row (RLS-scoped to the user).
//   2. Executes the pending tool if decision=accept; synthesises a declined
//      tool_result if decision=reject.
//   3. For deferred tool_uses from the same assistant turn: read-only ones
//      execute fresh, extra mutations auto-reject ("only one per turn").
//   4. Appends the assembled tool_result block as a user message and resumes
//      the Claude streaming loop — which may pause again on the next mutation.
//   5. Deletes the pending row so it can't be replayed.

import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  MessageParam,
  TextBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import { after, NextRequest } from "next/server";
import { getRequestToday } from "@/lib/time/request-date";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import {
  buildAssistantSystemPrompt,
  buildAssistantUserPromptParts,
  ASSISTANT_PROMPT_VERSION,
} from "@/lib/ai/prompts/assistant";
import {
  AI_MODELS,
  AI_TEMPERATURE,
  claudeRequestTuning,
} from "@/lib/ai/config";
import { normalizeAIError } from "@/lib/ai/errors";
import { recordClaudeRun } from "@/lib/ai/telemetry";
import { addUsage, EMPTY_USAGE, readClaudeUsage } from "@/lib/ai/usage";
import { cachedSystem, withCacheBreakpoints } from "@/lib/ai/assistant-cache";
import { buildAssistantContext } from "@/lib/ai/context";
import { dispatchEager, dispatchTool, getToolSchemas, isReadOnlyTool, isPausingTool } from "@/lib/ai/tools";
import { encodeAppliedMarker } from "@/lib/chat/applied-marker";
import { resolveChoice } from "@/lib/ai/tools/interactive";
import { actionSucceeded, confirmationFor, looksMultiStep } from "@/lib/ai/tools/confirmations";
import { looksLikeStructuralEdit } from "@/lib/graph/dump-heuristic";
import type { AssistantMode } from "@/types/ai";

const MAX_TOOL_ROUNDS = 6;
const TOOL_RESULT_MAX_CHARS = 2000;

function truncateToolContent(
  content: string | Array<{ type: "text"; text: string }>,
): string | Array<{ type: "text"; text: string }> {
  if (typeof content === "string") {
    if (content.length <= TOOL_RESULT_MAX_CHARS) return content;
    return content.slice(0, TOOL_RESULT_MAX_CHARS) + "\n…[truncated]";
  }
  return content.map((b) => {
    if (b.type !== "text" || b.text.length <= TOOL_RESULT_MAX_CHARS) return b;
    return {
      type: "text" as const,
      text: b.text.slice(0, TOOL_RESULT_MAX_CHARS) + "\n…[truncated]",
    };
  });
}

interface DeferredToolUse {
  id: string;
  name: string;
  input: unknown;
}

// The original user question, dug out of the persisted message history so the
// resume turn can pick the same model tier the initial turn would (Haiku for
// chat, Sonnet for graph edits). Skips tool_result-only user turns and strips
// the "User question:" preamble the chat route wraps the message in.
function lastUserQuestion(messages: MessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      const blocks = m.content
        .filter((b): b is TextBlockParam => (b as { type?: string }).type === "text")
        .map((b) => b.text);
      if (blocks.length === 0) continue; // tool_result-only turn
      text = blocks.join("\n");
    }
    if (!text) continue;
    const marker = text.lastIndexOf("User question:");
    return marker >= 0 ? text.slice(marker + "User question:".length).trim() : text;
  }
  return "";
}

export async function POST(req: NextRequest) {
  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return new Response("Server configuration error", { status: 500 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { run_id, decision, choice } = body as {
    run_id?: string;
    decision?: string;
    choice?: string;
  };
  if (!run_id || typeof run_id !== "string") {
    return new Response("run_id is required", { status: 400 });
  }
  if (decision !== "accept" && decision !== "reject" && decision !== "choice") {
    return new Response("decision must be 'accept', 'reject', or 'choice'", { status: 400 });
  }

  // ---------------------------------------------------------------------------
  // Load pending run (RLS scopes this to the authed user).
  // ---------------------------------------------------------------------------
  const { data: run, error: runErr } = await supabase
    .from("pending_chat_runs")
    .select(
      "id, user_id, workspace_id, selected_node_id, mode, messages, pending_tool_use_id, pending_tool_name, pending_tool_input, deferred_tool_uses, expires_at",
    )
    .eq("id", run_id)
    .eq("user_id", user.id)
    .single();

  if (runErr || !run) {
    return new Response("Pending run not found", { status: 404 });
  }

  if (new Date(run.expires_at as string).getTime() < Date.now()) {
    // Clean up the expired row before refusing, so it doesn't linger.
    await supabase.from("pending_chat_runs").delete().eq("id", run.id);
    return new Response("Pending run expired. Ask again.", { status: 410 });
  }

  const resolvedMode: AssistantMode = (["explain", "plan", "transform"] as const).includes(
    run.mode as AssistantMode,
  )
    ? (run.mode as AssistantMode)
    : "explain";

  const workspaceId = run.workspace_id as string;
  const selectedNodeId = (run.selected_node_id as string | null) ?? null;
  const messages = run.messages as unknown as MessageParam[];
  const deferred = (run.deferred_tool_uses as unknown as DeferredToolUse[]) ?? [];

  // The user's local date (bd_tz cookie) — used by the system prompt and by
  // tools that log habits / default calendar ranges. Never the UTC date.
  const todayISO = await getRequestToday();
  const toolCtx = {
    supabase,
    userId: user.id,
    workspaceId,
    selectedNodeId,
    today: todayISO,
    // A new node's judgment + rescore run once the reply is out, so Accept
    // doesn't wait ~3 s on a model call (lib/graph/change-set.ts).
    defer: (work: () => Promise<void>) => after(work),
  };

  // Match the initial turn's model tier: a structural-edit thread continues on
  // Sonnet so the follow-up reasoning (and any next proposal) stays strong;
  // chat and simple edits stay on Haiku. Derived from the original user question in the
  // persisted history. See issue #19 + /api/assistant/chat.
  const assistantModel = looksLikeStructuralEdit(lastUserQuestion(messages))
    ? AI_MODELS.CLAUDE_SONNET
    : AI_MODELS.CLAUDE_HAIKU;

  // ---------------------------------------------------------------------------
  // Build the tool_result batch for the paused assistant turn.
  // The assistant turn is already the last message in `messages`; we now
  // append a user turn carrying one tool_result per original tool_use.
  // ---------------------------------------------------------------------------
  const toolResults: ToolResultBlockParam[] = [];
  // The accepted action's own result, kept untruncated for the no-model reply.
  let acceptedResult: { content: string; isError: boolean } | null = null;

  // Primary (the one the user explicitly answered).
  const isChoiceTool = run.pending_tool_name === "ask_choice";
  if (isChoiceTool) {
    // ask_choice doesn't run a handler — the user's pick IS the result.
    // resolveChoice validates it against the options actually offered.
    const offered = (run.pending_tool_input as { options?: unknown })?.options;
    const resolution = resolveChoice(offered, choice);
    if (!resolution.ok) {
      await supabase.from("pending_chat_runs").delete().eq("id", run.id);
      return new Response("choice must be one of the offered options", { status: 400 });
    }
    toolResults.push({
      type: "tool_result",
      tool_use_id: run.pending_tool_use_id as string,
      content: JSON.stringify({ chosen: resolution.chosen }),
      is_error: false,
    });
  } else if (decision === "accept") {
    const result = await dispatchTool({
      name: run.pending_tool_name as string,
      input: run.pending_tool_input,
      tool_use_id: run.pending_tool_use_id as string,
      ctx: toolCtx,
    });
    acceptedResult = { content: result.content, isError: result.is_error };
    toolResults.push({
      type: "tool_result",
      tool_use_id: result.tool_use_id,
      content: truncateToolContent(result.content),
      is_error: result.is_error,
    });
    // NOTE: connection inference on newly-created nodes is handled client-side
    // in app-shell after the resume stream completes (graph reload → diff new
    // node IDs → analyzeNodes → /api/nodes/analyze), which also surfaces the
    // proposed edges in the edge-review modal. Do NOT run it here too — that
    // would double the infer_edge spend.
  } else {
    toolResults.push({
      type: "tool_result",
      tool_use_id: run.pending_tool_use_id as string,
      content: JSON.stringify({
        accepted: false,
        reason: "User declined the proposed action.",
      }),
      is_error: false,
    });
  }

  // Deferred — read-only tools run fresh; any pausing tool (extra mutation or
  // ask_choice) is auto-rejected because the UI only resolves one card per turn.
  for (const def of deferred) {
    if (!isReadOnlyTool(def.name)) {
      toolResults.push({
        type: "tool_result",
        tool_use_id: def.id,
        content: JSON.stringify({
          accepted: false,
          reason:
            "Only one action can be confirmed per turn. Re-propose this if you still want it.",
        }),
        is_error: false,
      });
      continue;
    }
    const result = await dispatchTool({
      name: def.name,
      input: def.input,
      tool_use_id: def.id,
      ctx: toolCtx,
    });
    toolResults.push({
      type: "tool_result",
      tool_use_id: result.tool_use_id,
      content: truncateToolContent(result.content),
      is_error: result.is_error,
    });
  }

  messages.push({ role: "user", content: toolResults });

  // Delete the pending row now — from here on the loop either completes or
  // writes a fresh pending row if Claude proposes another mutation.
  await supabase.from("pending_chat_runs").delete().eq("id", run.id);

  // A simple, single action that succeeded needs no follow-up model call —
  // it would only say "Done" while re-sending the whole prompt. Structural
  // (Sonnet) threads, multi-step asks, anything queued behind it, and
  // failures still go back to the model so it can continue, re-propose or
  // explain. plan_day is a
  // single action even though it runs on the Sonnet tier.
  if (
    decision === "accept" &&
    acceptedResult &&
    deferred.length === 0 &&
    actionSucceeded(acceptedResult.content, acceptedResult.isError) &&
    !looksMultiStep(lastUserQuestion(messages)) &&
    (assistantModel === AI_MODELS.CLAUDE_HAIKU || run.pending_tool_name === "plan_day")
  ) {
    return new Response(confirmationFor(run.pending_tool_name as string, acceptedResult.content), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Resume-Decision": decision,
        "X-Resume-Model": "none",
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Resume the Claude streaming loop.
  // ---------------------------------------------------------------------------
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  if (!claudeKey) {
    return new Response("ANTHROPIC_API_KEY is not configured", { status: 500 });
  }
  const client = new Anthropic({ apiKey: claudeKey });
  // Same cache layout as the initial turn (src/lib/ai/assistant-cache.ts).
  // The graph snapshot is rebuilt now, AFTER the accepted action ran, so the
  // model continues from the graph as it is — that re-writes the snapshot and
  // the thread after it once; the static prompt is still read from cache.
  const ctx = await buildAssistantContext({
    workspaceId,
    userId: user.id,
    selectedNodeId,
    supabase,
    message: lastUserQuestion(messages),
    today: todayISO,
  });
  const { contextBlock } = buildAssistantUserPromptParts({
    message: "",
    context: ctx.contextString,
    scope: ctx.scopeLabel,
  });
  const tools = getToolSchemas();
  const systemPromptBlocks = cachedSystem(
    buildAssistantSystemPrompt(resolvedMode, todayISO),
    contextBlock,
  );

  const start = Date.now();

  let aborted = false;
  let currentStreamRef: ReturnType<typeof client.messages.stream> | null = null;

  const readable = new ReadableStream({
    async start(controller) {
      let usage = EMPTY_USAGE;
      let fullText = "";
      let streamError: ReturnType<typeof normalizeAIError> | null = null;

      const encoder = new TextEncoder();
      const send = (chunk: string) => {
        if (aborted) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          aborted = true;
        }
      };

      try {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          if (aborted) break;
          const currentStream = client.messages.stream({
            model: assistantModel,
            max_tokens: 2048,
            ...claudeRequestTuning(assistantModel, AI_TEMPERATURE.ASSISTANT),
            system: systemPromptBlocks,
            tools,
            messages: withCacheBreakpoints(messages, null),
          });
          currentStreamRef = currentStream;

          for await (const event of currentStream) {
            if (aborted) break;
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              const chunk = event.delta.text;
              fullText += chunk;
              send(chunk);
            }
            if (event.type === "message_start" && event.message.usage) {
              usage = addUsage(usage, { ...readClaudeUsage(event.message.usage), output: 0 });
            }
            if (event.type === "message_delta" && event.usage) {
              usage = { ...usage, output: usage.output + (event.usage.output_tokens ?? 0) };
            }
          }

          if (aborted) break;

          const finalMessage = await currentStream.finalMessage();
          messages.push({ role: "assistant", content: finalMessage.content });

          if (finalMessage.stop_reason !== "tool_use") {
            break;
          }

          const toolUseBlocks = finalMessage.content.filter(
            (block: ContentBlock): block is ToolUseBlock => block.type === "tool_use",
          );
          if (toolUseBlocks.length === 0) break;

          // Same pause logic as the initial chat route — if Claude wants a
          // pausing tool again (mutation or ask_choice), stash state and emit a
          // new pause marker.
          const firstPauseIdx = toolUseBlocks.findIndex((b) => isPausingTool(b.name));
          if (firstPauseIdx >= 0) {
            const pending = toolUseBlocks[firstPauseIdx];
            const newDeferred = toolUseBlocks.filter((_, i) => i !== firstPauseIdx);

            const { data: runRow, error: pendingErr } = await supabase
              .from("pending_chat_runs")
              .insert({
                user_id: user.id,
                workspace_id: workspaceId,
                selected_node_id: selectedNodeId,
                mode: resolvedMode,
                messages: messages as unknown as object,
                pending_tool_use_id: pending.id,
                pending_tool_name: pending.name,
                pending_tool_input: (pending.input ?? {}) as object,
                deferred_tool_uses: newDeferred.map((b) => ({
                  id: b.id,
                  name: b.name,
                  input: b.input ?? {},
                })) as unknown as object,
              })
              .select("id")
              .single();

            if (pendingErr || !runRow) {
              console.error("[assistant/chat/resume] failed to persist pending run:", pendingErr);
              send("\n\n[Could not prepare the confirmation card. Retry the request.]");
              break;
            }

            const marker = {
              run_id: runRow.id as string,
              tool_use_id: pending.id,
              tool_name: pending.name,
              tool_input: pending.input ?? {},
            };
            send(`<<BRAINDUMP_PAUSE>>${JSON.stringify(marker)}<</BRAINDUMP_PAUSE>>`);
            break;
          }

          const ran = await Promise.all(
            toolUseBlocks.map((block: ToolUseBlock) =>
              dispatchEager({
                name: block.name,
                input: block.input,
                tool_use_id: block.id,
                ctx: toolCtx,
              }),
            ),
          );
          // Same as the chat route: a direct tool's change reaches the
          // browser as an applied card with an Undo.
          for (const { applied } of ran) {
            if (applied) send(encodeAppliedMarker(applied));
          }
          const results: ToolResultBlockParam[] = ran.map(({ result }) => ({
            type: "tool_result" as const,
            tool_use_id: result.tool_use_id,
            content: truncateToolContent(result.content),
            is_error: result.is_error,
          }));

          messages.push({ role: "user", content: results });

          if (round === MAX_TOOL_ROUNDS - 1) {
            send("\n\n[Reached the tool-call limit. Ask again if you need more detail.]");
          }
        }
      } catch (err) {
        streamError = normalizeAIError(err, "Assistant response was interrupted");
        send(`\n\n[${streamError.userMessage} Retry the request.]`);
        console.error("[assistant/chat/resume] stream error:", streamError.message);
      }

      try {
        await recordClaudeRun({
          scope: { supabase, userId: user.id, workspaceId },
          source: "assistant-chat-resume",
          runType: "assistant",
          model: assistantModel,
          promptVersion: `${ASSISTANT_PROMPT_VERSION}:${resolvedMode}:resume-${decision}`,
          usage,
          latencyMs: Date.now() - start,
          status: streamError ? "failed" : "success",
          errorText: streamError?.message ?? null,
          inputHash: run.id as string,
          outputHash: fullText ? fullText.slice(0, 16) : null,
        });
      } catch (logErr) {
        console.error("[assistant/chat/resume] failed to log ai_run:", logErr);
      }

      try {
        controller.close();
      } catch {
        // Already closed by client cancel.
      }
    },

    cancel() {
      aborted = true;
      try {
        currentStreamRef?.abort();
      } catch {
        // SDK past the abortable window.
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Accel-Buffering": "no",
      "X-Resume-Decision": decision,
    },
  });
}
