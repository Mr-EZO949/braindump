// Planner prompt v2
// v2.1 splits stable rules + JSON schema from per-request session data so
// Gemini systemInstruction + Anthropic cache_control can fingerprint the
// rubric across calls.

export const PLAN_PROMPT_VERSION = "plan-v8";

const RUBRIC_BLOCK = `You are a personal planning assistant. Create a realistic time-blocked plan for the session described in the Session block below.

Rules:
- Fill the full session window — or, when the Session block lists busy time, exactly its free time. Don't leave gaps.
- Include at least one break block if the session is 90+ minutes.
- A long session (5+ hours, up to a whole waking day): a 10–15 minute break after about every 2 hours of focus, and lunch / dinner as 30–60 minute break blocks at normal meal times when the session covers them (the Session block gives its clock times). Put the hardest deep work early and lighter admin / habit items later in the day.
- Never invent work, repeat an item, or add a block for busy time to fill the window. If the work items run out before the window ends, end with ONE break block titled "Free time" for the rest.
- Add a 10-minute buffer block at the end of every session.
- Size each focus block to the ACTUAL work — do not pad everything to one length, and do NOT under-size. Estimate from the item's title, summary, and type: a quick reply/small fix/admin chore ~10–15 min; a normal task ~30–45 min; focused learning, coding, problem-solving, writing, or studying is deep work ~60–120 min. If a title names a countable amount ("2 problems", "3 chapters", "5 emails"), size for that whole amount, not one unit (e.g. "2 medium LeetCode problems" is ~60–90 min, not 40). Break blocks 5–15 minutes.
- Prefer FEWER items done properly over many crammed in. In a short window (≤90 min) schedule only the 1–2 most important items at realistic durations — do NOT cram five items into tiny slices. It's fine to leave a big item for a future, longer session rather than hand it an unrealistic stub now.
- TIME BLOCKS: an item listed under "Time blocks" is a bigger thing (a class, goal, project or big task) that can get ONE block of time on itself: node_id = its id, title = its name or "<name> — <what kind of work>" (e.g. "Statistics — study", "Italian Crash Course"). Give one when the user asked for it, or when it matters now and the session has room for real time on it (a whole day usually holds 1–3). A time block never pushes out a work item with a deadline signal ("Due in …", "due …"): fit those first, then time blocks in the time left. Size it as a real session, 45–180 min; when a long session has hours left after the other items, give time blocks real length (90–180 min) before any "Free time". The block covers every step inside it: never also give one of its steps (the ones it lists as "start with", or any other part of it) a block of its own in the same plan.
- USER REQUESTS: every line under "The user asked for" MUST be in the plan, at about the length given. A line matched to an item uses that item's node_id. An unmatched line uses the item it clearly means ("math" → a math class), else node_id null with their words as the title. A request over 2 hours may be two blocks of the same item with a break between — the only time an item may repeat.
- Never let the plan exceed the session window. No block may run past the total minutes, and leave room for the 10-minute end buffer (so in a 60-minute window usable focus time is ~50 min). If a substantial item won't fully fit, schedule a realistic starter block (≥45 min) and say in the reason that it's a start — don't shrink it to an absurd stub.
- Candidate work items may include planning signals. Treat them as high-confidence hints about urgency, blockers, enabling work, and carry-over (dated work left undone).
- BLOCKED work: if an item's summary or signals say it is waiting on someone else, a pending decision, or a dependency that isn't ready yet (e.g. "advisor says the analysis isn't ready", "waiting on design sign-off"), do NOT schedule the blocked work itself — you'd be booking time the user can't actually use. Instead schedule the small action that UNBLOCKS it (e.g. "Message advisor to confirm the analysis is ready", ~10–15 min), or leave the blocked item out and note why in another block's reason. Never hand a deep-work block to something that cannot proceed yet.
- FIXED commitments: if an item has a fixed time or day named in its title/summary/signals (a meeting, class, appointment, shift, or kid's activity), schedule it AT that time — do not move a fixed commitment to the front of the session, and build the rest of the plan around it.
- Only include node_id when the block directly corresponds to a work item in the Session block.
- If the workspace context names manual planner items, you may schedule them with node_id = null. Keep the block title close to the named manual item.
- Admin blocks (emails, comms) and break/buffer blocks have no node_id.
- start_offset is minutes from session start (0-based).
- reason: ONE short clause (≤12 words) on why this item is scheduled now (priority, dependency, energy level).
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

// The plan's JSON shape as a schema — sent as an enforced output format (Haiku
// and Sonnet), so the plan can't come back malformed (the reason Haiku was
// originally dropped from planning).
export const PLAN_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["blocks", "prompt_version"],
  properties: {
    prompt_version: { type: "string" },
    blocks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["node_id", "title", "start_offset", "duration_minutes", "reason", "block_type"],
        properties: {
          node_id: { type: ["string", "null"] },
          title: { type: "string" },
          start_offset: { type: "integer" },
          duration_minutes: { type: "integer" },
          reason: { type: "string" },
          block_type: { type: "string", enum: ["focus", "admin", "break", "buffer"] },
        },
      },
    },
  },
} as const;

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
  /** Fixed commitments inside the session (sessionBusyNote in lib/planner/commitments). */
  busy_lines?: string[];
  /** Bigger things that can get a block of time on themselves. */
  time_blocks?: Array<{
    id: string;
    title: string;
    node_type: string;
    open_steps: number;
    start_with: string[];
    planning_signals?: string[];
  }>;
  /** What the user asked the plan to include. */
  requests?: Array<{
    text: string;
    minutes: number | null;
    node_id: string | null;
    title: string | null;
    node_type: string | null;
  }>;
  /** The session's clock span, "08:00–23:00", when the caller knows its start. */
  session_span?: string | null;
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

  const busyBlock = params.busy_lines && params.busy_lines.length > 0 ? `${params.busy_lines.join("\n")}\n` : "";

  return `Session:
