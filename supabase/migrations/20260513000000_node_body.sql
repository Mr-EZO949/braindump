-- nodes.body + proposed_nodes.proposed_body
--
-- `summary` answers "what is this node" in 1–2 sentences. `body` answers
-- the next three questions: "so what?", "why does it matter?", and "what
-- should be done?" Together they replace the previous vague-card problem
-- where a node title + summary read like "Stripe Online Assessment — OA
-- coming this weekend" with no context on why it's pinned to your graph
-- or what your next move is.
--
-- AI extraction fills proposed_body during the standard pipeline; the
-- field is nullable so existing rows and minimal-context proposals stay
-- valid. Cap is enforced at the prompt + validation layer (~400 chars);
-- no DB-level length constraint so manually-edited bodies can be longer
-- when the user wants.

alter table public.nodes
  add column if not exists body text;

alter table public.proposed_nodes
  add column if not exists proposed_body text;
