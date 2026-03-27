-- AI Phase 1C: Lifecycle tracking tables
-- lifecycle_events: immutable log of every node status transition.
-- cascade_results: records what the cascade engine did downstream of each transition.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.lifecycle_action as enum (
    'score_recomputed', 'edge_decayed', 'unblocked', 'suggested_archive'
  );
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- lifecycle_events
-- ---------------------------------------------------------------------------

create table if not exists public.lifecycle_events (
  id                uuid primary key default gen_random_uuid(),
  node_id           uuid not null references public.nodes (id) on delete cascade,
  user_id           uuid not null references auth.users (id) on delete cascade,
  previous_status   public.node_status not null,
  new_status        public.node_status not null,
  cascade_triggered boolean not null default false,
  created_at        timestamptz not null default now()
);

-- Index: fetch transition history for a node
create index if not exists lifecycle_events_node_idx
  on public.lifecycle_events (node_id, created_at desc);

-- Index: find all events that triggered cascades (for the cascade processor)
create index if not exists lifecycle_events_cascade_idx
  on public.lifecycle_events (cascade_triggered, created_at desc)
  where cascade_triggered = true;

-- ---------------------------------------------------------------------------
-- cascade_results
-- ---------------------------------------------------------------------------

create table if not exists public.cascade_results (
  id                   uuid primary key default gen_random_uuid(),
  lifecycle_event_id   uuid not null references public.lifecycle_events (id) on delete cascade,
  affected_node_id     uuid not null references public.nodes (id) on delete cascade,
  action_taken         public.lifecycle_action not null,
  details              jsonb
);

create index if not exists cascade_results_event_idx
  on public.cascade_results (lifecycle_event_id);

create index if not exists cascade_results_node_idx
  on public.cascade_results (affected_node_id);

-- ---------------------------------------------------------------------------
-- RLS — lifecycle_events
-- ---------------------------------------------------------------------------

alter table public.lifecycle_events enable row level security;

drop policy if exists "lifecycle_events_select_own" on public.lifecycle_events;
create policy "lifecycle_events_select_own"
  on public.lifecycle_events for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "lifecycle_events_insert_own" on public.lifecycle_events;
create policy "lifecycle_events_insert_own"
  on public.lifecycle_events for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- lifecycle_events is append-only: no update or delete policies intentionally.

-- ---------------------------------------------------------------------------
-- RLS — cascade_results (scoped via parent lifecycle_event's user_id)
-- ---------------------------------------------------------------------------

alter table public.cascade_results enable row level security;

drop policy if exists "cascade_results_select_own" on public.cascade_results;
create policy "cascade_results_select_own"
  on public.cascade_results for select
  to authenticated
  using (
    exists (
      select 1 from public.lifecycle_events
      where lifecycle_events.id = cascade_results.lifecycle_event_id
        and lifecycle_events.user_id = (select auth.uid())
    )
  );

drop policy if exists "cascade_results_insert_own" on public.cascade_results;
create policy "cascade_results_insert_own"
  on public.cascade_results for insert
  to authenticated
  with check (
    exists (
      select 1 from public.lifecycle_events
      where lifecycle_events.id = cascade_results.lifecycle_event_id
        and lifecycle_events.user_id = (select auth.uid())
    )
  );
