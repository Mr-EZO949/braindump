-- AI Phase 3: structured extraction references and accepted-node provenance
-- Stores sparse structure directly on proposed_nodes so extraction can emit a
-- primary tree before pairwise connection analysis runs.

alter table public.proposed_nodes
  add column if not exists local_ref text,
  add column if not exists primary_parent_local_ref text,
  add column if not exists depends_on_local_refs text[] not null default '{}',
  add column if not exists accepted_node_id uuid references public.nodes (id) on delete set null;

create unique index if not exists proposed_nodes_raw_entry_local_ref_idx
  on public.proposed_nodes (raw_entry_id, local_ref)
  where local_ref is not null;

create index if not exists proposed_nodes_accepted_node_idx
  on public.proposed_nodes (accepted_node_id)
  where accepted_node_id is not null;
