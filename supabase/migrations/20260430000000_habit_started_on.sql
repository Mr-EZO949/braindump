-- Per-habit "started_on" date.
--
-- Lets the user mark when they began a habit so streak %, total, and
-- "missed" math is anchored to the day they intended to start — not the
-- entire history of the planet. Days BEFORE started_on aren't counted as
-- missed in the percentage; they render muted in the calendar.
--
-- Nullable: when null, falls back to the earliest habit_completion (or
-- treats every fetched day as in-window). UI exposes a date picker on the
-- habit card.

alter table public.nodes
  add column if not exists habit_started_on date;

comment on column public.nodes.habit_started_on is
  'Optional per-habit anchor. Stats and "missed" treatment count from this day forward. Null means use earliest completion as implicit start.';
