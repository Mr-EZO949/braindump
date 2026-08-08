-- Public sharing: a workspace (graph) can be published read-only at /p/<slug>.
--
-- The public-read policies below are ADDITIVE to the existing owner policies
-- (Postgres combines permissive policies with OR), so nothing is exposed until
-- a user sets is_public = true on their own workspace. Default is false.

alter table public.workspaces
  add column if not exists is_public boolean not null default false,
  add column if not exists public_slug text,
  add column if not exists shared_at timestamptz;

create unique index if not exists workspaces_public_slug_key
  on public.workspaces (public_slug)
  where public_slug is not null;

comment on column public.workspaces.is_public is
  'When true, the workspace is readable by anon at /p/<public_slug>.';
comment on column public.workspaces.public_slug is
  'Stable URL slug for the public reading view. Kept even after unpublishing so '
  're-sharing reuses the same link.';

-- ── Public read policies ────────────────────────────────────────────────────
-- anon (logged-out visitors + crawlers) and authenticated users may read a
-- workspace and its nodes/edges only while is_public = true.

drop policy if exists "workspaces_select_public" on public.workspaces;
create policy "workspaces_select_public"
  on public.workspaces
  for select
  to anon, authenticated
  using (is_public = true);

drop policy if exists "nodes_select_public" on public.nodes;
create policy "nodes_select_public"
  on public.nodes
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.workspaces w
      where w.id = nodes.workspace_id
        and w.is_public = true
    )
  );

drop policy if exists "edges_select_public" on public.edges;
create policy "edges_select_public"
  on public.edges
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.workspaces w
      where w.id = edges.workspace_id
        and w.is_public = true
    )
  );
