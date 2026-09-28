// POST /api/assistant/chat — Phase 8.4 + M1 agent loop.
// Streaming chat route. Assembles graph context (token-budgeted), runs Claude
// in an agent loop that can call read-only tools (search_nodes, get_node,
// get_recent_activity, get_workspace_summary, get_calendar), streams tokens
// back as plain text, and logs an ai_run record.

import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  MessageParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import { NextRequest } from "next/server";
import { getRequestToday } from "@/lib/time/request-date";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { buildAssistantContext } from "@/lib/ai/context";
import {
  buildAssistantSystemPrompt,
  buildAssistantUserPromptParts,
  ASSISTANT_PROMPT_VERSION,
} from "@/lib/ai/prompts/assistant";
import {
  AI_MODELS,
  AI_TEMPERATURE,
  AI_RATE_LIMITS,
  claudeRequestTuning,
} from "@/lib/ai/config";
import { looksLikeGraphEdit } from "@/lib/graph/dump-heuristic";
import { checkAIRunRateLimit } from "@/lib/ai/rate-limit";
import { hashText, normalizeAIError } from "@/lib/ai/errors";
import { recordClaudeRun } from "@/lib/ai/telemetry";
import { addUsage, EMPTY_USAGE, readClaudeUsage } from "@/lib/ai/usage";
import { cachedSystem, cachedTools, withCacheBreakpoints } from "@/lib/ai/assistant-cache";
import { dispatchTool, getToolSchemas, isPausingTool } from "@/lib/ai/tools";
import { buildHistoryMessages, sanitizeHistory } from "@/lib/ai/chat-memory";
import { getTemporalFlag } from "@/lib/ai/temporal-flags";
import type { AssistantMode } from "@/types/ai";

const VALID_MODES: AssistantMode[] = ["explain", "plan", "transform"];

// Hard ceiling on tool rounds to prevent runaway loops (a well-behaved model
// resolves in 1–3 rounds; anything past 6 is almost certainly pathological).
const MAX_TOOL_ROUNDS = 6;

// Cap on tool_result content size before it gets fed back to the model.
// Tool payloads can balloon fast (search_nodes with 20 results ~= 5k tokens).
// Since every round re-sends the full transcript, trimming here compounds.
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
    return { type: "text" as const, text: b.text.slice(0, TOOL_RESULT_MAX_CHARS) + "\n…[truncated]" };
  });
}

// Cheap regex classifier for messages that clearly don't need the graph or
// tools: greetings, one-word acknowledgments, "thanks", etc. These get a tiny
// Haiku call with no context/tools — ~100 input tokens instead of ~5000.
// A miss is harmless (the model just answers without data it didn't need).
const SIMPLE_ASK_PATTERN = /^\s*(hi|hello|hey|yo|howdy|thanks|thank you|ty|ok|okay|cool|nice|got it|sure|sounds good|great|awesome|perfect|no|yes|yep|nope)[!.?\s]*$/i;

function isSimpleAsk(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > 60) return false;
  return SIMPLE_ASK_PATTERN.test(trimmed);
}

