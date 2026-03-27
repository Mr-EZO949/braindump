-- AI Phase 1A: proposed_nodes and proposed_edges tables
-- AI output lands here first. Users review and accept/reject before anything
-- is written into the canonical nodes/edges tables.

-- ---------------------------------------------------------------------------
-- proposed_nodes
-- ---------------------------------------------------------------------------

create table if not exists public.proposed_nodes (
  id                    uuid primary key default gen_random_uuid(),
  raw_entry_id          uuid not null references public.raw_entries (id) on delete cascade,
  workspace_id          uuid not null references public.workspaces (id) on delete cascade,
  user_id               uuid not null references auth.users (id) on delete cascade,
  -- ai_run_id is nullable until Phase 1B creates the ai_runs table;
  -- the column is added now so the shape is correct from day one.
  ai_run_id             uuid,
  proposed_title        text not null,
  proposed_summary      text,
  proposed_node_type    text not null,
  extraction_confidence numeric not null default 0,
  source_span           text,
  proposal_status       public.proposal_status not null default 'pending_review',
  created_at            timestamptz not null default now()
);

-- Index: fetch pending proposals per workspace for the review UI
create index if not exists proposed_nodes_workspace_status_idx
  on public.proposed_nodes (workspace_id, proposal_status);

-- ---------------------------------------------------------------------------
-- proposed_edges
-- ---------------------------------------------------------------------------

create table if not exists public.proposed_edges (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  user_id          uuid not null references auth.users (id) on delete cascade,
  ai_run_id        uuid,
  source_node_id   uuid not null references public.nodes (id) on delete cascade,
  target_node_id   uuid not null references public.nodes (id) on delete cascade,
  edge_type        text not null,
  confidence       numeric not null default 0,
  explanation      text,
  proposal_status  public.proposal_status not null default 'pending_review',
  created_at       timestamptz not null default now()
);

-- Index: fetch pending edge proposals per workspace
create index if not exists proposed_edges_workspace_status_idx
  on public.proposed_edges (workspace_id, proposal_status);

-- Prevent the same pair from being proposed twice when both are still pending
create unique index if not exists proposed_edges_unique_pending_pair_idx
  on public.proposed_edges (workspace_id, source_node_id, target_node_id)
  where proposal_status = 'pending_review';

-- ---------------------------------------------------------------------------
-- RLS — proposed_nodes
-- ---------------------------------------------------------------------------

alter table public.proposed_nodes enable row level security;

drop policy if exists "proposed_nodes_select_own" on public.proposed_nodes;
create policy "proposed_nodes_select_own"
  on public.proposed_nodes for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "proposed_nodes_insert_own" on public.proposed_nodes;
create policy "proposed_nodes_insert_own"
  on public.proposed_nodes for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "proposed_nodes_update_own" on public.proposed_nodes;
create policy "proposed_nodes_update_own"
  on public.proposed_nodes for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "proposed_nodes_delete_own" on public.proposed_nodes;
create policy "proposed_nodes_delete_own"
  on public.proposed_nodes for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- RLS — proposed_edges
-- ---------------------------------------------------------------------------

alter table public.proposed_edges enable row level security;

drop policy if exists "proposed_edges_select_own" on public.proposed_edges;
create policy "proposed_edges_select_own"
  on public.proposed_edges for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "proposed_edges_insert_own" on public.proposed_edges;
create policy "proposed_edges_insert_own"
  on public.proposed_edges for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "proposed_edges_update_own" on public.proposed_edges;
create policy "proposed_edges_update_own"
  on public.proposed_edges for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "proposed_edges_delete_own" on public.proposed_edges;
create policy "proposed_edges_delete_own"
  on public.proposed_edges for delete
  to authenticated
  using ((select auth.uid()) = user_id);
