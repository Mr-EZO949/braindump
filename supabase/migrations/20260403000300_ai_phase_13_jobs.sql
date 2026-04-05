-- AI Phase 13: durable async jobs queue
-- General-purpose background jobs for non-interactive AI work.

create table if not exists public.ai_jobs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  workspace_id      uuid references public.workspaces (id) on delete set null,
  job_type          text not null,
  idempotency_key   text not null unique,
  payload           jsonb not null default '{}',
  status            text not null default 'queued',
  attempt_count     integer not null default 0,
  max_attempts      integer not null default 5,
  available_at      timestamptz not null default now(),
  locked_at         timestamptz,
  completed_at      timestamptz,
  last_error        text,
  dead_letter_reason text,
  result_summary    jsonb not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint ai_jobs_status_check
    check (status in ('queued', 'processing', 'completed', 'failed', 'dead_lettered'))
);

create index if not exists ai_jobs_status_available_idx
  on public.ai_jobs (status, available_at);

create index if not exists ai_jobs_workspace_status_idx
  on public.ai_jobs (workspace_id, status, created_at desc);

alter table public.ai_jobs enable row level security;

drop policy if exists "ai_jobs_select_own" on public.ai_jobs;
create policy "ai_jobs_select_own"
  on public.ai_jobs for select
  using (user_id = (select auth.uid()));

drop policy if exists "ai_jobs_insert_own" on public.ai_jobs;
create policy "ai_jobs_insert_own"
  on public.ai_jobs for insert
  with check (user_id = (select auth.uid()));

drop policy if exists "ai_jobs_update_own" on public.ai_jobs;
create policy "ai_jobs_update_own"
  on public.ai_jobs for update
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "ai_jobs_delete_own" on public.ai_jobs;
create policy "ai_jobs_delete_own"
  on public.ai_jobs for delete
  using (user_id = (select auth.uid()));
