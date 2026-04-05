// POST /api/assistant/chat — Phase 8.4
// Streaming chat route. Assembles graph context (token-budgeted), calls Claude,
// streams tokens back as plain text, and logs an ai_run record.

import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { buildAssistantContext } from "@/lib/ai/context";
import {
  buildAssistantSystemPrompt,
  buildAssistantUserPrompt,
  ASSISTANT_PROMPT_VERSION,
} from "@/lib/ai/prompts/assistant";
import { AI_MODELS, AI_TEMPERATURE, AI_COST_PER_1M_TOKENS, AI_RATE_LIMITS } from "@/lib/ai/config";
import { checkAIRunRateLimit, rateLimitResponse } from "@/lib/ai/rate-limit";
import { hashText, logFailedAIRun, normalizeAIError } from "@/lib/ai/errors";
import { persistAIRun } from "@/lib/ai/telemetry";
import type { AssistantMode } from "@/types/ai";

const VALID_MODES: AssistantMode[] = ["explain", "plan", "transform"];

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
  } = body as {
    message: string;
    workspace_id: string;
    selected_node_id?: string | null;
    mode?: string;
  };

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

  // Rate limit: max N chat messages per hour
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
  // Assemble context (Phase 8.2 + 8.3)
  // ---------------------------------------------------------------------------
  const ctx = await buildAssistantContext({
    workspaceId: workspace_id,
    userId: user.id,
    selectedNodeId: selected_node_id ?? null,
    supabase,
    message: message.trim(),
  });

  const systemPrompt = buildAssistantSystemPrompt(resolvedMode);
  const userPrompt = buildAssistantUserPrompt({
    message: message.trim(),
    context: ctx.contextString,
    scope: ctx.scopeLabel,
  });

  // ---------------------------------------------------------------------------
  // Stream from Claude (Phase 8.4)
  // ---------------------------------------------------------------------------
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  if (!claudeKey) {
    return new Response("ANTHROPIC_API_KEY is not configured", { status: 500 });
  }

  const client = new Anthropic({ apiKey: claudeKey });
  const start = Date.now();

  let claudeStream: ReturnType<typeof client.messages.stream>;
  try {
    claudeStream = client.messages.stream({
      model: AI_MODELS.CLAUDE_SONNET,
      max_tokens: 1024,
      temperature: AI_TEMPERATURE.ASSISTANT,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
  } catch (err) {
    const normalized = normalizeAIError(err, "Assistant failed to start");
    await logFailedAIRun({
      supabase,
      userId: user.id,
      workspaceId: workspace_id,
      runType: "assistant",
      provider: "claude",
      modelName: AI_MODELS.CLAUDE_SONNET,
      promptVersion: `${ASSISTANT_PROMPT_VERSION}:${resolvedMode}`,
      inputHash: hashText(userPrompt),
      latencyMs: Date.now() - start,
      error: normalized.message,
    });
    return new Response(normalized.userMessage, { status: 502 });
  }

  // ---------------------------------------------------------------------------
  // Build streaming response — text/plain token feed
  // ---------------------------------------------------------------------------
  const readable = new ReadableStream({
    async start(controller) {
      let inputTokens = 0;
      let outputTokens = 0;
      let fullText = "";
      let streamError: ReturnType<typeof normalizeAIError> | null = null;

      try {
        for await (const event of claudeStream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            const chunk = event.delta.text;
            fullText += chunk;
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          if (event.type === "message_start" && event.message.usage) {
            inputTokens = event.message.usage.input_tokens;
          }
          if (event.type === "message_delta" && event.usage) {
            outputTokens = event.usage.output_tokens;
          }
        }
      } catch (err) {
        streamError = normalizeAIError(err, "Assistant response was interrupted");
        controller.enqueue(
          new TextEncoder().encode(`\n\n[${streamError.userMessage} Retry the request.]`),
        );
        console.error("[assistant/chat] stream error:", streamError.message);
      }

      // -----------------------------------------------------------------------
      // Phase 8.5 — log ai_run with token counts + context stats (best-effort)
      // -----------------------------------------------------------------------
      try {
        const latencyMs = Date.now() - start;
        const estimatedCost =
          (inputTokens / 1_000_000) * AI_COST_PER_1M_TOKENS.CLAUDE_SONNET_INPUT +
          (outputTokens / 1_000_000) * AI_COST_PER_1M_TOKENS.CLAUDE_SONNET_OUTPUT;

        await persistAIRun({
          supabase,
          userId: user.id,
          workspaceId: workspace_id,
          source: "assistant-chat",
          run: {
            run_type: "assistant",
            provider: "claude",
            model_name: AI_MODELS.CLAUDE_SONNET,
            prompt_version: `${ASSISTANT_PROMPT_VERSION}:${resolvedMode}`,
            input_hash: null,
            output_hash: null,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            latency_ms: latencyMs,
            estimated_cost: estimatedCost,
            status: streamError ? "failed" : "success",
            error_text: streamError?.message ?? null,
          },
        });

        // Phase 8.5 — log context stats if answer is too generic (no node title mentioned)
        if (ctx.itemsTruncated > 0) {
          console.info(
            `[assistant/chat] context truncated: ${ctx.itemsTruncated} items dropped, ` +
              `${ctx.itemsIncluded} included, ~${ctx.estimatedTokens} tokens used`,
          );
        }

        void fullText; // referenced to avoid lint unused warning
      } catch (logErr) {
        console.error("[assistant/chat] failed to log ai_run:", logErr);
      }

      controller.close();
    },

    cancel() {
      claudeStream.abort();
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Accel-Buffering": "no",
      // Phase 8.5 — expose context metadata as headers for client-side debug
      "X-Context-Items": String(ctx.itemsIncluded),
      "X-Context-Truncated": String(ctx.itemsTruncated),
      "X-Context-Tokens": String(ctx.estimatedTokens),
      "X-Scope": ctx.scopeLabel,
    },
  });
}
