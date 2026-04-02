-- AI Phase 3: structured same-dump soft links on proposed_nodes
-- Lets extraction emit a tiny set of explicit same-dump overlay links so
-- important cross-branch connections are preserved without dense pairwise
-- inference.

alter table public.proposed_nodes
  add column if not exists soft_links jsonb not null default '[]'::jsonb;
