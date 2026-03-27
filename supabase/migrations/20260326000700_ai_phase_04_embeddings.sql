-- Phase 4: Embeddings and retrieval layer
-- Enables pgvector, creates node_embeddings table, and adds match_nodes RPC.

-- ---------------------------------------------------------------------------
-- Enable pgvector extension
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- node_embeddings
-- Stores one embedding vector per accepted node.
-- Keyed on node_id (UNIQUE) — re-embed by upsert.
-- Embedding dimension: 3072 (gemini-embedding-001).
-- Do NOT re-embed when only node status changes — embedding captures meaning.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS node_embeddings (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id       uuid        NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id  uuid        NOT NULL,
  embedding     vector(3072) NOT NULL,
  model         text        NOT NULL DEFAULT 'gemini-embedding-001',
  embedded_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE (node_id)
);

-- Note: HNSW index is limited to 2000 dims in this pgvector version.
-- gemini-embedding-001 uses 3072 dims so we use exact search for now.
-- An ivfflat index can be added once the table has >100 rows:
--   CREATE INDEX ON node_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);

-- ---------------------------------------------------------------------------
-- RLS: users can only access their own embeddings
-- ---------------------------------------------------------------------------
ALTER TABLE node_embeddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "node_embeddings_owner"
  ON node_embeddings FOR ALL
  USING (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- match_nodes RPC
-- Finds semantically similar accepted nodes for a given query embedding.
-- Excludes: archived nodes, rejected nodes, self node, wrong workspace.
-- Optionally excludes completed nodes (default: exclude them).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION match_nodes(
  query_embedding     vector(3072),
  match_user_id       uuid,
  match_workspace_id  uuid,
  match_count         int     DEFAULT 20,
  exclude_node_id     uuid    DEFAULT NULL,
  include_completed   boolean DEFAULT false
)
RETURNS TABLE (
  node_id     uuid,
  title       text,
  node_type   text,
  summary     text,
  similarity  float
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT
    n.id          AS node_id,
    n.title,
    n.node_type::text,
    n.summary,
    1 - (ne.embedding <=> query_embedding) AS similarity
  FROM node_embeddings ne
  JOIN nodes n ON n.id = ne.node_id
  WHERE
    ne.user_id       = match_user_id
    AND ne.workspace_id = match_workspace_id
    AND n.status NOT IN ('archived')
    AND (include_completed OR n.status::text != 'completed')
    AND (exclude_node_id IS NULL OR ne.node_id != exclude_node_id)
  ORDER BY ne.embedding <=> query_embedding
  LIMIT match_count;
$$;
