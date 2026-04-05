-- AI Phase 11: merge lineage / provenance preservation
-- Records which archived duplicate node was folded into which canonical node,
-- while preserving the duplicate's originating proposals and AI runs.

create table if not exists public.node_merge_lineage (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users (id) on delete cascade,
  workspace_id             uuid not null references public.workspaces (id) on delete cascade,
  canonical_node_id        uuid not null references public.nodes (id) on delete cascade,
  merged_node_id           uuid not null references public.nodes (id) on delete cascade,
  merge_suggestion_id      uuid references public.merge_suggestions (id) on delete set null,
  source_proposed_node_ids uuid[] not null default '{}',
  source_ai_run_ids        uuid[] not null default '{}',
  source_snapshot          jsonb not null default '{}'::jsonb,
  canonical_snapshot       jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),
  check (canonical_node_id <> merged_node_id)
);

create unique index if not exists node_merge_lineage_pair_idx
  on public.node_merge_lineage (canonical_node_id, merged_node_id);

create index if not exists node_merge_lineage_workspace_created_idx
  on public.node_merge_lineage (workspace_id, created_at desc);

alter table public.node_merge_lineage enable row level security;

drop policy if exists "node_merge_lineage_select_own" on public.node_merge_lineage;
create policy "node_merge_lineage_select_own"
  on public.node_merge_lineage for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "node_merge_lineage_insert_own" on public.node_merge_lineage;
create policy "node_merge_lineage_insert_own"
  on public.node_merge_lineage for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "node_merge_lineage_update_own" on public.node_merge_lineage;
create policy "node_merge_lineage_update_own"
  on public.node_merge_lineage for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
