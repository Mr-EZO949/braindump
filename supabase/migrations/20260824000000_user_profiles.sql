-- User-level "about you" identity — captured once at sign-up and reused across
-- EVERY workspace's AI context. Distinct from the per-workspace profile
-- (workspaces.profile_payload / profile_role / profile_summary), which holds
-- workspace-specific role/focus/goals that legitimately differ per workspace.
--
-- One row per user, keyed by auth.users.id. RLS: a user reads/writes only their
-- own row. The row is created lazily on first PATCH (upsert), not at sign-up —
-- so a null/absent row simply means "intake not done yet".

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  occupation text,
  paralysis_triggers text,
  working_hours text,
  deadline_cadence text,
  -- Set when the user finishes OR explicitly skips the first-run intake, so the
  -- gate never re-fires. Null = intake not yet answered.
  intake_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'User-level "about you" identity captured at sign-up and injected into every workspace AI context.';
comment on column public.profiles.paralysis_triggers is
  'Free-text: what tends to make the user freeze / procrastinate. Read by the assistant to tailor unblocking.';
comment on column public.profiles.working_hours is
  'Free-text: typical working hours / energy pattern. Read by the planner for realistic time-blocking.';
comment on column public.profiles.deadline_cadence is
  'Free-text: how the user relates to deadlines (procrastinate-then-sprint vs steady). Milder planner signal.';
comment on column public.profiles.intake_completed_at is
  'Set when the user finishes or skips the first-run intake. Null = intake not yet answered.';

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
