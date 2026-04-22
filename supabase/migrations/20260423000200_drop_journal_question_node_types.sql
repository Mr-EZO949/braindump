-- Drop journal + question node types.
-- These types were never high-leverage: questions live in chat (no persistent
-- node needed) and journals were rarely acted on. Ripping them out lets
-- heuristic scoring, planner candidate ranking, and the extractor prompt
-- shrink correspondingly. See src/types/graph.ts for the new NodeType union.
--
-- Existing rows of these types are permanently deleted (user decision — no
-- migration path to other types). FK cascades remove edges, embeddings, and
-- events that referenced them.

BEGIN;

-- Delete nodes of the dropped types. RLS isn't in play here (migration runs as
-- postgres); the workspace_id/user_id filters don't matter because we delete
-- every row of the dropped types across the database.
DELETE FROM nodes
WHERE node_type IN ('journal', 'question');

-- Tighten the CHECK constraint if one exists. The original column definition
-- used a free-form text column, so we emit a safe DROP+ADD guarded by
-- information_schema lookups.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'nodes_node_type_check'
  ) THEN
    ALTER TABLE nodes DROP CONSTRAINT nodes_node_type_check;
  END IF;

  ALTER TABLE nodes
    ADD CONSTRAINT nodes_node_type_check
    CHECK (node_type IN ('project','task','class','concept','idea','goal','habit'));
END$$;

COMMIT;
