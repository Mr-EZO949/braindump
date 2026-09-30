-- Fixed commitments (docs/commitments.md): the weekly times the user is not
-- free — a class every weekday at 14:00, a Tuesday shift, Thursday practice.
-- Filled from chat (set_commitments) and dumps; read as busy time by Focus,
-- What Now's "Schedule these" and the AI planner.
--
-- Times are the user's local wall-clock times. days are ISO weekdays
-- (1 = Mon … 7 = Sun). starts_on / ends_on bound the weekly repeat ("until
-- Dec 20"); null = open-ended. Busy time is read per USER, not per workspace
-- — a class blocks the afternoon whichever workspace is open. workspace_id
-- records where it was added (and the linked node's home).

create table if not exists public.commitments (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  node_id       uuid references public.nodes (id) on delete set null,
  title         text not null check (char_length(title) between 1 and 120),
  days          smallint[] not null
    check (cardinality(days) between 1 and 7 and days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  start_time    time not null,
  end_time      time not null,
  starts_on     date,
  ends_on       date,
  source        text not null default 'chat' check (source in ('chat', 'dump', 'manual', 'import')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (end_time > start_time),
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);

alter table public.commitments enable row level security;

drop policy if exists "users manage own commitments" on public.commitments;
create policy "users manage own commitments"
  on public.commitments for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists commitments_user_idx
  on public.commitments (user_id, ends_on);

create index if not exists commitments_node_idx
  on public.commitments (node_id)
  where node_id is not null;

comment on table public.commitments is
  'Weekly fixed commitments (class, shift, practice) — busy time for Focus and the planner. Local wall-clock times; ISO weekdays.';
