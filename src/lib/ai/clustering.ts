// Retroactive clustering pass. Looks at loosely-connected nodes in the
// workspace, groups them by embedding similarity, and proposes umbrella
// parents named by Haiku.
//
// Runs after every extraction in /api/entries — cost is near-zero when no
// new clusters are found, ~$0.001 per cluster when one is.

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";

import { AI_MODELS, AI_TEMPERATURE } from "@/lib/ai/config";
import { recordClaudeRun, type AIUsageScope } from "@/lib/ai/telemetry";
import { readClaudeUsage } from "@/lib/ai/usage";
import type { SupabaseClient } from "@supabase/supabase-js";

// Cosine threshold above which two nodes are considered close enough to
// belong in the same cluster. We use TWO thresholds:
//   - SIMILARITY_THRESHOLD_TIGHT (0.78): only really-close pairs (e.g.
//     three sibling courses) cluster as a 2-member group
//   - SIMILARITY_THRESHOLD_LOOSE (0.7): looser pairs need 3+ members
// This keeps small umbrellas honest (no random 2-task clusters from
// incidental adjacency) while still letting "OS class + Algorithms class"
// generate a "Courses" parent.
// Three thresholds for a hybrid single-link-with-complete-link-floor
// algorithm:
//   - SEED (LOOSE 0.65): two unassigned nodes start a new cluster if they
//     pair at this level
//   - JOIN_FLOOR (0.55): when a node tries to join an existing cluster,
//     it must be at LEAST this similar to EVERY existing member, not just
//     the one bridging it in. Stops bureaucratic-vocabulary chaining
//     ("Submit Pre-K Deposit Form" ↔ "Draft Marina's Q3 Promo Packet" both
//     score ~0.68 because of submit/draft/form/packet token overlap, but
//     they're unrelated domains — Marina shouldn't be added to a pre-K
//     cluster just because she chains via one weak bridge)
//   - TIGHT (0.72): a 2-member cluster is only retained if its single
//     pair sim is at this level (otherwise we drop sketchy 2-member groups)
const SIMILARITY_THRESHOLD_TIGHT = 0.72;
const SIMILARITY_THRESHOLD_LOOSE = 0.65;
// 0.62 was tuned against fixture data — Marina↔PreKVisit lands at ~0.61
// (spurious cross-domain bridge from shared bureaucratic language) so 0.62
// rejects it. Berlin Marathon↔LongRun is the weakest link in a real
// marathon cluster at 0.647, so 0.62 keeps that cluster intact.
const SIMILARITY_THRESHOLD_JOIN_FLOOR = 0.62;

// Minimum cluster sizes. A cluster passes if EITHER:
//   - 2 members all pairwise above the tight threshold, OR
//   - 3+ members all above the loose threshold
const MIN_CLUSTER_SIZE_TIGHT = 2;
const MIN_CLUSTER_SIZE_LOOSE = 3;

// Cap so a single workspace can't generate dozens of suggestions per dump.
// Bumped 3 → 5 once single-link clustering started finding more real groups.
const MAX_CLUSTERS_PER_PASS = 5;

export type ClusterSuggestion = {
  id: string;
  suggestedTitle: string;
  suggestedNodeType: string;
  childNodeIds: string[];
  signatureHash: string;
};

type CandidateNode = {
  id: string;
  title: string;
  summary: string | null;
  node_type: string;
  embedding: number[];
};

// Stable signature for a cluster: sorted ids, sha256. Same set = same hash
// regardless of order. Used to dedupe against dismissed_clusters.
export function clusterSignature(childNodeIds: string[]): string {
  const sorted = [...childNodeIds].sort();
  return createHash("sha256").update(sorted.join(",")).digest("hex");
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function centroid(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const out = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) out[i] += v[i];
  }
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
}

