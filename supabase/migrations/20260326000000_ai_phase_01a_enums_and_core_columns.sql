-- AI Phase 1A: Enums and core column additions to nodes and edges
-- Adds node_status, edge_status enums and the new columns required by the AI layer.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.node_status as enum ('active', 'completed', 'paused', 'archived');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.edge_status as enum ('active', 'decayed', 'orphaned', 'user_rejected');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.proposal_status as enum ('pending_review', 'accepted', 'rejected');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.raw_entry_status as enum ('pending', 'processing', 'completed', 'failed');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.raw_entry_source_type as enum ('brain_dump', 'assistant_save', 'voice', 'planner_convert');
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- nodes: new AI-phase columns
-- ---------------------------------------------------------------------------

alter table public.nodes
  add column if not exists status public.node_status not null default 'active',
  add column if not exists completed_at timestamptz,
  add column if not exists current_importance_score numeric;

-- Index: filter active nodes fast (most queries exclude completed/archived)
create index if not exists nodes_status_workspace_idx
  on public.nodes (workspace_id, status)
  where status = 'active';

-- ---------------------------------------------------------------------------
-- edges: new AI-phase columns
-- ---------------------------------------------------------------------------

alter table public.edges
  add column if not exists status public.edge_status not null default 'active',
  add column if not exists confidence numeric,
  add column if not exists explanation text,
  add column if not exists user_rejected boolean not null default false,
  add column if not exists user_confirmed boolean not null default false,
  add column if not exists updated_at timestamptz not null default now();

-- Index: hide orphaned/rejected edges cheaply
create index if not exists edges_status_workspace_idx
  on public.edges (workspace_id, status)
  where status = 'active';
