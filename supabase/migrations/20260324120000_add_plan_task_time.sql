alter table public.plan_tasks
  add column if not exists start_time time,
  add column if not exists duration_minutes integer;