// Greedy clustering by descending pairwise similarity. Each node lands in
// at most one cluster (single-cluster-per-node invariant — avoids proposing
// overlapping umbrellas that would conflict with idx_edges_single_parent on
// accept). Sorted by tightest-pair-first so high-cohesion clusters seed
// before weaker pairs get a chance to drag a node into a looser group.
export function greedyCluster(nodes: CandidateNode[]): CandidateNode[][] {
  if (nodes.length < MIN_CLUSTER_SIZE_TIGHT) return [];

  type Pair = { a: number; b: number; sim: number };
  const pairs: Pair[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const sim = cosine(nodes[i].embedding, nodes[j].embedding);
      if (sim >= SIMILARITY_THRESHOLD_LOOSE) {
        pairs.push({ a: i, b: j, sim });
      }
    }
  }
  pairs.sort((x, y) => y.sim - x.sim);

  const clusterByNode = new Map<number, number>(); // node idx → cluster idx
  const clusters: number[][] = [];

  // Hybrid: single-link seeding + complete-link floor on joins.
  //   - Seeding: any pair >= LOOSE starts a cluster (single-link)
  //   - Joining: a candidate joins an existing cluster only if it sims
  //     >= JOIN_FLOOR with EVERY current member (complete-link floor)
  //
  // This kills the chaining failure mode without losing genuine clusters.
  // Berlin Marathon joins {LongRun, Bonking} because it pairs >= floor
  // with both, but Marina can't bridge into a pre-K cluster because her
  // similarity to PreK Visit is below 0.55 even though she pairs with
  // PreK Deposit at 0.68.
  const candidateJoins = (
    candidate: number,
    members: number[],
  ): boolean => {
    for (const m of members) {
      if (m === candidate) continue;
      const sim = cosine(nodes[candidate].embedding, nodes[m].embedding);
      if (sim < SIMILARITY_THRESHOLD_JOIN_FLOOR) return false;
    }
    return true;
  };

  for (const { a, b } of pairs) {
    const ca = clusterByNode.get(a);
    const cb = clusterByNode.get(b);

    if (ca === undefined && cb === undefined) {
      const idx = clusters.length;
      clusters.push([a, b]);
      clusterByNode.set(a, idx);
      clusterByNode.set(b, idx);
    } else if (ca !== undefined && cb === undefined) {
      if (candidateJoins(b, clusters[ca])) {
        clusters[ca].push(b);
        clusterByNode.set(b, ca);
      }
    } else if (ca === undefined && cb !== undefined) {
      if (candidateJoins(a, clusters[cb])) {
        clusters[cb].push(a);
        clusterByNode.set(a, cb);
      }
    }
    // Both assigned → never merge clusters; tightest-pair-wins.
  }

  // Two-tier filter: clusters of 2 only survive if their pair sim was tight
  // (>= TIGHT threshold); clusters of 3+ pass at the looser threshold.
  return clusters
    .filter((c) => {
      if (c.length >= MIN_CLUSTER_SIZE_LOOSE) return true;
      if (c.length === MIN_CLUSTER_SIZE_TIGHT) {
        const sim = cosine(nodes[c[0]].embedding, nodes[c[1]].embedding);
        return sim >= SIMILARITY_THRESHOLD_TIGHT;
      }
      return false;
    })
    .sort((x, y) => y.length - x.length)
    .slice(0, MAX_CLUSTERS_PER_PASS)
    .map((c) => c.map((i) => nodes[i]));
}