export async function POST(req: NextRequest) {
  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // Parse body
  // ---------------------------------------------------------------------------
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const {
    message,
    workspace_id,
    selected_node_id = null,
    mode = "explain",
    history: rawHistory,
  } = body as {
    message: string;
    workspace_id: string;
    selected_node_id?: string | null;
    mode?: string;
    history?: unknown;
  };

  const history = sanitizeHistory(rawHistory);

  if (!message || typeof message !== "string" || !message.trim()) {
    return new Response("message is required", { status: 400 });
  }
  if (message.length > AI_RATE_LIMITS.CHAT_MESSAGE_MAX_CHARS) {
    return new Response(
      `Message too long. Maximum ${AI_RATE_LIMITS.CHAT_MESSAGE_MAX_CHARS} characters.`,
      { status: 400 },
    );
  }
  if (!workspace_id || typeof workspace_id !== "string") {
    return new Response("workspace_id is required", { status: 400 });
  }
  const resolvedMode: AssistantMode = VALID_MODES.includes(mode as AssistantMode)
    ? (mode as AssistantMode)
    : "explain";

  // Model routing: plain Q&A stays on cheap Haiku, but a message that reads as a
  // GRAPH-EDITING command escalates the whole turn to Sonnet. The model that
  // emits the mutation is the one doing the structural reasoning (split-vs-
  // replace, correct parent, batching), so the choice must be made up-front —
  // by the time Haiku "notices" it's editing, the decision is already made.
  // This mirrors the dump path (braindump → Sonnet extraction) for the
  // imperative edits that never trip the dump heuristic. See issue #19.
  const assistantModel = looksLikeGraphEdit(message)
    ? AI_MODELS.CLAUDE_SONNET
    : AI_MODELS.CLAUDE_HAIKU;

  // ---------------------------------------------------------------------------
  // Verify workspace belongs to user
  // ---------------------------------------------------------------------------
  const { data: workspace, error: wsError } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspace_id)
    .eq("user_id", user.id)
    .single();

  if (wsError || !workspace) {
    return new Response("Workspace not found or access denied", { status: 404 });
  }

  const rl = await checkAIRunRateLimit({
    supabase,
    userId: user.id,
    runType: "assistant",
    maxPerHour: AI_RATE_LIMITS.CHAT_PER_HOUR,
  });
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({ error: "Rate limit exceeded. Try again later.", reset_at: rl.resetAt }),
      { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "3600" } },
    );
  }

  // ---------------------------------------------------------------------------
  // Simple-ask short-circuit: greetings / acknowledgments skip context + tools.
  // Saves ~4-5k input tokens per turn on chit-chat.
  // ---------------------------------------------------------------------------
  if (isSimpleAsk(message)) {
    const claudeKey = process.env.ANTHROPIC_API_KEY;
    if (!claudeKey) {
      return new Response("ANTHROPIC_API_KEY is not configured", { status: 500 });
    }
    const client = new Anthropic({ apiKey: claudeKey });
    const priorMessages = buildHistoryMessages(history);

    const readable = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let fullText = "";
        let usage = EMPTY_USAGE;
        const t0 = Date.now();
        try {
          const stream = client.messages.stream({
            model: AI_MODELS.CLAUDE_HAIKU,
            max_tokens: 256,
            temperature: AI_TEMPERATURE.ASSISTANT,
            system:
              "You are a friendly assistant inside BrainDump. The user said something conversational (a greeting, thanks, acknowledgment). Reply warmly in one short sentence. Do not reference the graph or suggest actions unless asked.",
            messages: [...priorMessages, { role: "user", content: message.trim() }],
          });
          for await (const ev of stream) {
            if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
              const chunk = ev.delta.text;
              fullText += chunk;
              controller.enqueue(encoder.encode(chunk));
            }
            if (ev.type === "message_start" && ev.message.usage) {
              usage = addUsage(usage, { ...readClaudeUsage(ev.message.usage), output: 0 });
            }
            if (ev.type === "message_delta" && ev.usage) {
              usage = { ...usage, output: usage.output + (ev.usage.output_tokens ?? 0) };
            }
          }
        } catch (err) {
          const norm = normalizeAIError(err, "Assistant response was interrupted");
          controller.enqueue(encoder.encode(`\n\n[${norm.userMessage}]`));
        }
        await recordClaudeRun({
          scope: { supabase, userId: user.id, workspaceId: workspace_id },
          source: "assistant-chat",
          runType: "assistant",
          model: AI_MODELS.CLAUDE_HAIKU,
          promptVersion: `${ASSISTANT_PROMPT_VERSION}:${resolvedMode}:simple`,
          usage,
          latencyMs: Date.now() - t0,
          inputHash: hashText(message.trim()),
          outputHash: fullText ? hashText(fullText).slice(0, 16) : null,
        });
        try { controller.close(); } catch { /* already closed */ }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Accel-Buffering": "no",
        "X-Scope": "simple-ask",
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Assemble context (Phase 8.2 + 8.3)
  // ---------------------------------------------------------------------------
  const ctx = await buildAssistantContext({
    workspaceId: workspace_id,
    userId: user.id,
    selectedNodeId: selected_node_id ?? null,
    supabase,
    message: message.trim(),
  });

  // The user's local date (bd_tz cookie), not UTC — the model resolves
  // "today"/"tomorrow" and the tools log habits against it.
  const todayISO = await getRequestToday();
  const systemPrompt = buildAssistantSystemPrompt(resolvedMode, todayISO);
  // Temporal awareness: a cheap, AI-free flag if the user keeps circling a node
  // across days without finishing it. Injected into the uncached message block.
  // Only computed on the opening turn of a thread — the signal is stable within
  // a conversation, so checking once (when history is empty) avoids 1-2 DB
  // queries on every subsequent turn.
  const temporalFlag =
    history.length === 0
      ? await getTemporalFlag(supabase, user.id, workspace_id, selected_node_id ?? null)
      : "";
  const { contextBlock, messageBlock } = buildAssistantUserPromptParts({
    message: message.trim(),
    context: ctx.contextString,
    scope: ctx.scopeLabel,
    temporalFlag,
  });
  // Persisted hash still uses the full prompt string so telemetry matches old rows.
  const userPromptForHash = `${contextBlock}\n\n${messageBlock}`;

  // ---------------------------------------------------------------------------
  // Claude client
  // ---------------------------------------------------------------------------
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  if (!claudeKey) {
    return new Response("ANTHROPIC_API_KEY is not configured", { status: 500 });
  }

  const client = new Anthropic({ apiKey: claudeKey });
  // Prompt-cache layout (tools/system 1h, history + last message 5m): see
  // src/lib/ai/assistant-cache.ts.
  const tools = cachedTools(getToolSchemas());
  const toolCtx = {
    supabase,
    userId: user.id,
    workspaceId: workspace_id,
    selectedNodeId: selected_node_id,
    today: todayISO,
  };

  const systemPromptBlocks = cachedSystem(systemPrompt);

  // Conversation state — the thread's recent turns verbatim, then the current
  // turn: the graph context preamble + the user's message.
  const priorMessages = buildHistoryMessages(history);
  const historyEnd = priorMessages.length > 0 ? priorMessages.length - 1 : null;
  const messages: MessageParam[] = [
    ...priorMessages,
    {
      role: "user",
      content: [
        { type: "text", text: contextBlock },
        { type: "text", text: messageBlock },
      ],
    },
  ];

  const start = Date.now();

  let aborted = false;
  let currentStreamRef: ReturnType<typeof client.messages.stream> | null = null;

  const readable = new ReadableStream({
    async start(controller) {
      let usage = EMPTY_USAGE;
      let fullText = "";
      let streamError: ReturnType<typeof normalizeAIError> | null = null;
      let currentStream: ReturnType<typeof client.messages.stream> | null = null;

      const encoder = new TextEncoder();
      const send = (chunk: string) => {
        if (aborted) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Controller already closed (client aborted) — stop trying.
          aborted = true;
        }
      };

      try {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          if (aborted) break;

          currentStream = client.messages.stream({
            model: assistantModel,
            max_tokens: 2048,
            ...claudeRequestTuning(assistantModel, AI_TEMPERATURE.ASSISTANT),
            system: systemPromptBlocks,
            tools,
            messages: withCacheBreakpoints(messages, historyEnd),
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
          currentStream = null;

          // Record the assistant turn (text + any tool_use blocks) so the
          // next round's context is coherent.
          messages.push({ role: "assistant", content: finalMessage.content });

          if (finalMessage.stop_reason !== "tool_use") {
            // end_turn / max_tokens / stop_sequence — we're done.
            break;
          }

          // Execute every tool_use block in this turn.
          const toolUseBlocks = finalMessage.content.filter(
            (block: ContentBlock): block is ToolUseBlock => block.type === "tool_use",
          );

          if (toolUseBlocks.length === 0) {
            // Shouldn't happen when stop_reason is tool_use, but bail safely.
            break;
          }

          // If Claude proposed a pausing tool (a mutation to confirm, or an
          // ask_choice question), pause the loop. Persist the current history +
          // the pending + deferred tool_use blocks so the resume endpoint can
          // pick up where we left off once the user responds via the inline card.
          const firstPauseIdx = toolUseBlocks.findIndex((b: ToolUseBlock) =>
            isPausingTool(b.name),
          );
          if (firstPauseIdx >= 0) {
            const pending = toolUseBlocks[firstPauseIdx];
            const deferred = toolUseBlocks.filter(
              (_: ToolUseBlock, i: number) => i !== firstPauseIdx,
            );

            const { data: runRow, error: pendingErr } = await supabase
              .from("pending_chat_runs")
              .insert({
                user_id: user.id,
                workspace_id: workspace_id,
                selected_node_id: selected_node_id ?? null,
                mode: resolvedMode,
                messages: messages as unknown as object,
                pending_tool_use_id: pending.id,
                pending_tool_name: pending.name,
                pending_tool_input: (pending.input ?? {}) as object,
                deferred_tool_uses: deferred.map((b: ToolUseBlock) => ({
                  id: b.id,
                  name: b.name,
                  input: b.input ?? {},
                })) as unknown as object,
              })
              .select("id")
              .single();

            if (pendingErr || !runRow) {
              console.error("[assistant/chat] failed to persist pending run:", pendingErr);
              send("\n\n[Could not prepare the confirmation card. Retry the request.]");
              break;
            }

            // Inline pause marker — the client parses this out of the stream
            // and renders the Accept/Reject card, then POSTs to
            // /api/assistant/chat/resume with the run_id.
            const marker = {
              run_id: runRow.id as string,
              tool_use_id: pending.id,
              tool_name: pending.name,
              tool_input: pending.input ?? {},
            };
            send(`<<BRAINDUMP_PAUSE>>${JSON.stringify(marker)}<</BRAINDUMP_PAUSE>>`);
            break;
          }

          const toolResults: ToolResultBlockParam[] = await Promise.all(
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

          messages.push({ role: "user", content: toolResults });

          if (round === MAX_TOOL_ROUNDS - 1) {
            // Final round already consumed — force a text-only close.
            send("\n\n[Reached the tool-call limit. Ask again if you need more detail.]");
          }
        }
      } catch (err) {
        streamError = normalizeAIError(err, "Assistant response was interrupted");
        send(`\n\n[${streamError.userMessage} Retry the request.]`);
        console.error("[assistant/chat] stream error:", streamError.message);
      }

      // -----------------------------------------------------------------------
      // Phase 8.5 — log ai_run with token counts (best-effort)
      // -----------------------------------------------------------------------
      try {
        await recordClaudeRun({
          scope: { supabase, userId: user.id, workspaceId: workspace_id },
          source: "assistant-chat",
          runType: "assistant",
          model: assistantModel,
          promptVersion: `${ASSISTANT_PROMPT_VERSION}:${resolvedMode}`,
          usage,
          latencyMs: Date.now() - start,
          status: streamError ? "failed" : "success",
          errorText: streamError?.message ?? null,
          inputHash: hashText(userPromptForHash),
          outputHash: fullText ? hashText(fullText).slice(0, 16) : null,
        });

        if (ctx.itemsTruncated > 0) {
          console.info(
            `[assistant/chat] context truncated: ${ctx.itemsTruncated} items dropped, ` +
              `${ctx.itemsIncluded} included, ~${ctx.estimatedTokens} tokens used`,
          );
        }
      } catch (logErr) {
        console.error("[assistant/chat] failed to log ai_run:", logErr);
      }

      try {
        controller.close();
      } catch {
        // Already closed by client cancel — nothing to do.
      }
    },

    cancel() {
      // Client disconnected (Stop button, nav away, etc). Flip the flag so
      // the loop bails on its next check, and abort the in-flight Anthropic
      // stream so we stop burning tokens.
      aborted = true;
      try {
        currentStreamRef?.abort();
      } catch {
        // SDK may be past the abortable window — nothing else we can do.
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Accel-Buffering": "no",
      "X-Context-Items": String(ctx.itemsIncluded),
      "X-Context-Truncated": String(ctx.itemsTruncated),
      "X-Context-Tokens": String(ctx.estimatedTokens),
      "X-Scope": ctx.scopeLabel,
    },
  });
}
