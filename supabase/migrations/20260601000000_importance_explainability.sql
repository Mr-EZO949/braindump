-- importance_reason + importance_top_signals on nodes
--
-- Surfaces the "why is this ranked here?" signals so the importance badge
-- can render a tooltip without an extra round-trip to ai_node_judgments +
-- node_scores. These are denormalized at score-compute time.
--
-- importance_reason: one short sentence from the AI judgment (≤120 chars).
-- importance_top_signals: 1-3 signal names ranked by weighted contribution
--   to the final score, e.g. ['urgency','goal_alignment','ai_judgment'].

alter table public.nodes
  add column if not exists importance_reason text;

alter table public.nodes
  add column if not exists importance_top_signals text[] not null default '{}';
