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
import { NextRequest } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import {
  buildAssistantSystemPrompt,
  ASSISTANT_PROMPT_VERSION,
} from "@/lib/ai/prompts/assistant";
import { AI_MODELS, AI_TEMPERATURE, AI_COST_PER_1M_TOKENS } from "@/lib/ai/config";
import { normalizeAIError } from "@/lib/ai/errors";
import { persistAIRun } from "@/lib/ai/telemetry";
import { dispatchTool, getToolSchemas, isReadOnlyTool, isPausingTool } from "@/lib/ai/tools";
import { resolveChoice } from "@/lib/ai/tools/interactive";
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

  const toolCtx = {
    supabase,
    userId: user.id,
    workspaceId,
    selectedNodeId,
  };

  // ---------------------------------------------------------------------------
  // Build the tool_result batch for the paused assistant turn.
  // The assistant turn is already the last message in `messages`; we now
  // append a user turn carrying one tool_result per original tool_use.
  // ---------------------------------------------------------------------------
  const toolResults: ToolResultBlockParam[] = [];

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
    toolResults.push({
      type: "tool_result",
      tool_use_id: result.tool_use_id,
      content: truncateToolContent(result.content),
      is_error: result.is_error,
    });
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

  // ---------------------------------------------------------------------------
  // Resume the Claude streaming loop.
  // ---------------------------------------------------------------------------
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  if (!claudeKey) {
    return new Response("ANTHROPIC_API_KEY is not configured", { status: 500 });
  }
  const client = new Anthropic({ apiKey: claudeKey });
  const baseTools = getToolSchemas();
  const tools = baseTools.map((t, i) =>
    i === baseTools.length - 1
      ? { ...t, cache_control: { type: "ephemeral" as const } }
      : t,
  );
  const systemPromptBlocks: TextBlockParam[] = [
    {
      type: "text",
      text: buildAssistantSystemPrompt(resolvedMode, new Date().toISOString().slice(0, 10)),
      cache_control: { type: "ephemeral" },
    },
  ];

  const start = Date.now();

  let aborted = false;
  let currentStreamRef: ReturnType<typeof client.messages.stream> | null = null;

  const readable = new ReadableStream({
    async start(controller) {
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCacheReadTokens = 0;
      let totalCacheWriteTokens = 0;
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
            model: AI_MODELS.CLAUDE_HAIKU,
            max_tokens: 2048,
            temperature: AI_TEMPERATURE.ASSISTANT,
            system: systemPromptBlocks,
            tools,
            messages,
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
              const u = event.message.usage as {
                input_tokens?: number;
                cache_read_input_tokens?: number | null;
                cache_creation_input_tokens?: number | null;
              };
              totalInputTokens += u.input_tokens ?? 0;
              totalCacheReadTokens += u.cache_read_input_tokens ?? 0;
              totalCacheWriteTokens += u.cache_creation_input_tokens ?? 0;
            }
            if (event.type === "message_delta" && event.usage) {
              totalOutputTokens += event.usage.output_tokens ?? 0;
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

          const results: ToolResultBlockParam[] = await Promise.all(
            toolUseBlocks.map(async (block: ToolUseBlock) => {
              const result = await dispatchTool({
                name: block.name,
                input: block.input,
                tool_use_id: block.id,
                ctx: toolCtx,
              });
              return {
                type: "tool_result" as const,
                tool_use_id: result.tool_use_id,
                content: truncateToolContent(result.content),
                is_error: result.is_error,
              };
            }),
          );

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
        const latencyMs = Date.now() - start;
        const haikuIn = AI_COST_PER_1M_TOKENS.CLAUDE_HAIKU_INPUT;
        const haikuOut = AI_COST_PER_1M_TOKENS.CLAUDE_HAIKU_OUTPUT;
        const estimatedCost =
          (totalInputTokens / 1_000_000) * haikuIn +
          (totalCacheReadTokens / 1_000_000) * (haikuIn * 0.1) +
          (totalCacheWriteTokens / 1_000_000) * (haikuIn * 1.25) +
          (totalOutputTokens / 1_000_000) * haikuOut;

        await persistAIRun({
          supabase,
          userId: user.id,
          workspaceId,
          source: "assistant-chat-resume",
          run: {
            run_type: "assistant",
            provider: "claude",
            model_name: AI_MODELS.CLAUDE_HAIKU,
            prompt_version: `${ASSISTANT_PROMPT_VERSION}:${resolvedMode}:resume-${decision}`,
            input_hash: run.id as string,
            output_hash: fullText ? fullText.slice(0, 16) : null,
            input_tokens: totalInputTokens + totalCacheReadTokens + totalCacheWriteTokens,
            output_tokens: totalOutputTokens,
            latency_ms: latencyMs,
            estimated_cost: estimatedCost,
            status: streamError ? "failed" : "success",
            error_text: streamError?.message ?? null,
          },
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
