// Which model answers a chat message.
//
//   qa     — a plain question about the graph ("what should I focus on?",
//            "why is X ranked so high?"): Gemini Flash-Lite with no tools
//            (gemini-chat.ts), ~4× cheaper than Haiku per answer. It can still
//            hand the turn to Claude if it turns out to need an action or data
//            the snapshot doesn't have, so a miss here costs one tiny call, not
//            a wrong answer.
//   haiku  — everything else: it answers, acts through its tools, and hands
//            specialist work to one focused call: a restructure or a
//            multi-item capture to the graph builder (build_graph,
//            tools/build.ts), steps it should write to the step-writer
//            (write_steps, tools/steps.ts). Sonnet runs there, on a narrow
//            prompt, instead of carrying the whole chat turn.
//
// Until 2026-09-30 every structural edit ran its whole turn on Sonnet
// (looksLikeStructuralEdit): 8 of 19 chat calls and 71% of chat spend on the
// price-test days, $0.038 + $0.014 per edit against $0.013 for the builder.
// Until 2026-10-03 a generated breakdown did too (usesSonnet), ~$0.075 a turn
// and its follow-ups stuck on Sonnet (fix list #7).
//
// The qa test is deliberately conservative: any hint of an action, a
// commitment, completed work or data outside the snapshot keeps the turn on
// Claude, which has the tools.

import { looksLikeBrainDump, looksLikeBreakdownAsk, looksLikeRestructure } from "@/lib/graph/dump-heuristic";
import type { AssistantMode } from "@/types/ai";
import type { HistoryTurn } from "./chat-memory";
import { statedIntents } from "./tools/intent-coverage";

export type ChatRoute = "qa" | "haiku";

// Changes, captures, completions, commitments — anything a tool would act on.
// Outcome words ("the exam is over", "took it", "got pushed", "pass/fail") too:
// they change the ranking, and Gemini Flash-Lite answered them instead of
// handing off even when told to (e2e + check 2026-09-29) — so the rule is here.
// "Will you remember I want 4h a day coding?" / "forget the coding thing" /
// "from now on…" save a standing preference (set_preferences, #28).
const ACTION =
  /\b(add|adding|create|make|put|move|schedul\w*|resched\w*|re-?plan\w*|plan|time-?block|block|mark|complet\w*|finish\w*|done|did|do it|go ahead|archiv\w*|delet\w*|remov\w*|renam\w*|merg\w*|split|connect|link|track|captur\w*|log|set|chang\w*|updat\w*|bump|cancel\w*|drop|remind\w*|start(ed|ing)?|sent|ship(ped)?|booked|submit\w*|enrol\w*|signed up|break(\s+\w+){0,3}\s+down|breakdown|roadmap|subtasks?|need to|have to|gotta|going to|gonna|want to|wanna|i'll|i will|recompute|recalculate|re-?rank|refresh|over|took|taken|passed|failed|missed|skipped|postponed|pushed|moved|delayed|rescheduled|redo|running late|behind|off schedule|off track|waiting|pass\/fail|got (in|into|my|the|accepted|rejected|admitted)|accepted|rejected|admitted|results?|remember|forget|from now on)\b/i;

// Data the snapshot doesn't carry: the calendar, recent activity, and the
// graph's structure (it lists nodes, not their children or connections).
// "today" / "this week" alone are not on this list (fix list #19): "what
// should I focus on today?" is the plain paralysis question, answered from the
// snapshot's ranking and due dates; Gemini hands off when it needs the
// calendar ("what's on my calendar today?" stays here through "calendar").
const NEEDS_LOOKUP =
  /\b(calendar|schedule|agenda|planned|yesterday|last week|recent(ly)?|history|when did|did i|have i|what have i|streak|what'?s (in|under|inside)|children|subtasks?|under it|connected|connection|linked|related|relate|depends?|blocking|blocked)\b/i;

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
  // A question next to a statement ("the CV can wait, should I focus on stats
  // or the internship?") carries a change Gemini has no tool for (#22).
  if (statedIntents(text).length > 0) return false;
  // Answering the assistant's own question ("under A or B?") usually means acting on it.
  const last = history[history.length - 1];
  if (last?.role === "assistant" && last.body.trim().endsWith("?")) return false;
  return true;
}

// Not a route — a line in the (uncached) message block that points Haiku at
// the specialist for the message's kind of work: write_steps for steps it
// should come up with, build_graph for a restructure or a dump. The model
// still decides: venting or a long question needs no tool at all.
export function buildHint(message: string): string {
  // "plan the rest of my day" in explain mode got questions back, not a plan (assistant-v29/v30).
  if (statedIntents(message).some((s) => s.kind === "plan")) {
    return "[Hint: they asked for a plan → call plan_day now, no questions first; at most one line after the card.]";
  }
  if (looksLikeBreakdownAsk(message)) {
    return "[Hint: steps the user didn't list (a breakdown, a roadmap) → write_steps writes them for the node, as a card.]";
  }
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
  if (
    params.qaEnabled &&
    params.mode !== "transform" &&
    looksLikePlainQuestion(params.message, params.history)
  ) {
    return "qa";
  }
  return "haiku";
}
