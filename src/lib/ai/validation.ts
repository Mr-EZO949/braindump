// Runtime output validation for AI provider responses.
// Every structured AI response is validated here before being written to the DB.
// If validation fails the caller catches the error, logs the failure, and does not write.

import type {
  ExtractionOutput,
  EdgeInferenceOutput,
  PlanOutput,
  EmbeddingOutput,
  RerankOutput,
  MergeCheckOutput,
} from "@/types/ai";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && isFinite(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

// ---------------------------------------------------------------------------
// Extraction output
// ---------------------------------------------------------------------------

const VALID_NODE_TYPES = new Set([
  "project",
  "task",
  "class",
  "concept",
  "idea",
  "journal",
  "question",
  "goal",
  "habit",
]);

const VALID_EXTRACTION_SOFT_LINK_TYPES = new Set([
  "supports",
  "related_to",
  "prerequisite_for",
  "useful_for",
  "inspired_by",
]);

const EXTRACTION_SOFT_LINK_PRIORITY: Record<string, number> = {
  prerequisite_for: 5,
  supports: 4,
  useful_for: 3,
  inspired_by: 2,
  related_to: 1,
};

export function validateExtractionOutput(raw: unknown): ExtractionOutput {
  if (!isObject(raw)) throw new Error("Extraction output must be an object");
  if (!Array.isArray(raw.proposed_nodes))
    throw new Error("Extraction output missing proposed_nodes array");
  if (!isString(raw.prompt_version))
    throw new Error("Extraction output missing prompt_version");

  const seenLocalRefs = new Set<string>();

  const nodes = raw.proposed_nodes.map((n: unknown, i: number) => {
    if (!isObject(n)) throw new Error(`proposed_nodes[${i}] is not an object`);
    if (!isString(n.proposed_title) || !n.proposed_title.trim())
      throw new Error(`proposed_nodes[${i}] missing proposed_title`);
    if (!isString(n.proposed_node_type))
      throw new Error(`proposed_nodes[${i}] missing proposed_node_type`);
    if (!VALID_NODE_TYPES.has(n.proposed_node_type))
      throw new Error(
        `proposed_nodes[${i}] unknown node type: ${n.proposed_node_type}`
      );
    if (!isString(n.workspace_id))
      throw new Error(`proposed_nodes[${i}] missing workspace_id`);
    if (!isString(n.user_id))
      throw new Error(`proposed_nodes[${i}] missing user_id`);
    if (!isString(n.local_ref) || !n.local_ref.trim())
      throw new Error(`proposed_nodes[${i}] missing local_ref`);

    const localRef = n.local_ref.trim();
    if (seenLocalRefs.has(localRef))
      throw new Error(`proposed_nodes[${i}] duplicate local_ref: ${localRef}`);
    seenLocalRefs.add(localRef);

    const primaryParentLocalRef =
      isString(n.primary_parent_local_ref) && n.primary_parent_local_ref.trim()
        ? n.primary_parent_local_ref.trim()
        : null;
    if (primaryParentLocalRef === localRef) {
      throw new Error(`proposed_nodes[${i}] cannot parent itself`);
    }

    const existingParentNodeId =
      isString(n.existing_parent_node_id) && n.existing_parent_node_id.trim()
        ? n.existing_parent_node_id.trim()
        : null;
    if (existingParentNodeId === localRef) {
      throw new Error(`proposed_nodes[${i}] cannot attach to itself`);
    }
    if (primaryParentLocalRef && existingParentNodeId) {
      throw new Error(
        `proposed_nodes[${i}] cannot define both primary_parent_local_ref and existing_parent_node_id`
      );
    }

    const dependsOnLocalRefs = Array.isArray(n.depends_on_local_refs)
      ? n.depends_on_local_refs
          .filter(isString)
          .map((ref) => ref.trim())
          .filter(Boolean)
      : [];
    if (dependsOnLocalRefs.some((ref) => ref === localRef)) {
      throw new Error(`proposed_nodes[${i}] cannot depend on itself`);
    }

    // Soft links are best-effort: drop malformed entries silently rather than
    // failing the whole extraction. A single broken cross-link must not
    // discard the valid proposed nodes around it.
    const softLinks: Array<{
      target_local_ref: string;
      edge_type: ExtractionOutput["proposed_nodes"][number]["soft_links"][number]["edge_type"];
      rationale: string | null;
    }> = [];
    if (Array.isArray(n.soft_links)) {
      for (const rawLink of n.soft_links) {
        if (!isObject(rawLink)) continue;
        if (!isString(rawLink.target_local_ref) || !rawLink.target_local_ref.trim()) continue;
        if (
          !isString(rawLink.edge_type) ||
          !VALID_EXTRACTION_SOFT_LINK_TYPES.has(rawLink.edge_type)
        ) {
          continue;
        }
        const targetLocalRef = rawLink.target_local_ref.trim();
        if (targetLocalRef === localRef) continue;

        softLinks.push({
          target_local_ref: targetLocalRef,
          edge_type:
            rawLink.edge_type as ExtractionOutput["proposed_nodes"][number]["soft_links"][number]["edge_type"],
          rationale:
            isString(rawLink.rationale) && rawLink.rationale.trim()
              ? rawLink.rationale.trim()
              : null,
        });
      }
    }

    const dedupedSoftLinks = Array.from(
      softLinks.reduce((map, link) => {
        const existing = map.get(link.target_local_ref);
        if (!existing) {
          map.set(link.target_local_ref, link);
          return map;
        }

        const existingPriority =
          EXTRACTION_SOFT_LINK_PRIORITY[existing.edge_type] ?? 0;
        const nextPriority =
          EXTRACTION_SOFT_LINK_PRIORITY[link.edge_type] ?? 0;

        if (nextPriority > existingPriority) {
          map.set(link.target_local_ref, link);
        }

        return map;
      }, new Map<string, typeof softLinks[number]>()).values()
    ).slice(0, 2);

    return {
      local_ref: localRef,
      workspace_id: n.workspace_id as string,
      user_id: n.user_id as string,
      proposed_title: (n.proposed_title as string).trim(),
      proposed_summary: isString(n.proposed_summary)
        ? n.proposed_summary
        : null,
      proposed_node_type: n.proposed_node_type as ExtractionOutput["proposed_nodes"][number]["proposed_node_type"],
      primary_parent_local_ref: primaryParentLocalRef,
      existing_parent_node_id: existingParentNodeId,
      depends_on_local_refs: Array.from(new Set(dependsOnLocalRefs)).slice(0, 2),
      soft_links: dedupedSoftLinks,
      accepted_node_id: null,
      extraction_confidence: isNumber(n.extraction_confidence)
        ? Math.min(1, Math.max(0, n.extraction_confidence))
        : 0.5,
      source_span: isString(n.source_span) ? n.source_span : null,
      proposal_status: "pending_review" as const,
    };
  });

  const knownLocalRefs = new Set(nodes.map((node) => node.local_ref));

  nodes.forEach((node, index) => {
    if (
      node.primary_parent_local_ref &&
      !knownLocalRefs.has(node.primary_parent_local_ref)
    ) {
      throw new Error(
        `proposed_nodes[${index}] references unknown parent local_ref: ${node.primary_parent_local_ref}`
      );
    }

    const invalidDependency = node.depends_on_local_refs.find(
      (ref) => !knownLocalRefs.has(ref)
    );
    if (invalidDependency) {
      throw new Error(
        `proposed_nodes[${index}] references unknown dependency local_ref: ${invalidDependency}`
      );
    }

    const invalidSoftLink = node.soft_links.find(
      (link) => !knownLocalRefs.has(link.target_local_ref)
    );
    if (invalidSoftLink) {
      throw new Error(
        `proposed_nodes[${index}] references unknown soft link local_ref: ${invalidSoftLink.target_local_ref}`
      );
    }
  });

  return {
    proposed_nodes: nodes,
    prompt_version: raw.prompt_version as string,
  };
}

// ---------------------------------------------------------------------------
// Edge inference output
// ---------------------------------------------------------------------------

const VALID_EDGE_TYPES = new Set([
  "supports",
  "related_to",
  "prerequisite_for",
  "required_for",
  "belongs_to",
  "useful_for",
  "blocks",
  "inspired_by",
  "depends_on",
]);

export function validateEdgeInferenceOutput(
  raw: unknown
): EdgeInferenceOutput {
  if (!isObject(raw))
    throw new Error("Edge inference output must be an object");
  if (!isBoolean(raw.related))
    throw new Error("Edge inference output missing related (boolean)");
  if (!isString(raw.explanation) || !raw.explanation.trim())
    throw new Error("Edge inference output missing explanation");
  if (!isString(raw.prompt_version))
    throw new Error("Edge inference output missing prompt_version");

  const confidence = isNumber(raw.confidence)
    ? Math.min(1, Math.max(0, raw.confidence))
    : 0;

  let edge_type = null;
  if (raw.related) {
    if (!isString(raw.edge_type) || !VALID_EDGE_TYPES.has(raw.edge_type)) {
      // Fallback to related_to rather than hard failing
      edge_type = "related_to" as const;
    } else {
      edge_type = raw.edge_type as EdgeInferenceOutput["edge_type"];
    }
  }

  return {
    related: raw.related as boolean,
    edge_type,
    confidence,
    explanation: (raw.explanation as string).trim(),
    prompt_version: raw.prompt_version as string,
  };
}

// ---------------------------------------------------------------------------
// Plan output
// ---------------------------------------------------------------------------

const VALID_BLOCK_TYPES = new Set(["focus", "admin", "break", "buffer"]);

export function validatePlanOutput(raw: unknown): PlanOutput {
  if (!isObject(raw)) throw new Error("Plan output must be an object");
  if (!Array.isArray(raw.blocks))
    throw new Error("Plan output missing blocks array");
  if (!isString(raw.prompt_version))
    throw new Error("Plan output missing prompt_version");

  const blocks = raw.blocks.map((b: unknown, i: number) => {
    if (!isObject(b)) throw new Error(`blocks[${i}] is not an object`);
    if (!isString(b.title) || !b.title.trim())
      throw new Error(`blocks[${i}] missing title`);
    if (!isNumber(b.start_offset))
      throw new Error(`blocks[${i}] missing start_offset`);
    if (!isNumber(b.duration_minutes) || b.duration_minutes <= 0)
      throw new Error(`blocks[${i}] missing or invalid duration_minutes`);
    if (!isString(b.block_type) || !VALID_BLOCK_TYPES.has(b.block_type))
      throw new Error(`blocks[${i}] invalid block_type: ${b.block_type}`);

    return {
      node_id: isString(b.node_id) ? (b.node_id as string) : null,
      title: (b.title as string).trim(),
      start_offset: Math.max(0, b.start_offset as number),
      duration_minutes: b.duration_minutes as number,
      reason: isString(b.reason) ? b.reason : null,
      block_type: b.block_type as PlanOutput["blocks"][number]["block_type"],
      completion_status: "pending" as const,
    };
  });

  return { blocks, prompt_version: raw.prompt_version as string };
}

// ---------------------------------------------------------------------------
// Merge-check output
// ---------------------------------------------------------------------------

export function validateMergeCheckOutput(raw: unknown): MergeCheckOutput {
  if (!isObject(raw)) throw new Error("Merge-check output must be an object");
  if (!isBoolean(raw.same_entity))
    throw new Error("Merge-check output missing same_entity");
  if (!isNumber(raw.confidence))
    throw new Error("Merge-check output missing confidence");
  if (!isString(raw.reason))
    throw new Error("Merge-check output missing reason");

  return {
    same_entity: raw.same_entity,
    confidence: Math.max(0, Math.min(1, raw.confidence)),
    reason: raw.reason.trim(),
    prompt_version:
      isString(raw.prompt_version) && raw.prompt_version.trim()
        ? raw.prompt_version
        : "merge-check-v1",
  };
}

// ---------------------------------------------------------------------------
// Embedding output
// ---------------------------------------------------------------------------

export function validateEmbeddingOutput(raw: unknown): EmbeddingOutput {
  if (!isObject(raw)) throw new Error("Embedding output must be an object");
  if (!Array.isArray(raw.embedding) || raw.embedding.length === 0)
    throw new Error("Embedding output missing embedding array");
  if (!raw.embedding.every(isNumber))
    throw new Error("Embedding values must all be numbers");

  return {
    embedding: raw.embedding as number[],
    token_count: isNumber(raw.token_count) ? (raw.token_count as number) : null,
  };
}

// ---------------------------------------------------------------------------
// Rerank output
// ---------------------------------------------------------------------------

export function validateRerankOutput(raw: unknown): RerankOutput {
  if (!isObject(raw)) throw new Error("Rerank output must be an object");
  if (!Array.isArray(raw.ranked))
    throw new Error("Rerank output missing ranked array");

  const ranked = raw.ranked.map((r: unknown, i: number) => {
    if (!isObject(r)) throw new Error(`ranked[${i}] is not an object`);
    if (!isString(r.id)) throw new Error(`ranked[${i}] missing id`);
    if (!isNumber(r.score)) throw new Error(`ranked[${i}] missing score`);
    return { id: r.id as string, score: r.score as number };
  });

  return { ranked };
}
