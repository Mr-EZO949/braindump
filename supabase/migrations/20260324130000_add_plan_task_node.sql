alter table public.plan_tasks
  add column if not exists node_id uuid references public.nodes(id) on delete set null;
