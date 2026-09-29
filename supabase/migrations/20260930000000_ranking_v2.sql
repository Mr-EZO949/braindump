-- Ranking v2 (docs/ranking.md): stakes, "waiting for …" holds, and the
-- feedback events that record them.
--
-- stakes: how much rides on a node, set from chat ("I need this for my
--   masters" → 1, "it's pass/fail" → -1). Null = normal. Inherited by
--   descendants in scoring; shapes deadline pressure and semantic weight.
-- waiting_for / resume_on: a paused node the user is waiting on ("exam
--   result", check back 2026-10-20). Paused nodes shrink and leave Focus; on
--   resume_on the node returns to Focus as "Check back: …". Cleared when the
--   node leaves paused.

alter table public.nodes
  add column if not exists stakes smallint
    check (stakes is null or stakes between -1 and 1);

alter table public.nodes
  add column if not exists waiting_for text
    check (waiting_for is null or char_length(waiting_for) <= 140);

alter table public.nodes
  add column if not exists resume_on date;

comment on column public.nodes.stakes is
  'Ranking v2: -1 low, null normal, 1 high. Set from chat/UI; inherited by descendants in scoring.';
comment on column public.nodes.waiting_for is
  'Ranking v2: what a paused node is waiting on ("exam result"). Cleared when the node leaves paused.';
comment on column public.nodes.resume_on is
  'Ranking v2: check-back date for a paused node; from this day it returns to Focus.';

-- Per-signal breakdown for v9 scores (pressure, stakes, steering, hold, …).
-- Diagnostics only — the legacy numeric columns keep their v8 meaning where
-- a v9 signal maps onto them.
alter table public.node_scores
  add column if not exists signals jsonb;

-- Every review action logs a feedback event (AGENTS.md rule 11).
alter type public.feedback_event_type add value if not exists 'set_stakes';
alter type public.feedback_event_type add value if not exists 'hold_node';
alter type public.feedback_event_type add value if not exists 'set_deadline';
