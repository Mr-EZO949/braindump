-- Prompt-cache tokens per AI run (owner 2026-10-06: per-user spend drill-down,
-- /app/observability/users/[userId]). input_tokens stays EVERY input token
-- the model saw; these say how many of them came from the cache (billed at
-- 0.1×) and how many were written to it (1.25× for 5 minutes, 2× for an
-- hour). Null = not reported (older rows, Cohere, embeddings). Cost is still
-- estimated_cost, priced from the same numbers (lib/ai/usage.ts).

alter table public.ai_runs
  add column if not exists cache_read_tokens  integer,
  add column if not exists cache_write_tokens integer;
