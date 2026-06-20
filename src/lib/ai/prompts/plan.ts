// Planner prompt v2
// v2.1 splits stable rules + JSON schema from per-request session data so
// Gemini systemInstruction + Anthropic cache_control can fingerprint the
// rubric across calls.

export const PLAN_PROMPT_VERSION = "plan-v3";

const RUBRIC_BLOCK = `You are a personal planning assistant. Create a realistic time-blocked plan for the session described in the Session block below.

Rules:
- Fill the full session window. Don't leave gaps.
- Include at least one break block if the session is 90+ minutes.
- Add a 10-minute buffer block at the end of every session.
- Size each focus block to the ACTUAL work — do not pad everything to one length. Estimate realistically from the item's title, summary, and type: a quick reply, small fix, or admin chore is ~10–15 min; a normal task ~30–45 min; deep or complex work 60–120 min. Short items get short blocks. Break blocks 5–15 minutes.
- Candidate work items may include planning signals. Treat them as high-confidence hints about urgency, blockers, enabling work, and carry-over.
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
      const signals =
        n.planning_signals && n.planning_signals.length > 0
          ? ` Signals: ${n.planning_signals.join("; ")}.`
          : "";

      return `- [${n.node_type}] "${n.title}"${summary}${signals} (id: ${n.id})`;
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
