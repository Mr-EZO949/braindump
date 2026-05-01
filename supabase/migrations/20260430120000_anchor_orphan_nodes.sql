-- Backfill: anchor existing orphan nodes to their workspace's bootstrap root.
--
-- Earlier dumps in workspaces created before the auto-anchor logic shipped
-- left subtree-roots (V7 climbing goal, OS course concept, etc.) and
-- standalone tasks (call mom, renew passport) floating with no belongs_to
-- edge to the workspace anchor. This one-shot fix walks every workspace
-- that has a bootstrap_root_node_id and inserts a belongs_to edge from
-- each parent-less, non-archived node to that root.
--
-- Idempotent — re-running adds no edges because the WHERE clause filters
-- by NOT EXISTS on the belongs_to edges that the previous run created.

insert into public.edges (
  user_id,
  workspace_id,
  source_node_id,
  target_node_id,
  edge_type,
  confidence,
  explanation,
  status,
  user_confirmed
)
select
  n.user_id,
  n.workspace_id,
  n.id,
  w.bootstrap_root_node_id,
  'belongs_to',
  0.8,
  'Auto-anchored to workspace.',
  'active',
  false
from public.nodes n
join public.workspaces w
  on w.id = n.workspace_id
where w.bootstrap_root_node_id is not null
  and n.id <> w.bootstrap_root_node_id
  and coalesce(n.status, 'active') <> 'archived'
  -- Skip if this node already has ANY belongs_to edge as source, regardless
  -- of status. The idx_edges_single_parent unique constraint is keyed on
  -- (source_node_id, edge_type) without a status filter, so even a stale
  -- inactive parent edge would block the insert with 23505.
  and not exists (
    select 1
    from public.edges e
    where e.source_node_id = n.id
      and e.edge_type = 'belongs_to'
  );
