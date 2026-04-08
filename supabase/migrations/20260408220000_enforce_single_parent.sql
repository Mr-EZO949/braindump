-- Enforce single belongs_to parent per node.
-- First, deduplicate: keep one belongs_to edge per source node, orphan the rest.
-- Uses row_number to pick exactly one winner (oldest, with id as tiebreaker).
UPDATE edges
SET status = 'orphaned', updated_at = now()
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           row_number() OVER (PARTITION BY source_node_id ORDER BY created_at ASC, id ASC) AS rn
    FROM edges
    WHERE edge_type = 'belongs_to'
      AND status IS DISTINCT FROM 'orphaned'
      AND status IS DISTINCT FROM 'user_rejected'
  ) ranked
  WHERE rn > 1
);

-- Now create the unique partial index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_single_parent
  ON edges (source_node_id)
  WHERE edge_type = 'belongs_to'
    AND status IS DISTINCT FROM 'orphaned'
    AND status IS DISTINCT FROM 'user_rejected';
