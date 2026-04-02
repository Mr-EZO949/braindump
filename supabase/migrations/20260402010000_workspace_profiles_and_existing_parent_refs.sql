alter table public.workspaces
add column if not exists profile_role text,
add column if not exists profile_summary text,
add column if not exists profile_payload jsonb not null default '{}'::jsonb,
add column if not exists bootstrap_root_node_id uuid references public.nodes (id) on delete set null,
add column if not exists bootstrap_completed_at timestamptz;

alter table public.proposed_nodes
add column if not exists existing_parent_node_id uuid references public.nodes (id) on delete set null;

create index if not exists proposed_nodes_existing_parent_node_id_idx
  on public.proposed_nodes (existing_parent_node_id);
