-- node_embeddings lookup index.
--
-- match_nodes() filters by (user_id, workspace_id) and then orders by vector
-- distance. Without an index on those columns, EVERY similarity query
-- sequentially scanned every user's embeddings (3072-d, ~12 KB per row) before
-- filtering — cost grew with the whole platform, not with the one workspace
-- being searched.
--
-- With this index, Postgres jumps straight to the workspace's rows and computes
-- EXACT cosine distance over just those. At personal-graph scale (tens to low
-- thousands of nodes per workspace) exact search is both faster and more
-- accurate than an ANN index would be — and pgvector can't HNSW-index a
-- 3072-dim `vector` column anyway. This is the intended design; don't add an
-- ivfflat index here (it would make results approximate for no real gain).

create index if not exists node_embeddings_workspace_user_idx
  on public.node_embeddings (workspace_id, user_id);
