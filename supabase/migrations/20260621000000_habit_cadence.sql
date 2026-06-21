-- Habit cadence — how often the user wants to do a habit.
--
-- One nullable column on nodes: completions desired per ISO week (1–7).
--   7 = daily, 3 = "3× a week", 1 = weekly, null = no cadence (untracked).
-- Only meaningful when node_type = 'habit'. Additive + nullable: existing
-- habits read as "no cadence" and behave exactly as before.
--
-- Drives the planner's CADENCE_DUE boost (src/lib/ai/planner.ts): a daily habit
-- not done today, or an N/week habit behind pace this week, is surfaced in Focus.
alter table public.nodes
  add column if not exists habit_target_per_week smallint;

alter table public.nodes
  drop constraint if exists nodes_habit_target_per_week_range;
alter table public.nodes
  add constraint nodes_habit_target_per_week_range
  check (habit_target_per_week is null or (habit_target_per_week between 1 and 7));

comment on column public.nodes.habit_target_per_week is
  'Cadence target for habit nodes: completions desired per ISO week (1–7). 7 = daily. Null = no cadence. Only meaningful when node_type = habit.';
