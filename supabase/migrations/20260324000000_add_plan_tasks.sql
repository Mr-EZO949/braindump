create table if not exists public.plan_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  title text not null,
  done boolean not null default false,
  scheduled_date date,
  created_at timestamptz not null default now()
);

alter table public.plan_tasks enable row level security;

create policy "users manage own plan tasks"
  on public.plan_tasks for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists plan_tasks_user_workspace_idx
  on public.plan_tasks (user_id, workspace_id);

create index if not exists plan_tasks_scheduled_date_idx
  on public.plan_tasks (user_id, scheduled_date);
