-- M2.1 — pending chat runs
-- Persists a paused assistant agent loop while the user decides whether to
-- accept or reject a proposed mutation tool call. On resume the row is loaded,
-- tools are dispatched (confirmed mutation executes, unconfirmed blocks get
-- synthesised tool_results), the row is deleted, and the Claude stream
-- continues.
--
-- Rows are short-lived — expires_at defaults to 15 minutes. A nightly sweep
-- can hard-delete anything past its TTL; until that exists the resume
-- endpoint refuses to load expired rows.

create table if not exists public.pending_chat_runs (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users (id) on delete cascade,
  workspace_id           uuid not null references public.workspaces (id) on delete cascade,
  selected_node_id       uuid,
  mode                   text not null default 'explain',
  -- Full MessageParam[] history as serialized by the Anthropic SDK,
  -- up to and including the assistant turn that emitted the pending tool_use.
  messages               jsonb not null,
  -- Primary tool_use block awaiting user confirmation.
  pending_tool_use_id    text not null,
  pending_tool_name      text not null,
  pending_tool_input     jsonb not null,
  -- Other tool_use blocks in the same assistant turn (read-only or additional
  -- mutations). On resume: read-only execute, additional mutations auto-reject.
  deferred_tool_uses     jsonb not null default '[]'::jsonb,
  created_at             timestamptz not null default now(),
  expires_at             timestamptz not null default (now() + interval '15 minutes')
);

create index if not exists pending_chat_runs_user_idx
  on public.pending_chat_runs (user_id, created_at desc);

create index if not exists pending_chat_runs_expires_idx
  on public.pending_chat_runs (expires_at);

-- RLS — users can only see and act on their own pending runs.
alter table public.pending_chat_runs enable row level security;

drop policy if exists "pending_chat_runs_select_own" on public.pending_chat_runs;
create policy "pending_chat_runs_select_own"
  on public.pending_chat_runs for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "pending_chat_runs_insert_own" on public.pending_chat_runs;
create policy "pending_chat_runs_insert_own"
  on public.pending_chat_runs for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "pending_chat_runs_delete_own" on public.pending_chat_runs;
create policy "pending_chat_runs_delete_own"
  on public.pending_chat_runs for delete
  to authenticated
  using ((select auth.uid()) = user_id);
