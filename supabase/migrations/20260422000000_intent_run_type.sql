-- Add 'intent' to the ai_run_type enum so the unified command bar's
-- intent-router calls can be logged alongside every other AI run.
-- alter type ... add value is not transactional on older Postgres, so the
-- statement runs on its own.

alter type public.ai_run_type add value if not exists 'intent';
