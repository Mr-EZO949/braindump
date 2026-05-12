-- weekly_reflections: cache the AI commentary per (user, workspace, week)
-- so opening the modal multiple times in the same week doesn't burn Haiku
-- calls and doesn't show a different reflection each time. Stats are still
-- recomputed live every request — only the AI message is persisted.
--
-- week_start is the Monday of the ISO week, in local date form. We don't
-- store stats here on purpose; if we cached stats too, the user would see
-- a stale snapshot on Friday for a reflection generated on Tuesday.

create table if not exists public.weekly_reflections (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  week_start    date not null,
  commentary    text not null,
  stats_at_generation jsonb,
  generated_at  timestamptz not null default now(),
  unique (user_id, workspace_id, week_start)
);

alter table public.weekly_reflections enable row level security;

create policy "users manage own weekly reflections"
  on public.weekly_reflections for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists weekly_reflections_user_workspace_idx
  on public.weekly_reflections (user_id, workspace_id, week_start desc);
