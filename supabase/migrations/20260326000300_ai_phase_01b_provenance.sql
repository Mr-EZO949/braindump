-- AI Phase 1B: ai_runs and ai_artifacts tables
-- Every AI call gets logged here before any output is written to the DB.
-- proposed_nodes/edges.ai_run_id FK constraints are added here now that the
-- parent table exists.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.ai_run_type as enum (
    'extract', 'embed', 'rerank', 'infer_edge',
    'assistant', 'plan', 'merge_check', 'lifecycle_cascade'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.ai_run_status as enum ('success', 'failed', 'retrying');
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- ai_runs
-- ---------------------------------------------------------------------------

create table if not exists public.ai_runs (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  workspace_id     uuid references public.workspaces (id) on delete set null,
  run_type         public.ai_run_type not null,
  provider         text not null,
  model_name       text not null,
  prompt_version   text not null,
  input_hash       text,
  output_hash      text,
  input_tokens     integer,
  output_tokens    integer,
  latency_ms       integer,
  estimated_cost   numeric,
  status           public.ai_run_status not null default 'success',
  error_text       text,
  created_at       timestamptz not null default now()
);

-- Index: fetch recent runs per workspace for the observability page
create index if not exists ai_runs_workspace_created_idx
  on public.ai_runs (workspace_id, created_at desc);

-- Index: filter by run type for cost breakdowns
create index if not exists ai_runs_type_idx
  on public.ai_runs (run_type);

-- ---------------------------------------------------------------------------
-- ai_artifacts
-- ---------------------------------------------------------------------------

create table if not exists public.ai_artifacts (
  id                  uuid primary key default gen_random_uuid(),
  ai_run_id           uuid not null references public.ai_runs (id) on delete cascade,
  user_id             uuid not null references auth.users (id) on delete cascade,
  artifact_type       text not null,
  payload             jsonb not null default '{}',
  linked_entity_ids   uuid[],
  created_at          timestamptz not null default now()
);

create index if not exists ai_artifacts_run_idx
  on public.ai_artifacts (ai_run_id);

-- ---------------------------------------------------------------------------
-- Back-fill FK constraints on proposal tables now that ai_runs exists
-- ---------------------------------------------------------------------------

do $$ begin
  alter table public.proposed_nodes
    add constraint proposed_nodes_ai_run_id_fkey
      foreign key (ai_run_id) references public.ai_runs (id) on delete set null;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.proposed_edges
    add constraint proposed_edges_ai_run_id_fkey
      foreign key (ai_run_id) references public.ai_runs (id) on delete set null;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- RLS — ai_runs
-- ---------------------------------------------------------------------------

alter table public.ai_runs enable row level security;

drop policy if exists "ai_runs_select_own" on public.ai_runs;
create policy "ai_runs_select_own"
  on public.ai_runs for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "ai_runs_insert_own" on public.ai_runs;
create policy "ai_runs_insert_own"
  on public.ai_runs for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "ai_runs_update_own" on public.ai_runs;
create policy "ai_runs_update_own"
  on public.ai_runs for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- RLS — ai_artifacts
-- ---------------------------------------------------------------------------

alter table public.ai_artifacts enable row level security;

drop policy if exists "ai_artifacts_select_own" on public.ai_artifacts;
create policy "ai_artifacts_select_own"
  on public.ai_artifacts for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "ai_artifacts_insert_own" on public.ai_artifacts;
create policy "ai_artifacts_insert_own"
  on public.ai_artifacts for insert
  to authenticated
  with check ((select auth.uid()) = user_id);
