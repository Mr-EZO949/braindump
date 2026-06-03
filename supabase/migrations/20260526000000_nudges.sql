-- nudges: AI-initiated reach-out messages
--
-- Lets BrainDump surface things to the user *without* them asking. The cron
-- generator scans the graph every few hours and writes new nudges with a
-- dedup_key so we never re-create an identical pending one. The in-app
-- ribbon reads pending nudges; later, web push reads new pending ones and
-- fires OS-level notifications.
--
-- Each kind has its own dedup_key shape, kept opaque from the DB:
--   stale:<node_id>
--   newly_ready:<node_id>:<unblocker_node_id>
--   due_soon:<node_id>:<target_date>
-- The cron only inserts when (user_id, dedup_key) has no pending/snoozed/seen
-- row newer than the cooldown window — handled in app code so we keep the
-- table dumb.

create type public.nudge_kind as enum (
  'stale',
  'newly_ready',
  'due_soon'
);

create type public.nudge_status as enum (
  'pending',
  'seen',
  'snoozed',
  'dismissed',
  'actioned'
);

create table if not exists public.nudges (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  node_id         uuid references public.nodes (id) on delete cascade,
  kind            public.nudge_kind not null,
  title           text not null,
  body            text not null,
  dedup_key       text not null,
  status          public.nudge_status not null default 'pending',
  snoozed_until   timestamptz,
  pushed_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists nudges_user_status_idx
  on public.nudges (user_id, status, created_at desc);
create index if not exists nudges_user_dedup_idx
  on public.nudges (user_id, dedup_key, created_at desc);
create index if not exists nudges_pending_push_idx
  on public.nudges (user_id, status, pushed_at)
  where status = 'pending' and pushed_at is null;

alter table public.nudges enable row level security;

drop policy if exists "nudges_select_own" on public.nudges;
create policy "nudges_select_own"
  on public.nudges for select
  using (auth.uid() = user_id);

drop policy if exists "nudges_update_own" on public.nudges;
create policy "nudges_update_own"
  on public.nudges for update
  using (auth.uid() = user_id);

-- Inserts come from the service-role cron, not from end users. No insert
-- policy → blocked for the anon/auth role, allowed for service role
-- (bypasses RLS by design).


-- push_subscriptions: web-push opt-ins, one row per (user, endpoint).
-- The PushSubscription object the browser hands us has keys p256dh + auth
-- which the push server needs to encrypt the payload. We store them as-is.
create table if not exists public.push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  endpoint        text not null,
  p256dh          text not null,
  auth            text not null,
  user_agent      text,
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  unique (user_id, endpoint)
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists "push_subs_select_own" on public.push_subscriptions;
create policy "push_subs_select_own"
  on public.push_subscriptions for select
  using (auth.uid() = user_id);

drop policy if exists "push_subs_insert_own" on public.push_subscriptions;
create policy "push_subs_insert_own"
  on public.push_subscriptions for insert
  with check (auth.uid() = user_id);

drop policy if exists "push_subs_update_own" on public.push_subscriptions;
create policy "push_subs_update_own"
  on public.push_subscriptions for update
  using (auth.uid() = user_id);

drop policy if exists "push_subs_delete_own" on public.push_subscriptions;
create policy "push_subs_delete_own"
  on public.push_subscriptions for delete
  using (auth.uid() = user_id);