Planning window: ${params.planning_window} (${params.total_minutes} minutes ${busyBlock ? "free" : "total"}${params.session_span ? `, session ${params.session_span}` : ""})
${busyBlock}${contextBlock}
Available work items:
${nodeList}${timeBlockSection(params.time_blocks)}${requestSection(params.requests)}`;
}

// Empty when there's nothing to list, so a plan without bigger things or
// requests reads exactly as before.
function timeBlockSection(blocks: PlanPromptParams["time_blocks"]): string {
  if (!blocks || blocks.length === 0) return "";
  const lines = blocks.map((b) => {
    const steps =
      b.open_steps === 0
        ? "no open steps"
        : `${b.open_steps} open step${b.open_steps === 1 ? "" : "s"}` +
          (b.start_with.length > 0
            ? `; start with ${b.start_with.map((t) => `"${t}"`).join(", then ")}`
            : "");
    const signals =
      b.planning_signals && b.planning_signals.length > 0 ? ` Signals: ${b.planning_signals.join("; ")}.` : "";
    return `- [${b.node_type}] "${b.title}" — ${steps}.${signals} (id: ${b.id})`;
  });
  return `\n\nTime blocks (bigger things — one block of time on the item itself, covering the steps inside it):\n${lines.join("\n")}`;
}

function requestSection(requests: PlanPromptParams["requests"]): string {
  if (!requests || requests.length === 0) return "";
  const lines = requests.map((r) => {
    const length = r.minutes ? `${r.minutes} min` : "a sensible length";
    return r.node_id
      ? `- "${r.text}" → ${length} on [${r.node_type}] "${r.title}" (id: ${r.node_id})`
      : `- "${r.text}" → ${length}; no item matched by name`;
  });
  return `\n\nThe user asked for (each MUST be in the plan):\n${lines.join("\n")}`;
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
