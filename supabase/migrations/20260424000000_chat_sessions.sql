-- Chat sessions — persistent history for the assistant rail.
-- One row per "conversation thread" the user has had within a workspace.
-- Messages are stored inline as JSONB for a first pass; splitting into a
-- separate messages table can come later if search or streaming edits need it.

create table if not exists public.chat_sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  -- "workspace" | "node" — matches ChatScope.kind on the client.
  scope_kind      text not null default 'workspace',
  -- null for workspace-scoped threads; nodes are a soft pointer (set null on
  -- node delete) so the thread outlives the node it originated from.
  scope_node_id   uuid references public.nodes (id) on delete set null,
  -- Auto-derived from the first user message; user can rename later if we
  -- add an edit affordance. Empty allowed so an unsaved session row exists
  -- before the first message arrives.
  title           text not null default '',
  messages        jsonb not null default '[]'::jsonb,
  message_count   int  not null default 0,
  last_message_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint chat_sessions_scope_kind_check
    check (scope_kind in ('workspace','node'))
);

create index if not exists chat_sessions_user_workspace_idx
  on public.chat_sessions (user_id, workspace_id, last_message_at desc nulls last);

create index if not exists chat_sessions_scope_node_idx
  on public.chat_sessions (scope_node_id)
  where scope_node_id is not null;

alter table public.chat_sessions enable row level security;

drop policy if exists "chat_sessions_select_own" on public.chat_sessions;
create policy "chat_sessions_select_own"
  on public.chat_sessions for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "chat_sessions_insert_own" on public.chat_sessions;
create policy "chat_sessions_insert_own"
  on public.chat_sessions for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "chat_sessions_update_own" on public.chat_sessions;
create policy "chat_sessions_update_own"
  on public.chat_sessions for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "chat_sessions_delete_own" on public.chat_sessions;
create policy "chat_sessions_delete_own"
  on public.chat_sessions for delete
  to authenticated
  using ((select auth.uid()) = user_id);
