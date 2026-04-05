-- AI Phase 11: merge_suggestions table
-- Stores AI-verified duplicate candidates so users can review, dismiss, or merge them.
-- Persisting suggestions enables:
--   - "never suggest this pair again" semantics
--   - audit trail of merges
--   - ranking signal (accepted merges improve future extraction quality)

-- ---------------------------------------------------------------------------
-- Enum
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.merge_suggestion_status as enum ('pending', 'dismissed', 'merged', 'never');
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table if not exists public.merge_suggestions (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces (id) on delete cascade,
  user_id             uuid not null references auth.users (id) on delete cascade,
  -- The newly added node that triggered the suggestion
  new_node_id         uuid not null references public.nodes (id) on delete cascade,
  -- The existing node that looks like a duplicate
  existing_node_id    uuid not null references public.nodes (id) on delete cascade,
  -- Raw embedding cosine similarity (0–1)
  similarity          real not null,
  -- AI merge-check fields (null if AI check was skipped / disabled)
  ai_confidence       real,
  ai_reason           text,
  -- User verdict
  status              public.merge_suggestion_status not null default 'pending',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Prevent duplicate pending suggestions for the same pair
create unique index if not exists merge_suggestions_pair_workspace_idx
  on public.merge_suggestions (workspace_id, new_node_id, existing_node_id)
  where status = 'pending';

create index if not exists merge_suggestions_workspace_status_idx
  on public.merge_suggestions (workspace_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.merge_suggestions enable row level security;

drop policy if exists "merge_suggestions_select_own" on public.merge_suggestions;
create policy "merge_suggestions_select_own"
  on public.merge_suggestions for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "merge_suggestions_insert_own" on public.merge_suggestions;
create policy "merge_suggestions_insert_own"
  on public.merge_suggestions for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "merge_suggestions_update_own" on public.merge_suggestions;
create policy "merge_suggestions_update_own"
  on public.merge_suggestions for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "merge_suggestions_delete_own" on public.merge_suggestions;
create policy "merge_suggestions_delete_own"
  on public.merge_suggestions for delete
  to authenticated
  using ((select auth.uid()) = user_id);
