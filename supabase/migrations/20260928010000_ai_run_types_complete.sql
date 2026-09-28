-- Complete the ai_run_type enum so every AI call can be cost-logged.
--
-- 'node_judgment' and 'rerank_importance' were added to the TypeScript type
-- but never to the enum, so those inserts failed silently: judgment spend was
-- never logged, and the daily rerank_importance cap (which counts those rows)
-- was never enforced. 'auxiliary' covers the small Haiku helpers (dump/size
-- classifiers, duration estimates, suggested steps, cluster naming, areas,
-- weekly reflection) that previously ran unlogged.

alter type public.ai_run_type add value if not exists 'node_judgment';
alter type public.ai_run_type add value if not exists 'rerank_importance';
alter type public.ai_run_type add value if not exists 'auxiliary';
