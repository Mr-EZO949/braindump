// Planner prompt v2
// v2.1 splits stable rules + JSON schema from per-request session data so
// Gemini systemInstruction + Anthropic cache_control can fingerprint the
// rubric across calls.

export const PLAN_PROMPT_VERSION = "plan-v5";

const RUBRIC_BLOCK = `You are a personal planning assistant. Create a realistic time-blocked plan for the session described in the Session block below.

Rules:
- Fill the full session window. Don't leave gaps.
- Include at least one break block if the session is 90+ minutes.
- Add a 10-minute buffer block at the end of every session.
- Size each focus block to the ACTUAL work — do not pad everything to one length, and do NOT under-size. Estimate from the item's title, summary, and type: a quick reply/small fix/admin chore ~10–15 min; a normal task ~30–45 min; focused learning, coding, problem-solving, writing, or studying is deep work ~60–120 min. If a title names a countable amount ("2 problems", "3 chapters", "5 emails"), size for that whole amount, not one unit (e.g. "2 medium LeetCode problems" is ~60–90 min, not 40). Break blocks 5–15 minutes.
- Prefer FEWER items done properly over many crammed in. In a short window (≤90 min) schedule only the 1–2 most important items at realistic durations — do NOT cram five items into tiny slices. It's fine to leave a big item for a future, longer session rather than hand it an unrealistic stub now.
- Never let the plan exceed the session window. No block may run past the total minutes, and leave room for the 10-minute end buffer (so in a 60-minute window usable focus time is ~50 min). If a substantial item won't fully fit, schedule a realistic starter block (≥45 min) and say in the reason that it's a start — don't shrink it to an absurd stub.
- Candidate work items may include planning signals. Treat them as high-confidence hints about urgency, blockers, enabling work, and carry-over.
- BLOCKED work: if an item's summary or signals say it is waiting on someone else, a pending decision, or a dependency that isn't ready yet (e.g. "advisor says the analysis isn't ready", "waiting on design sign-off"), do NOT schedule the blocked work itself — you'd be booking time the user can't actually use. Instead schedule the small action that UNBLOCKS it (e.g. "Message advisor to confirm the analysis is ready", ~10–15 min), or leave the blocked item out and note why in another block's reason. Never hand a deep-work block to something that cannot proceed yet.
- FIXED commitments: if an item has a fixed time or day named in its title/summary/signals (a meeting, class, appointment, shift, or kid's activity), schedule it AT that time — do not move a fixed commitment to the front of the session, and build the rest of the plan around it.
- Only include node_id when the block directly corresponds to a work item in the Session block.
- If the workspace context names manual planner items, you may schedule them with node_id = null. Keep the block title close to the named manual item.
- Admin blocks (emails, comms) and break/buffer blocks have no node_id.
- start_offset is minutes from session start (0-based).
- reason must explain why this item is scheduled now (priority, dependency, energy level).
- Block types: focus | admin | break | buffer

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "blocks": [
    {
      "node_id": "uuid string or null",
      "title": "string",
      "start_offset": 0,
      "duration_minutes": 25,
      "reason": "string",
      "block_type": "focus | admin | break | buffer"
    }
  ],
  "prompt_version": "${PLAN_PROMPT_VERSION}"
}`;

export interface PlanPromptParams {
  planning_window: string;
  total_minutes: number;
  candidate_nodes: Array<{
    id: string;
    title: string;
    summary: string | null;
    body?: string | null;
    node_type: string;
    planning_signals?: string[];
  }>;
  workspace_context?: string;
}

function buildVariableBlock(params: PlanPromptParams): string {
  const contextBlock = params.workspace_context
    ? `\nWorkspace context:\n${params.workspace_context}\n`
    : "";

  const nodeList = params.candidate_nodes
    .map((n) => {
      const summary = n.summary ? `: ${n.summary}` : "";
      const context = n.body ? ` [context: ${n.body}]` : "";
      const signals =
        n.planning_signals && n.planning_signals.length > 0
          ? ` Signals: ${n.planning_signals.join("; ")}.`
          : "";

      return `- [${n.node_type}] "${n.title}"${summary}${context}${signals} (id: ${n.id})`;
    })
    .join("\n");

  return `Session:
Planning window: ${params.planning_window} (${params.total_minutes} minutes total)
${contextBlock}
Available work items:
${nodeList}`;
}

export function buildPlanPromptParts(params: PlanPromptParams): {
  rubricBlock: string;
  variableBlock: string;
} {
  return { rubricBlock: RUBRIC_BLOCK, variableBlock: buildVariableBlock(params) };
}

export function buildPlanPrompt(params: PlanPromptParams): string {
  return `${RUBRIC_BLOCK}\n\n${buildVariableBlock(params)}`;
}
