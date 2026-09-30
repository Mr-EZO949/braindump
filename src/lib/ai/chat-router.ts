// Which model answers a chat message.
//
//   qa     — a plain question about the graph ("what should I focus on?",
//            "why is X ranked so high?"): Gemini Flash-Lite with no tools
//            (gemini-chat.ts), ~4× cheaper than Haiku per answer. It can still
//            hand the turn to Claude if it turns out to need an action or data
//            the snapshot doesn't have, so a miss here costs one tiny call, not
//            a wrong answer.
//   haiku  — everything else: it answers, acts through its tools, and hands
//            structural work — a restructure, a multi-item capture — to the
//            graph builder through build_graph (tools/build.ts), where Sonnet
//            runs on a narrow prompt instead of carrying the whole chat turn.
//   sonnet — only a GENERATED breakdown ("break X down", "a roadmap for Y")
//            and its follow-ups: the steps are written by the chat model
//            itself, so they are only as good as it is.
//
// Until 2026-09-30 every structural edit ran its whole turn on Sonnet
// (looksLikeStructuralEdit): 8 of 19 chat calls and 71% of chat spend on the
// price-test days, $0.038 + $0.014 per edit against $0.013 for the builder.
//
// The qa test is deliberately conservative: any hint of an action, a
// commitment, completed work or data outside the snapshot keeps the turn on
// Claude, which has the tools.

import { looksLikeBrainDump, looksLikeBreakdownAsk, looksLikeRestructure } from "@/lib/graph/dump-heuristic";
import type { AssistantMode } from "@/types/ai";
import type { HistoryTurn } from "./chat-memory";

export type ChatRoute = "qa" | "haiku" | "sonnet";

// Changes, captures, completions, commitments — anything a tool would act on.
// Outcome words ("the exam is over", "took it", "got pushed", "pass/fail") too:
// they change the ranking, and Gemini Flash-Lite answered them instead of
// handing off even when told to (e2e + check 2026-09-29) — so the rule is here.
const ACTION =
  /\b(add|adding|create|make|put|move|schedul\w*|resched\w*|re-?plan\w*|plan|time-?block|block|mark|complet\w*|finish\w*|done|did|do it|go ahead|archiv\w*|delet\w*|remov\w*|renam\w*|merg\w*|split|connect|link|track|captur\w*|log|set|chang\w*|updat\w*|bump|cancel\w*|drop|remind\w*|start(ed|ing)?|sent|ship(ped)?|booked|submit\w*|enrol\w*|signed up|break(\s+\w+){0,3}\s+down|breakdown|roadmap|subtasks?|need to|have to|gotta|going to|gonna|want to|wanna|i'll|i will|recompute|recalculate|re-?rank|refresh|over|took|taken|passed|failed|missed|skipped|postponed|pushed|moved|delayed|rescheduled|waiting|pass\/fail|got (in|into|my|the|accepted|rejected|admitted)|accepted|rejected|admitted|results?)\b/i;

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

// A breakdown rarely fits in one message. "yeah", "do it", "make it deeper"
// carry no breakdown word, so if one of the last few turns asked for (or
// offered) one, the follow-up stays on Sonnet. Long turns are skipped: a full
// brain dump can trip the heuristic on almost any wording and would pin the
// whole thread to Sonnet.
const BREAKDOWN_THREAD_TURNS = 4;
const BREAKDOWN_TURN_MAX_CHARS = 600;

export function inBreakdownThread(history: HistoryTurn[]): boolean {
  return history
    .slice(-BREAKDOWN_THREAD_TURNS)
    .some(
      (turn) => turn.body.length <= BREAKDOWN_TURN_MAX_CHARS && looksLikeBreakdownAsk(turn.body),
    );
}

// Haiku, or Sonnet for a generated breakdown. The resume route asks again
// with the original question so an Accept continues on the same model.
export function usesSonnet(message: string, history: HistoryTurn[] = []): boolean {
  return looksLikeBreakdownAsk(message) || inBreakdownThread(history);
}

// Not a route — a line in the (uncached) message block that points Haiku at
// build_graph when the message reads like the builder's kind of work. The
// model still decides: venting or a long question needs no tool at all.
export function buildHint(message: string): string {
  if (looksLikeBreakdownAsk(message)) return "";
  return looksLikeRestructure(message) || looksLikeBrainDump(message)
    ? "[Hint: if this message adds several things or reorganizes existing nodes (not just venting or a question), build_graph handles all of it in one card.]"
    : "";
}

export function routeChatMessage(params: {
  message: string;
  history: HistoryTurn[];
  mode: AssistantMode;
  qaEnabled: boolean;
}): ChatRoute {
  if (usesSonnet(params.message, params.history)) return "sonnet";
  if (
    params.qaEnabled &&
    params.mode !== "transform" &&
    looksLikePlainQuestion(params.message, params.history)
  ) {
    return "qa";
  }
  return "haiku";
}
