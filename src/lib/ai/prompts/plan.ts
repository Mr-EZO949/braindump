// Planner prompt v1
// Phase 9 will tune this against planning outcomes.

export const PLAN_PROMPT_VERSION = "plan-v2";

export function buildPlanPrompt(params: {
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
}): string {
  const contextBlock = params.workspace_context
    ? `\nWorkspace context:\n${params.workspace_context}\n`
    : "";

  const nodeList = params.candidate_nodes
    .map(
      (n) => {
        const summary = n.summary ? `: ${n.summary}` : "";
        const signals =
          n.planning_signals && n.planning_signals.length > 0
            ? ` Signals: ${n.planning_signals.join("; ")}.`
            : "";

        return `- [${n.node_type}] "${n.title}"${summary}${signals} (id: ${n.id})`;
      }
    )
    .join("\n");

  return `You are a personal planning assistant. Create a realistic time-blocked plan for the session below.
${contextBlock}
Planning window: ${params.planning_window} (${params.total_minutes} minutes total)

Available work items:
${nodeList}

Rules:
- Fill the full ${params.total_minutes} minutes. Don't leave gaps.
- Include at least one break block if the session is 90+ minutes.
- Add a 10-minute buffer block at the end of every session.
- Focus blocks should be 25–50 minutes. Break blocks 5–15 minutes.
- Candidate work items may include planning signals. Treat them as high-confidence hints about urgency, blockers, enabling work, and carry-over.
- Only include node_id when the block directly corresponds to a work item above.
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
}
