alter table public.workspaces enable row level security;
alter table public.nodes enable row level security;
alter table public.edges enable row level security;

drop policy if exists "workspaces_select_own" on public.workspaces;
create policy "workspaces_select_own"
  on public.workspaces
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "workspaces_insert_own" on public.workspaces;
create policy "workspaces_insert_own"
  on public.workspaces
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "workspaces_update_own" on public.workspaces;
create policy "workspaces_update_own"
  on public.workspaces
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "workspaces_delete_own" on public.workspaces;
create policy "workspaces_delete_own"
  on public.workspaces
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "nodes_select_own" on public.nodes;
create policy "nodes_select_own"
  on public.nodes
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "nodes_insert_own" on public.nodes;
create policy "nodes_insert_own"
  on public.nodes
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "nodes_update_own" on public.nodes;
create policy "nodes_update_own"
  on public.nodes
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "nodes_delete_own" on public.nodes;
create policy "nodes_delete_own"
  on public.nodes
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "edges_select_own" on public.edges;
create policy "edges_select_own"
  on public.edges
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "edges_insert_own" on public.edges;
create policy "edges_insert_own"
  on public.edges
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "edges_update_own" on public.edges;
create policy "edges_update_own"
  on public.edges
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "edges_delete_own" on public.edges;
create policy "edges_delete_own"
  on public.edges
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);