// Asks Haiku for a short umbrella title + node_type for a candidate cluster.
// Cheap structured task: ~500 input + 30 output tokens, ~$0.0008.
async function nameCluster(
  cluster: CandidateNode[],
  usageScope: AIUsageScope,
): Promise<{ title: string; node_type: string } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const childList = cluster
    .map((n) => `- "${n.title}"${n.summary ? ` — ${n.summary.slice(0, 120)}` : ""} [${n.node_type}]`)
    .join("\n");

  const prompt = `These nodes from a personal knowledge graph all seem to belong under one umbrella. Propose a single concise parent title (3–6 words) and a node_type that best groups them, OR refuse if no good single domain captures them.

Children:
${childList}

Allowed node_types: area, goal, project, big_task, class
- area: a part of life the children belong to, with no finish line ("Health", "Career", "Life Admin") — the usual answer for a domain grouping
- goal: a result the children all serve ("Pass Machine Learning", "Run a half-marathon under 1:50 by November") — only when there is a real finish line you could verify
- project: an active initiative with several different parts that the children are part of
- big_task: one piece of work the children are the steps of ("Write the thesis")
- class: a course or formal study

REJECT (respond with {"title": null, "node_type": null}) if the only honest umbrella would be:
- A time-window like "Weekly Priorities", "This Week's Tasks", "Monthly Goals", "Q3 Focus"
- A possessive of the user's name like "Tomás's Stuff", "Aisha's Tasks"
- A generic catch-all like "Tasks", "Things to Do", "Random Stuff", "Miscellaneous", "Personal Admin", "Action Items"
- A vague abstraction like "Important Things", "Top Priorities", "Stuff I Care About"

GOOD umbrellas name a real domain or relationship the children share:
- "Fall Semester Courses", "Lucia's Pre-K Enrollment", "Berlin Marathon Training"
- "Health & Wellness Habits", "Job Search", "Side Project: TopoLog"
- "Stripe Loop Prep", "Wedding Planning", "Year-End Tax Filing"

Domain test: would the title still make sense if the user re-read it 3 months from now without context? If no, reject.

Respond with ONLY a JSON object. Two valid shapes:
- {"title": "<umbrella>", "node_type": "<type>"} when a clean domain exists
- {"title": null, "node_type": null} when the children don't honestly share one
No prose, no markdown.`;

  try {
    const client = new Anthropic({ apiKey });
    const startedAt = Date.now();
    const r = await client.messages.create({
      model: AI_MODELS.CLAUDE_HAIKU,
      max_tokens: 128,
      temperature: AI_TEMPERATURE.MERGE_CHECK, // structured, deterministic
      system: "You always respond with valid JSON only. No markdown, no prose, just the raw JSON object.",
      messages: [{ role: "user", content: prompt }],
    });
    await recordClaudeRun({
      scope: usageScope,
      source: "cluster-naming",
      model: AI_MODELS.CLAUDE_HAIKU,
      promptVersion: "cluster-naming",
      usage: readClaudeUsage(r.usage),
      latencyMs: Date.now() - startedAt,
    });
    const block = r.content[0];
    if (block?.type !== "text") return null;
    const text = block.text.trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { title?: unknown; node_type?: unknown };
    // Explicit refusal — Haiku decided no clean domain umbrella applies.
    if (parsed.title === null || parsed.node_type === null) return null;
    if (typeof parsed.title !== "string" || typeof parsed.node_type !== "string") return null;
    const allowed = new Set(["area", "goal", "project", "big_task", "class"]);
    if (!allowed.has(parsed.node_type)) return null;
    // Defensive fallback: even if Haiku ignored the rejection rules above,
    // catch the worst patterns client-side so we never persist them.
    const lower = parsed.title.toLowerCase();
    const banned = [
      "weekly priorit",
      "weekly task",
      "this week",
      "monthly goal",
      "q3 focus",
      "q4 focus",
      "top priorit",
      "important thing",
      "things to do",
      "random stuff",
      "miscellaneous",
      "action items",
      "personal admin",
    ];
    if (banned.some((b) => lower.includes(b))) return null;
    // Note: we don't reject possessives ("Lucia's Pre-K Enrollment" is
    // legit — child's name + specific domain). The vague-priorities case
    // is handled by the banned phrases above.
    return { title: parsed.title.slice(0, 80).trim(), node_type: parsed.node_type };
  } catch {
    return null;
  }
}

