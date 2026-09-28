// Which model answers a chat message.
//
//   qa     — a plain question about the graph ("what should I focus on?",
//            "why is X ranked so high?"): Gemini Flash-Lite with no tools
//            (gemini-chat.ts), ~4× cheaper than Haiku per answer. It can still
//            hand the turn to Claude if it turns out to need an action or data
//            the snapshot doesn't have, so a miss here costs one tiny call, not
//            a wrong answer.
//   haiku  — everything that might change the graph or needs a lookup tool.
//   sonnet — structural edits and full planning (looksLikeStructuralEdit).
//
// The qa test is deliberately conservative: any hint of an action, a
// commitment, completed work or data outside the snapshot keeps the turn on
// Claude, which has the tools.

import { looksLikeStructuralEdit } from "@/lib/graph/dump-heuristic";
import type { AssistantMode } from "@/types/ai";
import type { HistoryTurn } from "./chat-memory";

export type ChatRoute = "qa" | "haiku" | "sonnet";

// Changes, captures, completions, commitments — anything a tool would act on.
const ACTION =
  /\b(add|adding|create|make|put|move|schedul\w*|resched\w*|re-?plan\w*|plan|time-?block|block|mark|complet\w*|finish\w*|done|did|do it|go ahead|archiv\w*|delet\w*|remov\w*|renam\w*|merg\w*|split|connect|link|track|captur\w*|log|set|chang\w*|updat\w*|bump|cancel\w*|drop|remind\w*|start(ed|ing)?|sent|ship(ped)?|booked|submit\w*|enrol\w*|signed up|break(\s+\w+){0,3}\s+down|breakdown|roadmap|subtasks?|need to|have to|gotta|going to|gonna|want to|wanna|i'll|i will|recompute|recalculate|re-?rank|refresh)\b/i;

// Data the snapshot doesn't carry: the calendar, recent activity, and the
// graph's structure (it lists nodes, not their children or connections).
const NEEDS_LOOKUP =
  /\b(calendar|schedule|today|tonight|tomorrow|yesterday|this week|last week|next week|this month|recent(ly)?|history|when did|did i|have i|what have i|streak|what'?s (in|under|inside)|children|subtasks?|under it|connected|connection|linked|related|relate|depends?|blocking|blocked)\b/i;

// "How do I learn X?" invites a roadmap the full assistant would propose as nodes.
const HOW_TO = /\bhow (do|should|can|would|could) i\b/i;

const QUESTION_START =
  /^\s*(what|what's|whats|why|which|who|where|is|are|am|does|do|should|could|would|can|explain|tell me|help me (understand|think|decide|figure))\b/i;

// Long messages are usually dumps or venting with commitments buried in them.
const QA_MAX_CHARS = 400;

export function looksLikePlainQuestion(message: string, history: HistoryTurn[] = []): boolean {
  const text = message.trim();
  if (!text || text.length > QA_MAX_CHARS) return false;
  if (!text.includes("?") && !QUESTION_START.test(text)) return false;
  if (ACTION.test(text) || NEEDS_LOOKUP.test(text) || HOW_TO.test(text)) return false;
  // Answering the assistant's own question ("under A or B?") usually means acting on it.
  const last = history[history.length - 1];
  if (last?.role === "assistant" && last.body.trim().endsWith("?")) return false;
  return true;
}

export function routeChatMessage(params: {
  message: string;
  history: HistoryTurn[];
  mode: AssistantMode;
  qaEnabled: boolean;
}): ChatRoute {
  if (looksLikeStructuralEdit(params.message)) return "sonnet";
  if (
    params.qaEnabled &&
    params.mode !== "transform" &&
    looksLikePlainQuestion(params.message, params.history)
  ) {
    return "qa";
  }
  return "haiku";
}
