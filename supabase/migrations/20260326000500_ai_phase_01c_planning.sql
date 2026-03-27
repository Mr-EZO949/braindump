-- AI Phase 1C: Planning subsystem tables
-- plan_sessions: one AI planning run = one session.
-- plan_blocks: ordered time blocks produced by the planner for a session.
-- plan_feedback: user's top-level verdict on the full plan.
--
-- Note: plan_tasks (from M1) is the user's manual task list.
-- plan_sessions/plan_blocks are the AI planner's structured output — separate concern.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.plan_session_status as enum ('draft', 'accepted', 'rejected', 'completed');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.plan_block_type as enum ('focus', 'admin', 'break', 'buffer');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.plan_block_completion_status as enum ('pending', 'completed', 'skipped');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.planning_window as enum ('1h', '2h', 'day', 'custom');
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- plan_sessions
-- ---------------------------------------------------------------------------

create table if not exists public.plan_sessions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  ai_run_id        uuid references public.ai_runs (id) on delete set null,
  planning_window  public.planning_window not null,
  -- custom_minutes is only relevant when planning_window = 'custom'
  custom_minutes   integer,
  scope            text,
  status           public.plan_session_status not null default 'draft',
  created_at       timestamptz not null default now()
);

create index if not exists plan_sessions_workspace_created_idx
  on public.plan_sessions (workspace_id, created_at desc);

-- ---------------------------------------------------------------------------
-- plan_blocks
-- ---------------------------------------------------------------------------

create table if not exists public.plan_blocks (
  id                 uuid primary key default gen_random_uuid(),
  plan_session_id    uuid not null references public.plan_sessions (id) on delete cascade,
  -- node_id is nullable: buffer/break blocks have no linked node
  node_id            uuid references public.nodes (id) on delete set null,
  title              text not null,
  -- start_offset: minutes from session start; drives display ordering
  start_offset       integer not null default 0,
  duration_minutes   integer not null,
  reason             text,
  block_type         public.plan_block_type not null,
  completion_status  public.plan_block_completion_status not null default 'pending'
);

create index if not exists plan_blocks_session_idx
  on public.plan_blocks (plan_session_id, start_offset);

-- ---------------------------------------------------------------------------
-- plan_feedback
-- ---------------------------------------------------------------------------

create table if not exists public.plan_feedback (
  id                 uuid primary key default gen_random_uuid(),
  plan_session_id    uuid not null references public.plan_sessions (id) on delete cascade,
  user_id            uuid not null references auth.users (id) on delete cascade,
  accepted           boolean not null default false,
  edited             boolean not null default false,
  rejected           boolean not null default false,
  completion_status  text,
  created_at         timestamptz not null default now()
);

-- One feedback row per session
create unique index if not exists plan_feedback_session_idx
  on public.plan_feedback (plan_session_id);

-- ---------------------------------------------------------------------------
-- RLS — plan_sessions
-- ---------------------------------------------------------------------------

alter table public.plan_sessions enable row level security;

drop policy if exists "plan_sessions_select_own" on public.plan_sessions;
create policy "plan_sessions_select_own"
  on public.plan_sessions for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "plan_sessions_insert_own" on public.plan_sessions;
create policy "plan_sessions_insert_own"
  on public.plan_sessions for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "plan_sessions_update_own" on public.plan_sessions;
create policy "plan_sessions_update_own"
  on public.plan_sessions for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "plan_sessions_delete_own" on public.plan_sessions;
create policy "plan_sessions_delete_own"
  on public.plan_sessions for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- RLS — plan_blocks (scoped via parent session's user_id)
-- ---------------------------------------------------------------------------

alter table public.plan_blocks enable row level security;

drop policy if exists "plan_blocks_select_own" on public.plan_blocks;
create policy "plan_blocks_select_own"
  on public.plan_blocks for select
  to authenticated
  using (
    exists (
      select 1 from public.plan_sessions
      where plan_sessions.id = plan_blocks.plan_session_id
        and plan_sessions.user_id = (select auth.uid())
    )
  );

drop policy if exists "plan_blocks_insert_own" on public.plan_blocks;
create policy "plan_blocks_insert_own"
  on public.plan_blocks for insert
  to authenticated
  with check (
    exists (
      select 1 from public.plan_sessions
      where plan_sessions.id = plan_blocks.plan_session_id
        and plan_sessions.user_id = (select auth.uid())
    )
  );

drop policy if exists "plan_blocks_update_own" on public.plan_blocks;
create policy "plan_blocks_update_own"
  on public.plan_blocks for update
  to authenticated
  using (
    exists (
      select 1 from public.plan_sessions
      where plan_sessions.id = plan_blocks.plan_session_id
        and plan_sessions.user_id = (select auth.uid())
    )
  );

drop policy if exists "plan_blocks_delete_own" on public.plan_blocks;
create policy "plan_blocks_delete_own"
  on public.plan_blocks for delete
  to authenticated
  using (
    exists (
      select 1 from public.plan_sessions
      where plan_sessions.id = plan_blocks.plan_session_id
        and plan_sessions.user_id = (select auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- RLS — plan_feedback
-- ---------------------------------------------------------------------------

alter table public.plan_feedback enable row level security;

drop policy if exists "plan_feedback_select_own" on public.plan_feedback;
create policy "plan_feedback_select_own"
  on public.plan_feedback for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "plan_feedback_insert_own" on public.plan_feedback;
create policy "plan_feedback_insert_own"
  on public.plan_feedback for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "plan_feedback_update_own" on public.plan_feedback;
create policy "plan_feedback_update_own"
  on public.plan_feedback for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
