-- AI Phase 1B: feedback_events, node_scores, edge_scores
-- feedback_events: append-only log of every user review action.
-- node_scores / edge_scores: computed ranking signals written by the scoring service.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.feedback_event_type as enum (
    'accept_node', 'reject_node', 'reject_edge', 'confirm_edge',
    'edit_plan', 'dismiss_merge',
    'complete_node', 'reopen_node', 'archive_node',
    'boost_node', 'demote_node'
  );
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- feedback_events
-- ---------------------------------------------------------------------------

create table if not exists public.feedback_events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete set null,
  event_type   public.feedback_event_type not null,
  entity_type  text not null,   -- 'node' | 'edge' | 'plan' | 'merge_suggestion'
  entity_id    uuid not null,
  metadata     jsonb,
  created_at   timestamptz not null default now()
);

-- Index: replay feedback for a specific entity
create index if not exists feedback_events_entity_idx
  on public.feedback_events (entity_type, entity_id);

-- Index: user activity timeline
create index if not exists feedback_events_user_created_idx
  on public.feedback_events (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- node_scores
-- ---------------------------------------------------------------------------

create table if not exists public.node_scores (
  id                       uuid primary key default gen_random_uuid(),
  node_id                  uuid not null references public.nodes (id) on delete cascade,
  score_version            text not null,
  urgency_score            numeric not null default 0,
  goal_alignment_score     numeric not null default 0,
  planner_score            numeric not null default 0,
  recency_score            numeric not null default 0,
  graph_centrality_score   numeric not null default 0,
  user_confirmation_score  numeric not null default 0,
  ai_prior_score           numeric not null default 0,
  blocker_resolved_bonus   numeric not null default 0,
  final_score              numeric not null default 0,
  computed_at              timestamptz not null default now()
);

-- Only one score row per node per version; upsert logic will use this
create unique index if not exists node_scores_node_version_idx
  on public.node_scores (node_id, score_version);

-- Index: fetch top-scored nodes per workspace via node join
create index if not exists node_scores_final_score_idx
  on public.node_scores (final_score desc);

-- ---------------------------------------------------------------------------
-- edge_scores
-- ---------------------------------------------------------------------------

create table if not exists public.edge_scores (
  id                 uuid primary key default gen_random_uuid(),
  edge_id            uuid not null references public.edges (id) on delete cascade,
  confidence         numeric not null default 0,
  confirmation_count integer not null default 0,
  rejection_count    integer not null default 0,
  stale              boolean not null default false,
  decay_factor       numeric not null default 1.0
    check (decay_factor >= 0.0 and decay_factor <= 1.0),
  final_weight       numeric not null default 0
);

-- One score row per edge
create unique index if not exists edge_scores_edge_idx
  on public.edge_scores (edge_id);

-- ---------------------------------------------------------------------------
-- RLS — feedback_events
-- ---------------------------------------------------------------------------

alter table public.feedback_events enable row level security;

drop policy if exists "feedback_events_select_own" on public.feedback_events;
create policy "feedback_events_select_own"
  on public.feedback_events for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "feedback_events_insert_own" on public.feedback_events;
create policy "feedback_events_insert_own"
  on public.feedback_events for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- feedback_events is append-only: no update or delete policies intentionally.

-- ---------------------------------------------------------------------------
-- RLS — node_scores
-- Scoped via the parent node's user_id to avoid adding a redundant user_id column.
-- ---------------------------------------------------------------------------

alter table public.node_scores enable row level security;

drop policy if exists "node_scores_select_own" on public.node_scores;
create policy "node_scores_select_own"
  on public.node_scores for select
  to authenticated
  using (
    exists (
      select 1 from public.nodes
      where nodes.id = node_scores.node_id
        and nodes.user_id = (select auth.uid())
    )
  );

drop policy if exists "node_scores_insert_own" on public.node_scores;
create policy "node_scores_insert_own"
  on public.node_scores for insert
  to authenticated
  with check (
    exists (
      select 1 from public.nodes
      where nodes.id = node_scores.node_id
        and nodes.user_id = (select auth.uid())
    )
  );

drop policy if exists "node_scores_update_own" on public.node_scores;
create policy "node_scores_update_own"
  on public.node_scores for update
  to authenticated
  using (
    exists (
      select 1 from public.nodes
      where nodes.id = node_scores.node_id
        and nodes.user_id = (select auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- RLS — edge_scores
-- Scoped via the parent edge's user_id.
-- ---------------------------------------------------------------------------

alter table public.edge_scores enable row level security;

drop policy if exists "edge_scores_select_own" on public.edge_scores;
create policy "edge_scores_select_own"
  on public.edge_scores for select
  to authenticated
  using (
    exists (
      select 1 from public.edges
      where edges.id = edge_scores.edge_id
        and edges.user_id = (select auth.uid())
    )
  );

drop policy if exists "edge_scores_insert_own" on public.edge_scores;
create policy "edge_scores_insert_own"
  on public.edge_scores for insert
  to authenticated
  with check (
    exists (
      select 1 from public.edges
      where edges.id = edge_scores.edge_id
        and edges.user_id = (select auth.uid())
    )
  );

drop policy if exists "edge_scores_update_own" on public.edge_scores;
create policy "edge_scores_update_own"
  on public.edge_scores for update
  to authenticated
  using (
    exists (
      select 1 from public.edges
      where edges.id = edge_scores.edge_id
        and edges.user_id = (select auth.uid())
    )
  );
