create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

alter table public.nodes
add column if not exists workspace_id uuid references public.workspaces (id) on delete cascade;

alter table public.edges
add column if not exists workspace_id uuid references public.workspaces (id) on delete cascade;

insert into public.workspaces (user_id, name)
select distinct user_id, 'Personal'
from public.nodes
on conflict (user_id, name) do nothing;

insert into public.workspaces (user_id, name)
select distinct user_id, 'General'
from public.nodes
on conflict (user_id, name) do nothing;

insert into public.workspaces (user_id, name)
select distinct user_id, 'Personal'
from public.edges
on conflict (user_id, name) do nothing;

insert into public.workspaces (user_id, name)
select distinct user_id, 'General'
from public.edges
on conflict (user_id, name) do nothing;

update public.nodes as nodes
set workspace_id = workspaces.id
from public.workspaces as workspaces
where nodes.workspace_id is null
  and workspaces.user_id = nodes.user_id
  and workspaces.name = 'Personal';

update public.edges as edges
set workspace_id = workspaces.id
from public.workspaces as workspaces
where edges.workspace_id is null
  and workspaces.user_id = edges.user_id
  and workspaces.name = 'Personal';

create index if not exists workspaces_user_id_idx
  on public.workspaces (user_id);

create index if not exists nodes_user_id_workspace_id_idx
  on public.nodes (user_id, workspace_id);

create index if not exists edges_user_id_workspace_id_idx
  on public.edges (user_id, workspace_id);
