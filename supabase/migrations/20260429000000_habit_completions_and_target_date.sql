-- Two productivity primitives layered on top of the graph:
-- 1. habit_completions — one row per (habit node, date) the user marked done.
--    Streaks are computed by walking back consecutive days from today.
-- 2. nodes.target_date — optional deadline column for goal/project nodes.
--    Drives the "big picture" view that filters & groups deadlined nodes.

create table if not exists public.habit_completions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  node_id       uuid not null references public.nodes (id) on delete cascade,
  -- Stored as a date (no time). The (node_id, completed_on) unique constraint
  -- makes inserts idempotent — toggling a habit on then toggling again
  -- cleanly inserts/deletes one row per day.
  completed_on  date not null,
  -- Tracks how the row was created so we can avoid double-counting when a
  -- linked plan_task auto-cascades. 'manual' = user tapped the habit node.
  -- 'plan_task' = auto-cascaded from a checked-off plan_tasks row.
  source        text not null default 'manual'
    check (source in ('manual', 'plan_task')),
  created_at    timestamptz not null default now(),
  unique (node_id, completed_on)
);

create index if not exists habit_completions_node_date_idx
  on public.habit_completions (node_id, completed_on desc);

create index if not exists habit_completions_user_idx
  on public.habit_completions (user_id, completed_on desc);

alter table public.habit_completions enable row level security;

drop policy if exists "habit_completions_select_own" on public.habit_completions;
create policy "habit_completions_select_own"
  on public.habit_completions for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "habit_completions_insert_own" on public.habit_completions;
create policy "habit_completions_insert_own"
  on public.habit_completions for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "habit_completions_delete_own" on public.habit_completions;
create policy "habit_completions_delete_own"
  on public.habit_completions for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ── nodes.target_date ──────────────────────────────────────────────────────
-- Optional deadline for goal/project nodes. Drives the big-picture roadmap
-- view — nodes without a target_date stay in the "always-on" graph and
-- aren't surfaced in the deadline-grouped lens.
alter table public.nodes
  add column if not exists target_date date;

create index if not exists nodes_target_date_idx
  on public.nodes (workspace_id, user_id, target_date)
  where target_date is not null;

-- Mirror the new column on proposed_nodes so the extraction prompt can
-- capture deadlines from natural-language brain dumps without losing them
-- when the user reviews + accepts the proposal.
alter table public.proposed_nodes
  add column if not exists proposed_target_date date;
