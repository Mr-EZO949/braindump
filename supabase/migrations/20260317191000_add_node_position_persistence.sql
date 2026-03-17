alter table public.nodes
add column if not exists position_x double precision;

alter table public.nodes
add column if not exists position_y double precision;

alter table public.nodes
add column if not exists manual_position boolean not null default false;

create index if not exists nodes_user_id_workspace_id_manual_position_idx
  on public.nodes (user_id, workspace_id, manual_position);
