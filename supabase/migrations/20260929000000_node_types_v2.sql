-- Node types v2 (docs/node-types.md): add big_task, area and note; concept is
-- retired (split into area for groupings and note for knowledge); the
-- workspace root is an area, never a goal.
--
-- Deploy order: apply this BEFORE the build that writes the new types reaches
-- production. 'concept' stays allowed for now so a still-deployed older build
-- keeps working in the meantime; a follow-up migration drops it once no row
-- uses it.

BEGIN;

-- 1. Allow the new types.
ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_node_type_check;
ALTER TABLE nodes
  ADD CONSTRAINT nodes_node_type_check
  CHECK (node_type IN (
    'goal', 'project', 'big_task', 'task', 'habit',
    'area', 'class', 'idea', 'note',
    'concept' -- legacy, see header
  ));

-- 2. Deterministic backfill. Old graphs don't convert one-to-one (a vague
-- "goal" can't be told from a real outcome without a model), so this only
-- fixes what the structure already proves; new dumps get the new types.

-- 2a. Workspace roots are areas.
UPDATE nodes n
SET node_type = 'area'
FROM workspaces w
WHERE w.bootstrap_root_node_id = n.id
  AND n.node_type = 'goal';

-- 2b. A concept that holds children was a grouping → area; the rest were
-- knowledge (topics, people, advice) → note.
UPDATE nodes n
SET node_type = CASE
  WHEN EXISTS (
    SELECT 1 FROM edges e
    WHERE e.target_node_id = n.id
      AND e.edge_type = 'belongs_to'
      AND e.status IS DISTINCT FROM 'user_rejected'
  ) THEN 'area'
  ELSE 'note'
END
WHERE n.node_type = 'concept';

-- 2c. A task that already has work under it is a big task.
UPDATE nodes n
SET node_type = 'big_task'
WHERE n.node_type = 'task'
  AND EXISTS (
    SELECT 1
    FROM edges e
    JOIN nodes c ON c.id = e.source_node_id
    WHERE e.target_node_id = n.id
      AND e.edge_type = 'belongs_to'
      AND e.status IS DISTINCT FROM 'user_rejected'
      AND c.node_type IN ('task', 'big_task', 'habit')
  );

-- 3. Keep it that way: when a task gains a child step (task / big task /
-- habit — a note or idea hanging under it doesn't count), it becomes a big
-- task. Runs for every write path (review accept, auto-apply, chat, manual
-- edges). SECURITY DEFINER so it works under RLS; it only touches the edge
-- owner's own node.
CREATE OR REPLACE FUNCTION public.promote_task_with_children()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.edge_type = 'belongs_to' AND NEW.status IS DISTINCT FROM 'user_rejected' THEN
    UPDATE nodes p
    SET node_type = 'big_task'
    WHERE p.id = NEW.target_node_id
      AND p.user_id = NEW.user_id
      AND p.node_type = 'task'
      AND EXISTS (
        SELECT 1 FROM nodes c
        WHERE c.id = NEW.source_node_id
          AND c.node_type IN ('task', 'big_task', 'habit')
      );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS edges_promote_task_with_children ON edges;
CREATE TRIGGER edges_promote_task_with_children
  AFTER INSERT OR UPDATE OF edge_type, target_node_id, status ON edges
  FOR EACH ROW
  EXECUTE FUNCTION public.promote_task_with_children();

COMMIT;
