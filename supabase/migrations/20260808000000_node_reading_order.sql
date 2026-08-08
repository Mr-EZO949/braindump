-- Reading order: lets a graph be read start-to-finish as a document.
--
-- `reading_order` is an OPTIONAL integer position for a node within its
-- workspace. The reading view's Prev/Next follows it ascending. It is
-- deliberately independent of edges — order is a narrative sequence the user
-- sets by dragging, and we never create edges from it or infer it from edges.
--
-- Nullable and non-unique on purpose: most nodes have no order (Next then
-- falls back to the strongest connection), and dragging can transiently
-- produce ties before positions are renormalised. The partial index keeps the
-- "ordered nodes in this workspace, in sequence" lookup cheap without indexing
-- the null majority.
--
-- Note on `body`: nodes.body (added in 20260513000000_node_body) has no
-- DB-level length constraint, so storing full markdown needs no schema change.
-- The ~400-char cap only ever applied to AI-*proposed* bodies at validation
-- time; user-authored bodies were never capped in the database.

alter table public.nodes
  add column if not exists reading_order integer;

create index if not exists nodes_workspace_reading_order_idx
  on public.nodes (workspace_id, reading_order)
  where reading_order is not null;

comment on column public.nodes.reading_order is
  'Optional narrative position within the workspace (ascending). Drives the '
  'reading view Prev/Next. Independent of edges — never derived from or turned '
  'into edges. Null = unordered; Next falls back to the strongest connection.';
