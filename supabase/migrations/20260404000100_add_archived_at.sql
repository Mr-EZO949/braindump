-- Phase 14: node retention timestamps
-- Adds archived_at for accurate expiry tracking on archived nodes.
-- The cleanup cron (api/cron/node-cleanup) uses this + completed_at to purge
-- stale nodes after the configured retention window.

alter table public.nodes
  add column if not exists archived_at timestamptz;

-- Backfill: nodes already archived get updated_at as a conservative estimate.
-- This means they start their 30-day clock from when they were last touched,
-- which is always <= the actual archive time — safe to use as a lower bound.
update public.nodes
set archived_at = updated_at
where status = 'archived' and archived_at is null;

comment on column public.nodes.archived_at is
  'Set when status transitions to archived. Cleared on unarchive. '
  'Used by the nightly cleanup job to purge nodes past their retention window.';
