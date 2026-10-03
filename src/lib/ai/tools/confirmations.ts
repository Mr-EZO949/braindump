// The short reply shown after the user Accepts a simple, single action — used
// INSTEAD of another model call. For a one-step edit ("mark the gym done",
// "move the call to Friday") the follow-up model call only ever said "Done",
// yet re-sent the whole ~10K-token prompt and added a couple of seconds.
//
// Only used when nothing else is queued and the action succeeded; errors,
// multi-step and structural turns still go back to the model (resume route).

type ToolResult = Record<string, unknown>;

function titlesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === "string" ? v : typeof (v as { title?: unknown })?.title === "string" ? (v as { title: string }).title : null))
    .filter((t): t is string => !!t);
}

function parseResult(content: string): ToolResult {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object") return parsed as ToolResult;
  } catch {
    // Non-JSON result — treated as an opaque success.
  }
  return {};
}

// Handlers report failure as { accepted: false, error } (not always is_error),
// and a failure is exactly when the model should explain and recover.
export function actionSucceeded(content: string, isError: boolean): boolean {
  if (isError) return false;
  const result = parseResult(content);
  return result.accepted !== false && !result.error;
}

// Did the user ask for more than one thing ("add X and schedule it", "then…")?
// Then the accepted action may be step one of several — the model has to see
// its result to do the next step, so the follow-up call must run.
export function looksMultiStep(userMessage: string): boolean {
  const t = userMessage.toLowerCase();
  return /\b(then|also|after that|afterwards|as well)\b/.test(t) ||
    /\band (then |also )?(schedule|add|create|mark|move|set|put|link|connect|rename|archive|delete|remove|plan|make|complete|reschedule)\b/.test(t);
}

// After a change set that applied in full: does the message also ask for a
// step the change call can't carry — scheduling, a plan, a reminder — which
// needs its result (the new node's id)? "finally updated my cv, and add a task
// to email the TA" is ONE change call; the follow-up round looksMultiStep asked
// for only wrote a line after the card and re-sent the prompt (eval,
// assistant-v27: 29K input tokens instead of 15K).
export function needsStepAfterChange(userMessage: string): boolean {
  return /\b(schedul\w*|reschedul\w*|calendar|plan|time-?block\w*|remind\w*)\b/i.test(userMessage);
}

// Did the user ask something the reply before the card hasn't answered yet?
// The prompt says to answer first and put the card last (assistant-v25); when
// the model instead only announced the action ("Mark X done first.") and meant
// to answer after the Accept, a one-line "Done ✓" would drop the answer
// (owner, 2026-09-30: "fixed my sleep schedule — money or exams?").
export function answerStillOwed(userMessage: string, replyBeforeCard: string): boolean {
  const asked =
    userMessage.includes("?") ||
    /\b(should i|what should|what do you think|how (do|can|should) i|which (one|is)|idk (what|if|how|which)|any (tips|advice|ideas))\b/i.test(
      userMessage,
    );
  return asked && replyBeforeCard.trim().length < 140;
}

export function confirmationFor(toolName: string, content: string): string {
  const result = parseResult(content);
  if (typeof result.message === "string" && result.message.trim()) return result.message.trim();

  switch (toolName) {
    case "mark_task_done": {
      if (result.habit_logged) return "Logged for today ✓";
      if (result.already_completed) return "That was already done ✓";
      const unblocked = titlesOf(result.newly_available);
      return unblocked.length > 0
        ? `Done ✓ That unblocks: ${unblocked.slice(0, 3).join(", ")}.`
        : "Done ✓";
    }
    case "add_task_to_calendar":
      return "Added to your calendar ✓";
    case "reschedule_task":
      return "Rescheduled ✓";
    default:
      return "Done ✓";
  }
}