// Main entry. Runs the pass and persists fresh suggestions. Returns the
// suggestion rows so callers can include them in their response.
export async function runClusteringPass(params: {
  supabase: SupabaseClient;
  userId: string;
  workspaceId: string;
}): Promise<ClusterSuggestion[]> {
  const { supabase, userId, workspaceId } = params;

  // Find the workspace's bootstrap root — eligibility is keyed on it.
  const { data: workspaceRow } = await supabase
    .from("workspaces")
    .select("bootstrap_root_node_id")
    .eq("id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  const rootId = workspaceRow?.bootstrap_root_node_id as string | null | undefined;
  if (!rootId) return [];

  // Pull all active nodes in the workspace + their embeddings.
  const { data: nodeRows } = await supabase
    .from("nodes")
    .select("id, title, summary, node_type, status")
    .eq("user_id", userId)
    .eq("workspace_id", workspaceId)
    .eq("status", "active");
  if (!nodeRows || nodeRows.length === 0) return [];

  const nodeIds = nodeRows.map((n) => n.id as string);

  // Eligibility: only nodes whose ONLY belongs_to edge points at the root,
  // or who have no belongs_to edge at all. Nodes already nested under a
  // meaningful parent stay put.
  const { data: edgeRows } = await supabase
    .from("edges")
    .select("source_node_id, target_node_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("edge_type", "belongs_to")
    .eq("status", "active")
    .in("source_node_id", nodeIds);

  const parentByChild = new Map<string, string>();
  for (const e of edgeRows ?? []) {
    parentByChild.set(e.source_node_id as string, e.target_node_id as string);
  }

  const eligibleIds = nodeIds.filter((id) => {
    if (id === rootId) return false;
    const parent = parentByChild.get(id);
    return !parent || parent === rootId;
  });
  if (eligibleIds.length < MIN_CLUSTER_SIZE_TIGHT) return [];

  // Fetch embeddings.
  const { data: embeddingRows } = await supabase
    .from("node_embeddings")
    .select("node_id, embedding")
    .in("node_id", eligibleIds);
  if (!embeddingRows || embeddingRows.length < MIN_CLUSTER_SIZE_TIGHT) return [];

  const embByNode = new Map<string, number[]>();
  for (const row of embeddingRows) {
    const raw = row.embedding;
    // pgvector serializes as a JSON-array string in some clients; coerce.
    const vec = Array.isArray(raw)
      ? (raw as number[])
      : typeof raw === "string"
        ? (JSON.parse(raw) as number[])
        : null;
    if (vec) embByNode.set(row.node_id as string, vec);
  }

  const candidates: CandidateNode[] = [];
  for (const row of nodeRows) {
    const id = row.id as string;
    if (!eligibleIds.includes(id)) continue;
    const embedding = embByNode.get(id);
    if (!embedding) continue;
    candidates.push({
      id,
      title: row.title as string,
      summary: row.summary as string | null,
      node_type: row.node_type as string,
      embedding,
    });
  }
  if (candidates.length < MIN_CLUSTER_SIZE_TIGHT) return [];

  // Cluster.
  const clusters = greedyCluster(candidates);
  if (clusters.length === 0) return [];

  // Filter against dismissed signatures + already-pending suggestions
  // (don't double-propose between passes).
  const signatures = clusters.map((c) => clusterSignature(c.map((n) => n.id)));
  const { data: dismissed } = await supabase
    .from("dismissed_clusters")
    .select("signature_hash")
    .eq("user_id", userId)
    .eq("workspace_id", workspaceId)
    .in("signature_hash", signatures);
  const { data: pending } = await supabase
    .from("cluster_suggestions")
    .select("signature_hash")
    .eq("user_id", userId)
    .eq("workspace_id", workspaceId)
    .eq("proposal_status", "pending_review")
    .in("signature_hash", signatures);
  const skip = new Set([
    ...((dismissed ?? []).map((d) => d.signature_hash as string)),
    ...((pending ?? []).map((d) => d.signature_hash as string)),
  ]);

  const fresh = clusters
    .map((c, i) => ({ cluster: c, signature: signatures[i] }))
    .filter(({ signature }) => !skip.has(signature));
  if (fresh.length === 0) return [];

  // Name each cluster with Haiku in parallel.
  const named = await Promise.all(
    fresh.map(async ({ cluster, signature }) => {
      const naming = await nameCluster(cluster, { supabase, userId, workspaceId });
      if (!naming) return null;
      return {
        title: naming.title,
        node_type: naming.node_type,
        childNodeIds: cluster.map((n) => n.id),
        signature,
      };
    }),
  );

  const persistRows = named.filter((n): n is NonNullable<typeof n> => n !== null);
  if (persistRows.length === 0) return [];

  const { data: inserted } = await supabase
    .from("cluster_suggestions")
    .insert(
      persistRows.map((p) => ({
        user_id: userId,
        workspace_id: workspaceId,
        suggested_title: p.title,
        suggested_node_type: p.node_type,
        child_node_ids: p.childNodeIds,
        signature_hash: p.signature,
        proposal_status: "pending_review",
      })),
    )
    .select("*");

  return (inserted ?? []).map((row) => ({
    id: row.id as string,
    suggestedTitle: row.suggested_title as string,
    suggestedNodeType: row.suggested_node_type as string,
    childNodeIds: row.child_node_ids as string[],
    signatureHash: row.signature_hash as string,
  }));
}
