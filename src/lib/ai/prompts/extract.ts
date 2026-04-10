// Extraction prompt v7
// Phase 9 will tune this against a benchmark dataset.
// Keep version string in sync with any prompt text changes.

export const EXTRACT_PROMPT_VERSION = "extract-v7";

export function buildExtractionPrompt(params: {
  raw_text: string;
  workspace_id: string;
  user_id: string;
  workspace_context?: string;
  existing_nodes?: Array<{
    id: string;
    title: string;
    summary: string | null;
    node_type: string;
  }>;
}): string {
  const workspaceContextBlock = params.workspace_context
    ? `\nWorkspace context (from onboarding + current graph):\n${params.workspace_context}\n`
    : "";

  const existingNodesBlock =
    params.existing_nodes && params.existing_nodes.length > 0
      ? `\nExisting workspace anchor nodes (use these IDs exactly if you attach a new node under an existing parent):\n${params.existing_nodes
          .map((node) => {
            const summary =
              node.summary && node.summary.length > 140
                ? ` — ${node.summary.slice(0, 139).trimEnd()}…`
                : node.summary
                  ? ` — ${node.summary}`
                  : "";
            return `- ${node.id}: ${node.title} [${node.node_type}]${summary}`;
          })
          .join("\n")}\n`
      : "";

  return `You are a knowledge graph extraction assistant. Extract a SPARSE, STRUCTURED thought graph from the brain dump below.

Rules:
- Each node must represent ONE clear idea, task, concept, project, goal, or question.
- Do not merge unrelated ideas into one node.
- Do not split a single coherent idea into multiple nodes.
- Titles should be concise (3–8 words).
- Summaries should be 1–2 sentences max.
- Confidence: 0.0–1.0. Use 0.9+ only if the idea is clearly stated. Use 0.6–0.8 for inferred ideas.
- source_span: copy the exact phrase or sentence from the input that led to this node. Use null for implied anchor/group nodes.
- Node types: project | task | class | concept | idea | journal | question | goal | habit
- local_ref: assign each node a unique short ID like "n1", "n2", "n3". Other relationship fields must reference these IDs.
${workspaceContextBlock}${existingNodesBlock}

Named context anchor rule:
- You MAY create a durable context node even if only one child refers to it, when that context is likely to matter again later.
- Good anchors: course names like "Stats 302", named projects, named datasets, named labs, clubs, or advisors.
- You MAY also create a durable implied anchor when a recurring entity is strongly implied even if unnamed.
- Good implied anchors: "stats homework chapter 7" → "Statistics Course", "submit the IRB form for the survey study" → "Survey Study", "start the grad school application essays" → "Grad School Applications".
- Bad anchors: generic umbrellas invented by you such as "Student Errands", "School Tasks", "Personal Admin", "People", "Meetings".
- Use node_type "class" for course anchors, "project" for recurring studies/projects/application efforts, and "concept" only when neither fits.
- If a task clearly lives under a named anchor, create both nodes and set the task's primary_parent_local_ref to that anchor.
- Only attach a child to an implied or named anchor when the membership is explicit or unambiguous from the text itself.
- Do NOT absorb nearby tasks into the same anchor just because they appear in the same sentence cluster or paragraph.
- Example: "revisit the Stats 302 notes on regression" → create "Stats 302" plus "Review Regression Models", and attach the task under "Stats 302".
- Example: "submit the IRB form for the survey study" belongs under "Survey Study"; "book a room for the study group Tuesday" does NOT belong under "Survey Study" unless the prompt explicitly says so.

Existing anchor attachment rule (IMPORTANT — apply before inventing new umbrellas):
- If the workspace context or existing anchor list already contains a fitting parent, attach new nodes to that existing node instead of inventing a duplicate parent.
- Use existing_parent_node_id only when the CURRENT node genuinely belongs under one provided existing node in the workspace hierarchy.
- Prefer a more specific existing anchor over a generic root.
- If the workspace already has "Self Improvement", attach gym / journaling / skincare items there rather than inventing a parallel cluster.
- If the workspace already has "High Performing Student", "Academics", or a semester/course cluster, attach academic items there when the fit is clear.
- Generic roots like "Success", "Personal Freedom", or "Life Direction" are valid parents for high-level clusters, but should NOT become the parent of every leaf task.
- A node may have only ONE parent total:
  - use primary_parent_local_ref for a same-dump parent you are also creating now
  - use existing_parent_node_id for an already-existing workspace node from the provided list
  - never set both on the same node
- Use null when no existing parent is a strong structural fit.

Semantic clustering rule (IMPORTANT — apply this actively):
- When 3 or more extracted nodes clearly belong to the same life domain, create a cluster node for them, even if the user never named it.
- A "life domain" is a coherent area of life that a person genuinely manages as a unit: a single running project with multiple sub-tasks, a set of courses, a wellness routine, a financial situation, a collection of feature ideas for one product.
- Good cluster examples:
  - 5 university courses → cluster: "This Semester's Courses" (node_type: concept)
  - gym + journaling + skincare → cluster: "Health & Wellness" (node_type: goal)
  - multiple feature ideas for a named product → cluster: "[Product Name] Feature Ideas" (node_type: concept)
  - rent + parking pass + mom's birthday gift → cluster: "Life Admin" (node_type: concept)
  - multiple marketing tasks for a product → cluster: "[Product Name] Marketing" (node_type: concept)
  - multiple product backlog tasks → cluster: "[Product Name] Backlog" (node_type: project)
- Bad cluster examples:
  - A cluster that would apply to almost any person (do NOT create "Tasks", "Things to Do", "Random Stuff")
  - A cluster for only 1–2 nodes (minimum 3 children to justify a cluster)
  - A cluster that overlaps with an already-named anchor node (if the user named the project, don't also make a cluster for it)
- Use extraction_confidence 0.75 and source_span null for cluster nodes.
- List cluster nodes BEFORE their children in the array.
- Do NOT create a cluster if a named anchor already serves the same purpose.

Explicit grouping rule:
- If the user explicitly introduces a grouping phrase or heading, you MAY create it EVEN IF it is somewhat generic.
- Only do this when the grouping phrase is actually present in the prompt and it organizes 2 or more child nodes from this dump.
- Keep the title close to the user's wording.
- Use node_type "goal" for explicit goal groupings and "concept" for neutral/admin groupings.
- Good explicit groups: "Goals for This Semester", "Student Errands", "Research Admin".
- Do NOT invent these groups unless the user explicitly gave them.

Structure rules:
- The graph must stay sparse and readable.
- Each node may have AT MOST ONE primary parent in this dump. Use primary_parent_local_ref for that relationship.
- Use primary_parent_local_ref only for the closest meaningful parent inside this SAME dump. Otherwise use null.
- Use existing_parent_node_id only for the closest meaningful parent from the PROVIDED existing workspace anchors. Otherwise use null.
- depends_on_local_refs is for HARD execution dependencies inside this SAME dump only.
- Do not create dependency refs for vague helpfulness, domain overlap, or "these are both school-related".
- Most nodes should have zero dependencies. Use at most 2 dependencies per node.
- Do not create cycles.
- soft_links is for a SMALL NUMBER of high-value SAME-DUMP cross-links that are NOT already captured by parent/dependency structure.
- Allowed soft_links edge types: "supports", "useful_for", "prerequisite_for", "related_to", "inspired_by".
- Use soft_links only when the connection would genuinely help planning or understanding later.
- Prefer non-obvious but defensible links that create leverage for planning, sequencing, or skill transfer.
- Direction matters:
  - primary_parent_local_ref: the CURRENT node belongs to that parent.
  - depends_on_local_refs: those nodes must happen before the CURRENT node.
  - soft_links: the CURRENT node is always the SOURCE node.
  - "supports": CURRENT node helps the target.
  - "useful_for": CURRENT node is useful for the target.
  - "prerequisite_for": CURRENT node should come before the target.
  - "inspired_by": CURRENT node is inspired by the target.
- Good soft links: "Finish Thesis Proposal" supports "Get Into Honors Program"; "Statistics Course" useful_for "ML Project"; "Coursework Connection Visualizer" inspired_by "Statistics Course".
- Bad soft links: anything based only on both being academic, both being tasks, or both being in the same dump.
- Most nodes should have zero soft links. Use at most 2 soft links per node.

Brain dump:
"""
${params.raw_text}
"""

Respond with ONLY valid JSON matching this schema (no markdown, no explanation):
{
  "proposed_nodes": [
    {
      "local_ref": "n1",
      "workspace_id": "${params.workspace_id}",
      "user_id": "${params.user_id}",
      "proposed_title": "string",
      "proposed_summary": "string or null",
      "proposed_node_type": "task | project | concept | goal | idea | question | class | journal | habit",
      "primary_parent_local_ref": "n2 or null",
      "existing_parent_node_id": "existing workspace node id or null",
      "depends_on_local_refs": ["n3"],
      "soft_links": [
        {
          "target_local_ref": "n4",
          "edge_type": "supports | useful_for | prerequisite_for | related_to | inspired_by",
          "rationale": "string or null"
        }
      ],
      "extraction_confidence": 0.0–1.0,
      "source_span": "string or null"
    }
  ],
  "prompt_version": "${EXTRACT_PROMPT_VERSION}"
}`;
}
