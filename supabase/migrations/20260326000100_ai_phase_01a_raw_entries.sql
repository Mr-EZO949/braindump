-- AI Phase 1A: raw_entries table
-- Stores unprocessed text dumps before AI extraction runs.
-- Processing status tracks the pipeline state per entry.

create table if not exists public.raw_entries (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  raw_text       text not null,
  source_type    public.raw_entry_source_type not null,
  status         public.raw_entry_status not null default 'pending',
  error_message  text,
  retry_count    integer not null default 0,
  created_at     timestamptz not null default now()
);

-- Index: poll pending entries per workspace efficiently
create index if not exists raw_entries_workspace_status_idx
  on public.raw_entries (workspace_id, status);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.raw_entries enable row level security;

drop policy if exists "raw_entries_select_own" on public.raw_entries;
create policy "raw_entries_select_own"
  on public.raw_entries for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "raw_entries_insert_own" on public.raw_entries;
create policy "raw_entries_insert_own"
  on public.raw_entries for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "raw_entries_update_own" on public.raw_entries;
create policy "raw_entries_update_own"
  on public.raw_entries for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "raw_entries_delete_own" on public.raw_entries;
create policy "raw_entries_delete_own"
  on public.raw_entries for delete
  to authenticated
  using ((select auth.uid()) = user_id);
