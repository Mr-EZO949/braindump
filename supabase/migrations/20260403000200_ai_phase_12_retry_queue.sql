-- AI Phase 12: durable retry queue for deferred non-blocking AI work
-- Used first for embedding retries so node acceptance can succeed even when
-- providers are rate-limited or temporarily unavailable.

create table if not exists public.ai_retry_queue (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  workspace_id    uuid references public.workspaces (id) on delete set null,
  job_type        text not null,
  dedupe_key      text not null unique,
  payload         jsonb not null default '{}',
  status          text not null default 'queued',
  attempt_count   integer not null default 0,
  available_at    timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint ai_retry_queue_status_check
    check (status in ('queued', 'processing', 'completed', 'failed'))
);

create index if not exists ai_retry_queue_status_available_idx
  on public.ai_retry_queue (status, available_at);

create index if not exists ai_retry_queue_workspace_status_idx
  on public.ai_retry_queue (workspace_id, status, created_at desc);

alter table public.ai_retry_queue enable row level security;

drop policy if exists "ai_retry_queue_select_own" on public.ai_retry_queue;
create policy "ai_retry_queue_select_own"
  on public.ai_retry_queue for select
  using (user_id = (select auth.uid()));

drop policy if exists "ai_retry_queue_insert_own" on public.ai_retry_queue;
create policy "ai_retry_queue_insert_own"
  on public.ai_retry_queue for insert
  with check (user_id = (select auth.uid()));

drop policy if exists "ai_retry_queue_update_own" on public.ai_retry_queue;
create policy "ai_retry_queue_update_own"
  on public.ai_retry_queue for update
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "ai_retry_queue_delete_own" on public.ai_retry_queue;
create policy "ai_retry_queue_delete_own"
  on public.ai_retry_queue for delete
  using (user_id = (select auth.uid()));
