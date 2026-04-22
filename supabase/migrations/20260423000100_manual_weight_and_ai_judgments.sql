-- Importance ranking: manual override + AI judgment layer
--
-- manual_weight: user-set explicit importance (0-100). When NOT NULL, overrides
-- the heuristic formula in computeWorkspaceScores. User's final authority.
--
-- ai_node_judgments: per-node LLM-judged importance with reasoning text. Fired
-- event-driven (new node, explicit rerank, focus shift) — never on a timer.
-- Feeds into the scoring formula as `ai_judgment_score` signal.

-- ---------------------------------------------------------------------------
-- 1. manual_weight override on nodes
-- ---------------------------------------------------------------------------

alter table public.nodes
  add column if not exists manual_weight integer
    check (manual_weight is null or (manual_weight >= 0 and manual_weight <= 100));

alter table public.nodes
  add column if not exists manual_weight_set_at timestamptz;

comment on column public.nodes.manual_weight is
  'User-set explicit importance (0-100). When NOT NULL, bypasses the heuristic formula. NULL means "let the scorer decide".';

-- ---------------------------------------------------------------------------
-- 2. ai_node_judgments — LLM-judged importance per node
-- ---------------------------------------------------------------------------

create table if not exists public.ai_node_judgments (
  id            uuid primary key default gen_random_uuid(),
  node_id       uuid not null references public.nodes (id) on delete cascade,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  score         numeric not null check (score >= 0 and score <= 100),
  reason        text,
  model_name    text not null,
  computed_at   timestamptz not null default now()
);

-- Latest-per-node lookup: the scorer only reads the most recent judgment.
create index if not exists ai_node_judgments_node_computed_idx
  on public.ai_node_judgments (node_id, computed_at desc);

create index if not exists ai_node_judgments_workspace_idx
  on public.ai_node_judgments (workspace_id);

-- RLS
alter table public.ai_node_judgments enable row level security;

drop policy if exists "ai_node_judgments_select_own" on public.ai_node_judgments;
create policy "ai_node_judgments_select_own"
  on public.ai_node_judgments for select
  using (auth.uid() = user_id);

drop policy if exists "ai_node_judgments_insert_own" on public.ai_node_judgments;
create policy "ai_node_judgments_insert_own"
  on public.ai_node_judgments for insert
  with check (auth.uid() = user_id);

drop policy if exists "ai_node_judgments_delete_own" on public.ai_node_judgments;
create policy "ai_node_judgments_delete_own"
  on public.ai_node_judgments for delete
  using (auth.uid() = user_id);
