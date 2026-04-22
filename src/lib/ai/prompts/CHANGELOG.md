# Prompt Version Changelog

All prompt changes are tracked here. Each entry records the version, what changed, and why.
Run `POST /api/eval/run` before and after changes to verify regression.

---

## Extraction (`extract.ts`)

### extract-v7 (current)
- Added workspace context block (`workspace_context` param)
- Added existing anchor attachment rule with `existing_parent_node_id`
- Enforced mutual exclusivity: cannot set both `primary_parent_local_ref` and `existing_parent_node_id`
- Added `soft_links` field for same-dump cross-links
- Why: brain dumps need to connect to existing workspace structure, not just internal refs

### extract-v6
- Added semantic clustering rule: auto-create domain clusters when 3+ nodes share a domain
- Why: solopreneur and student brain dumps were flat — all tasks at root level with no structure

### extract-v5
- Added named context anchor rule (course names, projects, named datasets)
- Added implied anchor rule ("stats homework ch7" implies "Statistics Course")
- Added explicit grouping rule (user-written headings become nodes)
- Why: graphs were too flat; needed hierarchical structure from natural language cues

### extract-v4
- Tightened node type classification rules
- Reduced over-extraction of journal-type nodes

### extract-v3
- Added `source_span` field for traceability
- Added `depends_on_local_refs` for same-dump dependencies

### extract-v2
- Structured JSON output with `local_ref` system
- Added confidence scoring guidelines

### extract-v1
- Initial extraction prompt with basic node type classification

---

## Edge inference (`infer-edge.ts`)

### infer-edge-v3 (current)
- Added workspace context block for richer inference
- Why: edge inference without workspace context was missing obvious connections

### infer-edge-v2
- Shifted from requiring explicit text evidence to reasoning about real-world relationships
- Added reasoning steps (what does each node represent?)
- Added confidence scale guidance (0.8+ = clear, 0.5-0.79 = plausible, etc.)
- Why: v1 was too conservative, missed non-obvious but useful connections

### infer-edge-v1
- Initial edge inference prompt — required direct textual evidence

---

## Assistant (`assistant.ts`)

### assistant-v4 (current)
- Added full mutation tool vocabulary: propose_node, propose_nodes_batch, propose_edge, update_node, archive_node, complete_node, add_task_to_calendar, reschedule_task, mark_task_done
- Every mutation tool pauses the agent loop and surfaces an Accept/Reject card via the M2 confirmation gate
- Added "ONE mutation per turn" rule (server auto-rejects extras) with guidance to call propose_nodes_batch for multi-item asks
- Replaced the `<nodes>` and `<graph_edit>` tag protocols with direct tool calls; kept `<recompute_scores/>` and the planner `<plan>` block (not yet migrated to tools)
- Added tool-selection guidance per intent ("add X"→propose_node, "break into steps"→propose_nodes_batch, "I finished"→complete_node, etc.)
- Why: M3 replaces the old text-tag mutation path with tool-use so mutations go through the confirmation gate by default

### assistant-v3
- Reframed from "answer the query" to "collaborator the user thinks out loud with"
- Added engagement rules: acknowledge first, clarify when ambiguous, act decisively when confident
- Added tool-use guidance for read-only agent loop (search_nodes, get_node, get_recent_activity, get_workspace_summary, get_calendar)
- Added tone rules: match user energy, no sycophancy, emotional acknowledgement only when warranted
- Kept legacy `<nodes>` / `<graph_edit>` / `<plan>` / `<recompute_scores/>` tags until M3 mutation tools replace them
- Why: M1 agent loop needs a prompt that treats tools as the default grounding mechanism and pushes clarifying questions for genuinely ambiguous asks — no more "CREATE THE NODES" for every ask

### assistant-v2
- Added mode system (explain, plan, transform)
- Added anti-generic-advice rule: "Never produce a generic self-help tip that ignores graph context"
- Why: assistant was giving Buzzfeed-tier productivity tips instead of using graph data

### assistant-v1
- Basic graph-grounded assistant with context injection

---

## Planner (`plan.ts`)

### plan-v2 (current)
- Added candidate planning signals (due soon, blocked by, unblocks, carry-over, recently unblocked)
- Added rule for manual planner items from workspace context to be schedulable with `node_id = null`
- Why: the planner needed richer backend signals and a way to account for standalone manual tasks without flattening everything into generic blocks

### plan-v1
- Initial planning prompt with time blocks, breaks, buffer
- Block types: focus, admin, break, buffer
- Rules: 25-50 min focus blocks, breaks for 90+ min sessions, 10 min end buffer

---

## Embeddings

### embed-v1 (current)
- Gemini text-embedding-004, 768 dimensions
- No prompt changes — uses model defaults

---

## Reranking

### rerank-v1 (current)
- Cohere rerank-v3.5
- Fallback: lexical scoring when Cohere is unavailable
