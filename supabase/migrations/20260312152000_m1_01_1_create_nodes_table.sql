create table if not exists public.nodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  summary text,
  raw_text text,
  node_type text not null,
  importance text not null,
  color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
