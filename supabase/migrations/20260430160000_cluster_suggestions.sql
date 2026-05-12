-- Retroactive clustering: an embeddings-based pass that proposes umbrella
-- parents for groups of loosely-connected nodes, surfaced in the same
-- review modal as extraction proposals.
--
-- cluster_suggestions: one row per umbrella suggestion. Stores the proposed
-- title/type and the list of child node ids. signature_hash is a
-- deterministic hash of the sorted child ids — used to dedupe against
-- dismissed_clusters so we never propose the same set twice.
--
-- dismissed_clusters: when the user rejects a cluster, we remember the
-- signature so subsequent passes skip it. Without this, every dump would
-- re-propose the same "Job Search" group the user already said no to.

create table if not exists public.cluster_suggestions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  suggested_title   text not null,
  suggested_node_type text not null,
  child_node_ids    uuid[] not null,
  signature_hash    text not null,
  proposal_status   text not null default 'pending_review'
    check (proposal_status in ('pending_review', 'accepted', 'dismissed')),
  created_at        timestamptz not null default now(),
  decided_at        timestamptz
);

alter table public.cluster_suggestions enable row level security;

create policy "users manage own cluster suggestions"
  on public.cluster_suggestions for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists cluster_suggestions_pending_idx
  on public.cluster_suggestions (user_id, workspace_id, proposal_status)
  where proposal_status = 'pending_review';

create table if not exists public.dismissed_clusters (
  user_id        uuid not null references auth.users (id) on delete cascade,
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  signature_hash text not null,
  dismissed_at   timestamptz not null default now(),
  primary key (user_id, workspace_id, signature_hash)
);

alter table public.dismissed_clusters enable row level security;

create policy "users manage own dismissed clusters"
  on public.dismissed_clusters for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
