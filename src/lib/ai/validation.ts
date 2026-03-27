// Runtime output validation for AI provider responses.
// Every structured AI response is validated here before being written to the DB.
// If validation fails the caller catches the error, logs the failure, and does not write.

import type {
  ExtractionOutput,
  EdgeInferenceOutput,
  PlanOutput,
  EmbeddingOutput,
  RerankOutput,
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
]);

export function validateExtractionOutput(raw: unknown): ExtractionOutput {
  if (!isObject(raw)) throw new Error("Extraction output must be an object");
  if (!Array.isArray(raw.proposed_nodes))
    throw new Error("Extraction output missing proposed_nodes array");
  if (!isString(raw.prompt_version))
    throw new Error("Extraction output missing prompt_version");

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

    return {
      workspace_id: n.workspace_id as string,
      user_id: n.user_id as string,
      proposed_title: (n.proposed_title as string).trim(),
      proposed_summary: isString(n.proposed_summary)
        ? n.proposed_summary
        : null,
      proposed_node_type: n.proposed_node_type as ExtractionOutput["proposed_nodes"][number]["proposed_node_type"],
      extraction_confidence: isNumber(n.extraction_confidence)
        ? Math.min(1, Math.max(0, n.extraction_confidence))
        : 0.5,
      source_span: isString(n.source_span) ? n.source_span : null,
      proposal_status: "pending_review" as const,
    };
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
