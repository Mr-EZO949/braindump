"use client";

import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from "d3-force";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import type {
  ForceLink,
  Simulation,
  SimulationLinkDatum,
  SimulationNodeDatum,
} from "d3-force";

import type { Edge, EdgeType, GraphData, Node, NodeType } from "@/types/graph";

type GraphCanvasProps = {
  focusNodeId: string | null;
  graphData: GraphData;
  loading: boolean;
  onSelectNode: (nodeId: string | null) => void;
  searchQuery: string;
};

type ViewState = {
  panX: number;
  panY: number;
  zoom: number;
};

type ViewTarget = {
  panX: number;
  panY: number;
  zoom: number;
};

type PointerPoint = {
  x: number;
  y: number;
};

type VisualTier = "root" | "anchor" | "body" | "leaf";

type LabelLayout = {
  fontSize: number;
  height: number;
  lines: string[];
  width: number;
};

type GraphNode = Node &
  SimulationNodeDatum &
  LabelLayout & {
    categoryColor: string;
    depth: number;
    driftAmplitudeX: number;
    driftAmplitudeY: number;
    driftPhaseX: number;
    driftPhaseY: number;
    restX: number;
    restY: number;
    visualTier: VisualTier;
  };

type GraphLink = Edge &
  SimulationLinkDatum<GraphNode> & {
    curvature: number;
    directional: boolean;
    family: "structural" | "semantic";
    primary: boolean;
    strength: number;
  };

type DragState = {
  nodeId: string;
  offsetX: number;
  offsetY: number;
};

type PanState = {
  originPanX: number;
  originPanY: number;
  startPointerX: number;
  startPointerY: number;
};

type EdgeVisualStyle = {
  dashArray?: string;
  markerEnd?: string;
  opacity: number;
  stroke: string;
  strokeWidth: number;
};

const nodeTypeCueMap: Record<NodeType, string> = {
  goal: "#d8d0c4",
  project: "#8a5965",
  task: "#9f5d49",
  class: "#a78347",
  concept: "#537670",
  idea: "#6d5364",
  journal: "#7e858d",
  question: "#8d78af",
};

const nodeTypeBranchOrder: Record<NodeType, number> = {
  goal: 0,
  concept: 1,
  project: 2,
  idea: 3,
  class: 4,
  journal: 5,
  question: 6,
  task: 7,
};

const tierMetrics: Record<
  VisualTier,
  {
    baseHeight: number;
    fontSize: number;
    maxCharsPerLine: number;
    maxWidth: number;
    minWidth: number;
    padX: number;
  }
> = {
  root: {
    baseHeight: 118,
    fontSize: 18,
    maxCharsPerLine: 12,
    maxWidth: 188,
    minWidth: 150,
    padX: 24,
  },
  anchor: {
    baseHeight: 96,
    fontSize: 15.5,
    maxCharsPerLine: 12,
    maxWidth: 170,
    minWidth: 126,
    padX: 20,
  },
  body: {
    baseHeight: 74,
    fontSize: 13.5,
    maxCharsPerLine: 12,
    maxWidth: 146,
    minWidth: 104,
    padX: 18,
  },
  leaf: {
    baseHeight: 54,
    fontSize: 12,
    maxCharsPerLine: 11,
    maxWidth: 120,
    minWidth: 86,
    padX: 14,
  },
};

const edgeStrengthMap: Record<EdgeType, number> = {
  belongs_to: 1,
  required_for: 0.88,
  prerequisite_for: 0.72,
  supports: 0.56,
  useful_for: 0.44,
  blocks: 0.66,
  inspired_by: 0.34,
  related_to: 0.24,
};

const nodeTypeScore: Record<NodeType, number> = {
  goal: 8,
  project: 6,
  concept: 5,
  class: 4,
  idea: 3,
  question: 3,
  journal: 2,
  task: 1,
};

const defaultView: ViewState = {
  panX: 0,
  panY: 0,
  zoom: 1,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function lerp(start: number, end: number, progress: number) {
  return start + (end - start) * progress;
}

function easeOutCubic(progress: number) {
  return 1 - Math.pow(1 - progress, 3);
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function hashString(input: string) {
  let hash = 0;

  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }

  return hash;
}

function importanceRank(importance: Node["importance"]) {
  return importance === "high" ? 3 : importance === "medium" ? 2 : 1;
}

function trimLine(line: string, maxLength: number) {
  if (line.length <= maxLength) {
    return line;
  }

  return `${line.slice(0, Math.max(maxLength - 1, 1)).trimEnd()}...`;
}

function wrapTitle(title: string, maxCharsPerLine: number) {
  const words = title.split(" ").filter(Boolean);

  if (words.length <= 1) {
    return [trimLine(title, maxCharsPerLine)];
  }

  const lines: string[] = [];
  let currentLine = "";

  words.forEach((word) => {
    const candidate = currentLine.length === 0 ? word : `${currentLine} ${word}`;

    if (candidate.length <= maxCharsPerLine || currentLine.length === 0) {
      currentLine = candidate;
      return;
    }

    if (lines.length === 0) {
      lines.push(currentLine);
      currentLine = word;
      return;
    }

    currentLine = `${currentLine} ${word}`;
  });

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  if (lines.length === 1) {
    return [trimLine(lines[0], maxCharsPerLine)];
  }

  return [
    trimLine(lines[0], maxCharsPerLine),
    trimLine(lines.slice(1).join(" "), maxCharsPerLine + 2),
  ];
}

function getPrimaryParentCandidate(edge: Edge) {
  switch (edge.edge_type) {
    case "belongs_to":
      return {
        childId: edge.source_node_id,
        parentId: edge.target_node_id,
        priority: 100,
      };
    case "required_for":
      return {
        childId: edge.target_node_id,
        parentId: edge.source_node_id,
        priority: 70,
      };
    case "prerequisite_for":
      return {
        childId: edge.target_node_id,
        parentId: edge.source_node_id,
        priority: 60,
      };
    default:
      return null;
  }
}

function buildAdjacency(graphData: GraphData) {
  const adjacency = new Map<string, Set<string>>();

  graphData.nodes.forEach((node) => {
    adjacency.set(node.id, new Set<string>());
  });

  graphData.edges.forEach((edge) => {
    adjacency.get(edge.source_node_id)?.add(edge.target_node_id);
    adjacency.get(edge.target_node_id)?.add(edge.source_node_id);
  });

  return adjacency;
}

function getConnectedComponents(graphData: GraphData) {
  const adjacency = buildAdjacency(graphData);
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const node of graphData.nodes) {
    if (visited.has(node.id)) {
      continue;
    }

    const stack = [node.id];
    const component: string[] = [];
    visited.add(node.id);

    while (stack.length > 0) {
      const nodeId = stack.pop();

      if (!nodeId) {
        continue;
      }

      component.push(nodeId);

      adjacency.get(nodeId)?.forEach((neighborId) => {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          stack.push(neighborId);
        }
      });
    }

    components.push(component);
  }

  return components;
}

function getAnchorScore(node: Node, childCount: number) {
  return importanceRank(node.importance) * 10 + nodeTypeScore[node.node_type] + childCount * 2.4;
}

function getVisualTier(node: Node, hasParent: boolean, childCount: number) {
  if (!hasParent && node.importance === "high") {
    return "root" satisfies VisualTier;
  }

  if (node.importance === "high" || childCount >= 2) {
    return "anchor" satisfies VisualTier;
  }

  if (node.importance === "medium") {
    return "body" satisfies VisualTier;
  }

  return "leaf" satisfies VisualTier;
}

function createNodeLayout(node: Node, visualTier: VisualTier) {
  const metrics = tierMetrics[visualTier];
  const lines = wrapTitle(node.title, metrics.maxCharsPerLine);
  const longestLineLength = lines.reduce(
    (longest, line) => Math.max(longest, line.length),
    0,
  );
  const width = clamp(
    longestLineLength * metrics.fontSize * 0.56 + metrics.padX * 2,
    metrics.minWidth,
    metrics.maxWidth,
  );
  const hash = hashString(node.id);

  return {
    categoryColor: nodeTypeCueMap[node.node_type],
    depth: 0,
    driftAmplitudeX:
      visualTier === "root" ? 0.6 : visualTier === "anchor" ? 0.9 : visualTier === "body" ? 1.3 : 1.7,
    driftAmplitudeY:
      visualTier === "root" ? 0.5 : visualTier === "anchor" ? 0.8 : visualTier === "body" ? 1.1 : 1.5,
    driftPhaseX: (hash % 360) * (Math.PI / 180),
    driftPhaseY: ((hash >> 5) % 360) * (Math.PI / 180),
    fontSize: metrics.fontSize,
    height: metrics.baseHeight,
    lines,
    restX: 0,
    restY: 0,
    visualTier,
    width,
    x: 0,
    y: 0,
  } satisfies Omit<GraphNode, keyof Node>;
}

function getVerticalOffset(depth: number, componentIndex: number) {
  const firstGap = componentIndex === 0 ? 238 : 204;
  const laterGap = componentIndex === 0 ? 184 : 158;

  if (depth === 0) {
    return 0;
  }

  return firstGap + (depth - 1) * laterGap;
}

function getTreeBounds(nodes: GraphNode[]) {
  if (nodes.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  nodes.forEach((node) => {
    minX = Math.min(minX, node.restX - node.width / 2);
    maxX = Math.max(maxX, node.restX + node.width / 2);
    minY = Math.min(minY, node.restY - node.height / 2);
    maxY = Math.max(maxY, node.restY + node.height / 2);
  });

  return { minX, minY, maxX, maxY };
}

function buildGraphLayout(graphData: GraphData) {
  const nodesById = new Map(graphData.nodes.map((node) => [node.id, node]));
  const parentCandidates = new Map<string, { parentId: string; priority: number }>();

  graphData.edges.forEach((edge) => {
    const candidate = getPrimaryParentCandidate(edge);

    if (!candidate) {
      return;
    }

    const current = parentCandidates.get(candidate.childId);

    if (!current || candidate.priority > current.priority) {
      parentCandidates.set(candidate.childId, {
        parentId: candidate.parentId,
        priority: candidate.priority,
      });
    }
  });

  const childrenByParent = new Map<string, string[]>();

  graphData.nodes.forEach((node) => {
    childrenByParent.set(node.id, []);
  });

  parentCandidates.forEach(({ parentId }, childId) => {
    const children = childrenByParent.get(parentId) ?? [];
    children.push(childId);
    childrenByParent.set(parentId, children);
  });

  const laidOutNodes: GraphNode[] = graphData.nodes.map((node) => {
    const childCount = childrenByParent.get(node.id)?.length ?? 0;
    const hasParent = parentCandidates.has(node.id);
    const visualTier = getVisualTier(node, hasParent, childCount);

    return {
      ...node,
      ...createNodeLayout(node, visualTier),
    };
  });

  const laidOutNodeMap = new Map(laidOutNodes.map((node) => [node.id, node]));
  const components = getConnectedComponents(graphData);
  const sortedComponents = [...components].sort((componentA, componentB) => {
    const scoreA = Math.max(
      ...componentA.map((nodeId) => {
        const node = nodesById.get(nodeId);
        return node
          ? getAnchorScore(node, childrenByParent.get(nodeId)?.length ?? 0)
          : 0;
      }),
    );
    const scoreB = Math.max(
      ...componentB.map((nodeId) => {
        const node = nodesById.get(nodeId);
        return node
          ? getAnchorScore(node, childrenByParent.get(nodeId)?.length ?? 0)
          : 0;
      }),
    );

    return scoreB - scoreA || componentB.length - componentA.length;
  });

  const componentOffsets = [
    { x: 0, y: -470 },
    { x: -540, y: 118 },
    { x: 560, y: 152 },
    { x: -760, y: 330 },
    { x: 780, y: 330 },
  ];

  sortedComponents.forEach((component, componentIndex) => {
    const componentSet = new Set(component);
    const roots = component
      .filter((nodeId) => {
        const parentId = parentCandidates.get(nodeId)?.parentId;
        return !parentId || !componentSet.has(parentId);
      })
      .sort((nodeIdA, nodeIdB) => {
        const nodeA = nodesById.get(nodeIdA);
        const nodeB = nodesById.get(nodeIdB);
        const scoreA = nodeA
          ? getAnchorScore(nodeA, childrenByParent.get(nodeIdA)?.length ?? 0)
          : 0;
        const scoreB = nodeB
          ? getAnchorScore(nodeB, childrenByParent.get(nodeIdB)?.length ?? 0)
          : 0;
        return scoreB - scoreA;
      });

    const normalizedRoots = roots.length > 0 ? roots : [component[0]];
    const horizontalGap = componentIndex === 0 ? 22 : 18;
    const subtreeWidthCache = new Map<string, number>();

    const getSortedChildren = (parentId: string) =>
      (childrenByParent.get(parentId) ?? [])
        .filter((childId) => componentSet.has(childId))
        .sort((childIdA, childIdB) => {
          const nodeA = nodesById.get(childIdA);
          const nodeB = nodesById.get(childIdB);
          const scoreA = nodeA
            ? getAnchorScore(nodeA, childrenByParent.get(childIdA)?.length ?? 0)
            : 0;
          const scoreB = nodeB
            ? getAnchorScore(nodeB, childrenByParent.get(childIdB)?.length ?? 0)
            : 0;
          const branchOrderA = nodeA ? nodeTypeBranchOrder[nodeA.node_type] : 99;
          const branchOrderB = nodeB ? nodeTypeBranchOrder[nodeB.node_type] : 99;
          return (
            branchOrderA - branchOrderB ||
            scoreB - scoreA ||
            childIdA.localeCompare(childIdB)
          );
        });

    const computeSubtreeWidth = (nodeId: string): number => {
      const cachedWidth = subtreeWidthCache.get(nodeId);

      if (cachedWidth) {
        return cachedWidth;
      }

      const node = laidOutNodeMap.get(nodeId);

      if (!node) {
        return 0;
      }

      const children = getSortedChildren(nodeId);

      if (children.length === 0) {
        const width = node.width + 16;
        subtreeWidthCache.set(nodeId, width);
        return width;
      }

      const childrenWidth = children.reduce((totalWidth, childId, childIndex) => {
        const nextWidth = computeSubtreeWidth(childId);
        return totalWidth + nextWidth + (childIndex === 0 ? 0 : horizontalGap);
      }, 0);
      const width = Math.max(node.width + 20, childrenWidth);
      subtreeWidthCache.set(nodeId, width);
      return width;
    };

    const placeNode = (nodeId: string, leftEdge: number, depth: number) => {
      const node = laidOutNodeMap.get(nodeId);

      if (!node) {
        return;
      }

      const subtreeWidth = computeSubtreeWidth(nodeId);
      node.depth = depth;
      node.restX = leftEdge + subtreeWidth / 2;
      node.restY = getVerticalOffset(depth, componentIndex);
      node.x = node.restX;
      node.y = node.restY;

      const children = getSortedChildren(nodeId);

      if (children.length === 0) {
        return;
      }

      const totalChildrenWidth = children.reduce((totalWidth, childId, childIndex) => {
        return (
          totalWidth +
          computeSubtreeWidth(childId) +
          (childIndex === 0 ? 0 : horizontalGap)
        );
      }, 0);
      let childLeftEdge = node.restX - totalChildrenWidth / 2;

      children.forEach((childId, childIndex) => {
        if (childIndex > 0) {
          childLeftEdge += horizontalGap;
        }

        placeNode(childId, childLeftEdge, depth + 1);
        childLeftEdge += computeSubtreeWidth(childId);
      });
    };

    const totalRootWidth = normalizedRoots.reduce((totalWidth, rootId, rootIndex) => {
      return totalWidth + computeSubtreeWidth(rootId) + (rootIndex === 0 ? 0 : 58);
    }, 0);
    let rootLeftEdge = -totalRootWidth / 2;

    normalizedRoots.forEach((rootId, rootIndex) => {
      if (rootIndex > 0) {
        rootLeftEdge += 58;
      }

      placeNode(rootId, rootLeftEdge, 0);
      rootLeftEdge += computeSubtreeWidth(rootId);
    });

    const componentNodes = component
      .map((nodeId) => laidOutNodeMap.get(nodeId))
      .filter(isDefined);
    const bounds = getTreeBounds(componentNodes);
    const componentOffset =
      componentOffsets[componentIndex] ?? {
        x: (componentIndex % 2 === 0 ? 1 : -1) * (560 + componentIndex * 44),
        y: 210 + componentIndex * 110,
      };
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const shiftX = componentOffset.x - centerX;
    const shiftY = componentOffset.y - bounds.minY;

    componentNodes.forEach((node) => {
      node.restX += shiftX;
      node.restY += shiftY;
      node.x = node.restX;
      node.y = node.restY;
    });
  });

  const structuralParentPairs = new Set(
    graphData.edges
      .filter((edge) => edge.edge_type === "belongs_to")
      .map((edge) => `${edge.source_node_id}:${edge.target_node_id}`),
  );

  const laidOutLinks: GraphLink[] = graphData.edges.map((edge) => {
    const hash = hashString(edge.id);
    const family =
      edge.edge_type === "belongs_to" ||
      edge.edge_type === "prerequisite_for" ||
      edge.edge_type === "required_for"
        ? "structural"
        : "semantic";
    const directional =
      edge.edge_type === "belongs_to" ||
      edge.edge_type === "prerequisite_for" ||
      edge.edge_type === "required_for";
    const primary = structuralParentPairs.has(
      `${edge.source_node_id}:${edge.target_node_id}`,
    );
    const curvature =
      edge.edge_type === "belongs_to"
        ? ((hash % 2 === 0 ? 1 : -1) * 0.04)
        : edge.edge_type === "required_for"
          ? ((hash % 2 === 0 ? 1 : -1) * 0.14)
          : edge.edge_type === "prerequisite_for"
            ? ((hash % 2 === 0 ? 1 : -1) * 0.18)
            : ((hash % 2 === 0 ? 1 : -1) * 0.22);

    return {
      ...edge,
      curvature,
      directional,
      family,
      primary,
      source: edge.source_node_id,
      strength: edgeStrengthMap[edge.edge_type],
      target: edge.target_node_id,
    };
  });

  return {
    links: laidOutLinks,
    nodes: laidOutNodes,
  };
}

function getGraphBounds(nodes: GraphNode[]) {
  if (nodes.length === 0) {
    return {
      centerX: 0,
      centerY: 0,
      height: 0,
      width: 0,
    };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  nodes.forEach((node) => {
    const x = node.x ?? node.restX;
    const y = node.y ?? node.restY;
    minX = Math.min(minX, x - node.width / 2);
    maxX = Math.max(maxX, x + node.width / 2);
    minY = Math.min(minY, y - node.height / 2);
    maxY = Math.max(maxY, y + node.height / 2);
  });

  return {
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    height: maxY - minY,
    width: maxX - minX,
  };
}

function createFittedView(nodes: GraphNode[], width: number, height: number): ViewState {
  if (width === 0 || height === 0 || nodes.length === 0) {
    return defaultView;
  }

  const bounds = getGraphBounds(nodes);
  const usableWidth = Math.max(width - 120, 360);
  const usableHeight = Math.max(height - 150, 340);
  const zoom = clamp(
    Math.min(usableWidth / Math.max(bounds.width, 1), usableHeight / Math.max(bounds.height, 1)),
    0.68,
    1.06,
  );
  const targetX = width * 0.46;
  const targetY = height * 0.34;

  return {
    panX: targetX - width / 2 - bounds.centerX * zoom,
    panY: targetY - height / 2 - bounds.centerY * zoom,
    zoom,
  };
}

function getWorldPoint(
  point: PointerPoint,
  viewport: { width: number; height: number },
  view: ViewState,
) {
  return {
    x: (point.x - viewport.width / 2 - view.panX) / view.zoom,
    y: (point.y - viewport.height / 2 - view.panY) / view.zoom,
  };
}

function getRenderedNodePosition(
  node: GraphNode,
  idleTime: number,
  draggingNodeId: string | null,
) {
  const baseX = node.x ?? node.restX;
  const baseY = node.y ?? node.restY;

  if (draggingNodeId === node.id) {
    return { x: baseX, y: baseY };
  }

  const driftX = Math.sin(idleTime * 0.00038 + node.driftPhaseX) * node.driftAmplitudeX;
  const driftY = Math.cos(idleTime * 0.00031 + node.driftPhaseY) * node.driftAmplitudeY;

  return {
    x: baseX + driftX,
    y: baseY + driftY,
  };
}

function getLinkEndpoints(
  link: GraphLink,
  idleTime: number,
  draggingNodeId: string | null,
) {
  const source = link.source as GraphNode;
  const target = link.target as GraphNode;
  const sourcePosition = getRenderedNodePosition(source, idleTime, draggingNodeId);
  const targetPosition = getRenderedNodePosition(target, idleTime, draggingNodeId);
  if (link.family === "structural") {
    const startX = sourcePosition.x;
    const startY = sourcePosition.y + source.height / 2 - 5;
    const endX = targetPosition.x;
    const endY = targetPosition.y - target.height / 2 + 5;
    const verticalSpan = Math.max(endY - startY, 44);
    const bend = clamp((endX - startX) * 0.16, -42, 42);
    const controlOffset = clamp(
      verticalSpan * (link.edge_type === "belongs_to" ? 0.42 : 0.36),
      32,
      104,
    );

    return {
      controlX: startX + bend * 0.28,
      controlX2: endX - bend * 0.58,
      controlY: startY + controlOffset,
      controlY2: endY - controlOffset * 0.74,
      endX,
      endY,
      startX,
      startY,
    };
  }

  const dx = targetPosition.x - sourcePosition.x;
  const dy = targetPosition.y - sourcePosition.y;
  const distance = Math.max(Math.hypot(dx, dy), 1);
  const directionX = dx / distance;
  const directionY = dy / distance;
  const normalX = -dy / distance;
  const normalY = dx / distance;
  const sourceInsetX = source.width * 0.24;
  const targetInsetX = target.width * 0.24;
  const sourceInsetY = source.height * 0.2;
  const targetInsetY = target.height * 0.2;
  const startX = sourcePosition.x + directionX * sourceInsetX + normalX * 5;
  const startY = sourcePosition.y + directionY * sourceInsetY;
  const endX = targetPosition.x - directionX * targetInsetX;
  const endY = targetPosition.y - directionY * targetInsetY;

  return {
    controlX:
      (startX + endX) / 2 +
      normalX * Math.min(84, Math.max(24, distance * 0.18)) * link.curvature,
    controlX2: undefined,
    controlY:
      (startY + endY) / 2 +
      normalY * Math.min(84, Math.max(24, distance * 0.18)) * link.curvature,
    controlY2: undefined,
    endX,
    endY,
    startX,
    startY,
  };
}

function getLinkPath(link: GraphLink, idleTime: number, draggingNodeId: string | null) {
  const { controlX, controlX2, controlY, controlY2, endX, endY, startX, startY } =
    getLinkEndpoints(
    link,
    idleTime,
    draggingNodeId,
  );

  if (link.family === "structural" && isDefined(controlX2) && isDefined(controlY2)) {
    return `M ${startX} ${startY} C ${controlX} ${controlY} ${controlX2} ${controlY2} ${endX} ${endY}`;
  }

  return `M ${startX} ${startY} Q ${controlX} ${controlY} ${endX} ${endY}`;
}

function getInteractionSets(graphData: GraphData, nodeId: string | null) {
  const connectedNodes = new Set<string>();
  const connectedEdges = new Set<string>();

  if (!nodeId) {
    return { connectedEdges, connectedNodes };
  }

  connectedNodes.add(nodeId);

  graphData.edges.forEach((edge) => {
    if (edge.source_node_id !== nodeId && edge.target_node_id !== nodeId) {
      return;
    }

    connectedEdges.add(edge.id);
    connectedNodes.add(edge.source_node_id);
    connectedNodes.add(edge.target_node_id);
  });

  return { connectedEdges, connectedNodes };
}

function getEdgeVisualStyle(
  link: GraphLink,
  emphasized: boolean,
  dimmed: boolean,
): EdgeVisualStyle {
  const structural = link.family === "structural";
  const directional = link.directional;

  let opacity = 0.12;
  let strokeWidth = 0.85;
  let stroke = structural ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.12)";
  let dashArray: string | undefined;
  let markerEnd: string | undefined;

  switch (link.edge_type) {
    case "belongs_to":
      opacity = 0.4;
      strokeWidth = 1.8 + link.strength * 1.1;
      stroke = "rgba(255,255,255,0.26)";
      break;
    case "required_for":
      opacity = 0.32;
      strokeWidth = 1.55 + link.strength * 0.95;
      stroke = "rgba(255,255,255,0.22)";
      dashArray = "10 7";
      break;
    case "prerequisite_for":
      opacity = 0.24;
      strokeWidth = 1.18 + link.strength * 0.74;
      stroke = "rgba(255,255,255,0.185)";
      dashArray = "7 7";
      break;
    case "supports":
      opacity = 0.14;
      strokeWidth = 0.92 + link.strength * 0.54;
      stroke = "rgba(255,255,255,0.135)";
      break;
    case "related_to":
      opacity = 0.055;
      strokeWidth = 0.62 + link.strength * 0.34;
      stroke = "rgba(255,255,255,0.08)";
      break;
    case "useful_for":
      opacity = 0.11;
      strokeWidth = 0.78 + link.strength * 0.42;
      stroke = "rgba(255,255,255,0.112)";
      break;
    case "blocks":
      opacity = 0.18;
      strokeWidth = 1.02 + link.strength * 0.58;
      stroke = "rgba(255,255,255,0.155)";
      dashArray = "4 5";
      break;
    case "inspired_by":
      opacity = 0.08;
      strokeWidth = 0.68 + link.strength * 0.28;
      stroke = "rgba(255,255,255,0.092)";
      dashArray = "2 7";
      break;
  }

  if (emphasized) {
    opacity = clamp(opacity * 2.25 + 0.12, 0, 0.96);
    strokeWidth += structural ? 1.05 : 0.7;
    stroke = structural ? "rgba(214,68,82,0.86)" : "rgba(214,68,82,0.58)";
  }

  if (dimmed) {
    opacity *= structural ? 0.24 : 0.16;
    strokeWidth *= structural ? 0.82 : 0.76;
    stroke = structural ? "rgba(255,255,255,0.068)" : "rgba(255,255,255,0.048)";
  }

  if (directional) {
    markerEnd = emphasized ? "url(#edge-arrow-emphasis)" : "url(#edge-arrow-structural)";
  }

  return {
    dashArray,
    markerEnd,
    opacity,
    stroke,
    strokeWidth,
  };
}

function getNodeVisualState(options: {
  hovered: boolean;
  inHoveredNeighborhood: boolean;
  inSelectedNeighborhood: boolean;
  searchHit: boolean;
  selected: boolean;
  selectedNodeId: string | null;
}) {
  const {
    hovered,
    inHoveredNeighborhood,
    inSelectedNeighborhood,
    searchHit,
    selected,
    selectedNodeId,
  } = options;

  if (selected) {
    return {
      border: "rgba(223,69,83,0.96)",
      cueOpacity: 0.94,
      glowOpacity: 0.5,
      heatOpacity: 0.72,
      opacity: 1,
      shadowOpacity: 0.42,
      text: "#f6f2ed",
      topSheenOpacity: 0.66,
    };
  }

  if (hovered) {
    return {
      border: "rgba(220,67,81,0.58)",
      cueOpacity: 0.82,
      glowOpacity: 0.26,
      heatOpacity: 0.34,
      opacity: 1,
      shadowOpacity: 0.34,
      text: "#f1ece6",
      topSheenOpacity: 0.58,
    };
  }

  if (selectedNodeId && !inSelectedNeighborhood) {
    return {
      border: "rgba(255,255,255,0.034)",
      cueOpacity: 0.36,
      glowOpacity: 0,
      heatOpacity: 0,
      opacity: 0.24,
      shadowOpacity: 0.14,
      text: "rgba(242,239,233,0.46)",
      topSheenOpacity: 0.28,
    };
  }

  if (inSelectedNeighborhood) {
    return {
      border: "rgba(255,255,255,0.11)",
      cueOpacity: 0.68,
      glowOpacity: 0.05,
      heatOpacity: 0.05,
      opacity: 0.96,
      shadowOpacity: 0.28,
      text: "#efeae3",
      topSheenOpacity: 0.54,
    };
  }

  if (inHoveredNeighborhood) {
    return {
      border: "rgba(255,255,255,0.095)",
      cueOpacity: 0.6,
      glowOpacity: 0.03,
      heatOpacity: 0.04,
      opacity: 0.88,
      shadowOpacity: 0.26,
      text: "#ece7e1",
      topSheenOpacity: 0.5,
    };
  }

  if (searchHit) {
    return {
      border: "rgba(223,68,82,0.42)",
      cueOpacity: 0.76,
      glowOpacity: 0.12,
      heatOpacity: 0.12,
      opacity: 0.94,
      shadowOpacity: 0.28,
      text: "#f0ece6",
      topSheenOpacity: 0.54,
    };
  }

  return {
    border: "rgba(255,255,255,0.072)",
    cueOpacity: 0.58,
    glowOpacity: 0,
    heatOpacity: 0,
    opacity: 0.84,
    shadowOpacity: 0.24,
    text: "#e8e2db",
    topSheenOpacity: 0.46,
  };
}

function updateAmbientGlow(
  element: HTMLDivElement | null,
  clientX: number,
  clientY: number,
  opacity: number,
) {
  if (!element) {
    return;
  }

  const bounds = element.getBoundingClientRect();
  element.style.setProperty("--graph-cursor-x", `${clientX - bounds.left}px`);
  element.style.setProperty("--graph-cursor-y", `${clientY - bounds.top}px`);
  element.style.setProperty("--graph-cursor-opacity", `${opacity}`);
}

export function GraphCanvas({
  focusNodeId,
  graphData,
  loading,
  onSelectNode,
  searchQuery,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const simulationRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);
  const animationRef = useRef<number | null>(null);
  const releaseTimeoutRef = useRef<number | null>(null);
  const viewAnimationRef = useRef<number | null>(null);
  const nodesRef = useRef<GraphNode[]>([]);
  const dragStateRef = useRef<DragState | null>(null);
  const panStateRef = useRef<PanState | null>(null);
  const viewRef = useRef<ViewState>(defaultView);
  const viewportRef = useRef({ height: 0, width: 0 });
  const movedDuringPointerRef = useRef(false);
  const didFitInitialViewRef = useRef(false);
  const [viewport, setViewport] = useState({ height: 0, width: 0 });
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [idleTime, setIdleTime] = useState(0);
  const [view, setView] = useState<ViewState>(defaultView);
  const [, setFrameVersion] = useState(0);
  const scene = useMemo(() => {
    const nextLayout = buildGraphLayout(graphData);
    const nodeMap = new Map(nextLayout.nodes.map((node) => [node.id, node]));

    return {
      links: nextLayout.links.map((link) => ({
        ...link,
        source: nodeMap.get(link.source_node_id) ?? link.source_node_id,
        target: nodeMap.get(link.target_node_id) ?? link.target_node_id,
      })),
      nodes: nextLayout.nodes,
    };
  }, [graphData]);

  const searchMatches = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();

    if (!normalizedQuery) {
      return new Set<string>();
    }

    return new Set(
      graphData.nodes
        .filter((node) => node.title.toLowerCase().includes(normalizedQuery))
        .map((node) => node.id),
    );
  }, [graphData.nodes, searchQuery]);

  const selectedInteraction = useMemo(
    () => getInteractionSets(graphData, focusNodeId),
    [focusNodeId, graphData],
  );
  const hoveredInteraction = useMemo(
    () => getInteractionSets(graphData, hoveredNodeId),
    [graphData, hoveredNodeId],
  );

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    let animationHandle = 0;
    let lastFrameTime = 0;

    const animate = (now: number) => {
      if (now - lastFrameTime >= 46) {
        lastFrameTime = now;
        setIdleTime(now);
      }

      animationHandle = window.requestAnimationFrame(animate);
    };

    animationHandle = window.requestAnimationFrame(animate);

    return () => {
      window.cancelAnimationFrame(animationHandle);
    };
  }, []);

  useEffect(() => {
    nodesRef.current = scene.nodes;
    didFitInitialViewRef.current = false;

    const linkForce = forceLink<GraphNode, GraphLink>(scene.links)
      .id((node) => node.id)
      .distance((link) => {
        const source = link.source as GraphNode;
        const target = link.target as GraphNode;

        switch (link.edge_type) {
          case "belongs_to":
            return Math.max(source.height, target.height) + 54;
          case "required_for":
            return Math.max(source.width, target.width) * 0.42 + 122;
          case "prerequisite_for":
            return Math.max(source.width, target.width) * 0.46 + 132;
          case "supports":
            return Math.max(source.width, target.width) * 0.54 + 148;
          case "related_to":
            return Math.max(source.width, target.width) * 0.62 + 182;
          default:
            return Math.max(source.width, target.width) * 0.56 + 160;
        }
      })
      .strength((link) => {
        switch (link.edge_type) {
          case "belongs_to":
            return 0.18;
          case "required_for":
            return 0.07;
          case "prerequisite_for":
            return 0.055;
          case "supports":
            return 0.02;
          case "related_to":
            return 0.008;
          default:
            return 0.012;
        }
      }) as ForceLink<GraphNode, GraphLink>;

    const simulation = forceSimulation<GraphNode, GraphLink>(scene.nodes)
      .force("link", linkForce)
      .force(
        "charge",
        forceManyBody<GraphNode>().strength((node) => -148 - node.width * 0.9),
      )
      .force(
        "collide",
        forceCollide<GraphNode>().radius(
          (node) => Math.max(node.width, node.height) * 0.48 + 16,
        ),
      )
      .force("restX", forceX<GraphNode>((node) => node.restX).strength(0.2))
      .force("restY", forceY<GraphNode>((node) => node.restY).strength(0.82))
      .velocityDecay(0.52)
      .alphaDecay(0.078)
      .alphaMin(0.012);

    simulation.on("tick", () => {
      scene.nodes.forEach((node) => {
        if (node.fx === null || node.fx === undefined) {
          node.x = lerp(node.x ?? node.restX, node.restX, 0.035);
          node.vx = (node.vx ?? 0) * 0.82;
        }

        if (node.fy === null || node.fy === undefined) {
          node.y = lerp(node.y ?? node.restY, node.restY, 0.18);
          node.vy = (node.vy ?? 0) * 0.52;
        }
      });

      if (animationRef.current !== null) {
        return;
      }

      animationRef.current = window.requestAnimationFrame(() => {
        animationRef.current = null;
        setFrameVersion((value) => value + 1);
      });
    });

    simulationRef.current = simulation;

    return () => {
      simulation.stop();
      simulationRef.current = null;

      if (animationRef.current !== null) {
        window.cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [scene]);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      setViewport({
        height: entry.contentRect.height,
        width: entry.contentRect.width,
      });
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    if (viewport.width === 0 || viewport.height === 0 || nodesRef.current.length === 0) {
      return;
    }

    if (didFitInitialViewRef.current) {
      return;
    }

    didFitInitialViewRef.current = true;
    setView(createFittedView(nodesRef.current, viewport.width, viewport.height));
  }, [viewport.height, viewport.width]);

  useEffect(() => {
    if (!focusNodeId || viewport.width === 0 || viewport.height === 0) {
      return;
    }

    const focusedNode = nodesRef.current.find((node) => node.id === focusNodeId);

    if (!focusedNode) {
      return;
    }

    if (viewAnimationRef.current !== null) {
      window.cancelAnimationFrame(viewAnimationRef.current);
      viewAnimationRef.current = null;
    }

    const startView = viewRef.current;
    const targetZoom = clamp(Math.max(startView.zoom, 0.92), 0.72, 1.1);
    const targetY = viewport.height * 0.37;
    const targetX = viewport.width * 0.46;
    const nodeX = focusedNode.x ?? focusedNode.restX;
    const nodeY = focusedNode.y ?? focusedNode.restY;
    const nextView: ViewTarget = {
      panX: targetX - viewport.width / 2 - nodeX * targetZoom,
      panY: targetY - viewport.height / 2 - nodeY * targetZoom,
      zoom: targetZoom,
    };
    const startTime = performance.now();
    const duration = 260;

    const animate = (now: number) => {
      const progress = clamp((now - startTime) / duration, 0, 1);
      const eased = easeOutCubic(progress);

      setView({
        panX: lerp(startView.panX, nextView.panX, eased),
        panY: lerp(startView.panY, nextView.panY, eased),
        zoom: lerp(startView.zoom, nextView.zoom, eased),
      });

      if (progress < 1) {
        viewAnimationRef.current = window.requestAnimationFrame(animate);
      } else {
        viewAnimationRef.current = null;
      }
    };

    viewAnimationRef.current = window.requestAnimationFrame(animate);
  }, [focusNodeId, viewport.height, viewport.width]);

  useEffect(() => {
    return () => {
      if (releaseTimeoutRef.current !== null) {
        window.clearTimeout(releaseTimeoutRef.current);
        releaseTimeoutRef.current = null;
      }

      if (viewAnimationRef.current !== null) {
        window.cancelAnimationFrame(viewAnimationRef.current);
        viewAnimationRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (dragStateRef.current) {
        const dragState = dragStateRef.current;
        const draggedNode = nodesRef.current.find((node) => node.id === dragState.nodeId);

        if (!draggedNode) {
          return;
        }

        const worldPoint = getWorldPoint(
          { x: event.clientX, y: event.clientY },
          viewportRef.current,
          viewRef.current,
        );

        draggedNode.fx = worldPoint.x - dragState.offsetX;
        draggedNode.fy = worldPoint.y - dragState.offsetY;
        movedDuringPointerRef.current = true;
        simulationRef.current?.alphaTarget(0.16).restart();
        setFrameVersion((value) => value + 1);
        return;
      }

      if (panStateRef.current) {
        const panState = panStateRef.current;
        movedDuringPointerRef.current = true;
        setView((currentView) => ({
          ...currentView,
          panX: panState.originPanX + (event.clientX - panState.startPointerX),
          panY: panState.originPanY + (event.clientY - panState.startPointerY),
        }));
      }
    };

    const handlePointerUp = () => {
      if (dragStateRef.current) {
        const dragState = dragStateRef.current;
        const draggedNode = nodesRef.current.find((node) => node.id === dragState.nodeId);

        if (draggedNode) {
          draggedNode.fx = null;
          draggedNode.fy = null;
          draggedNode.vx = (draggedNode.vx ?? 0) * 0.18;
          draggedNode.vy = (draggedNode.vy ?? 0) * 0.18;
          simulationRef.current
            ?.alpha(focusNodeId ? 0.18 : 0.32)
            .alphaTarget(focusNodeId ? 0.012 : 0.026)
            .restart();

          if (releaseTimeoutRef.current !== null) {
            window.clearTimeout(releaseTimeoutRef.current);
          }

          releaseTimeoutRef.current = window.setTimeout(() => {
            simulationRef.current?.alphaTarget(0);
            releaseTimeoutRef.current = null;
          }, focusNodeId ? 320 : 560);
        }
      }

      dragStateRef.current = null;
      panStateRef.current = null;
      setDraggingNodeId(null);
      window.setTimeout(() => {
        movedDuringPointerRef.current = false;
      }, 0);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [focusNodeId]);

  const handleCanvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    updateAmbientGlow(containerRef.current, event.clientX, event.clientY, 0.92);
  };

  const handleCanvasPointerLeave = () => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    container.style.setProperty("--graph-cursor-opacity", "0");
  };

  const handleBackgroundPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("[data-graph-node='true']")) {
      return;
    }

    updateAmbientGlow(containerRef.current, event.clientX, event.clientY, 0.92);
    panStateRef.current = {
      originPanX: viewRef.current.panX,
      originPanY: viewRef.current.panY,
      startPointerX: event.clientX,
      startPointerY: event.clientY,
    };
    movedDuringPointerRef.current = false;
  };

  const handleBackgroundClick = () => {
    if (movedDuringPointerRef.current) {
      return;
    }

    onSelectNode(null);
  };

  const handleNodePointerDown = (event: ReactPointerEvent<SVGGElement>, nodeId: string) => {
    event.stopPropagation();
    updateAmbientGlow(containerRef.current, event.clientX, event.clientY, 1);
    const targetNode = nodesRef.current.find((node) => node.id === nodeId);

    if (!targetNode) {
      return;
    }

    const worldPoint = getWorldPoint(
      { x: event.clientX, y: event.clientY },
      viewportRef.current,
      viewRef.current,
    );

    dragStateRef.current = {
      nodeId,
      offsetX: worldPoint.x - (targetNode.x ?? targetNode.restX),
      offsetY: worldPoint.y - (targetNode.y ?? targetNode.restY),
    };
    movedDuringPointerRef.current = false;
    setDraggingNodeId(nodeId);
    targetNode.fx = targetNode.x ?? targetNode.restX;
    targetNode.fy = targetNode.y ?? targetNode.restY;
    simulationRef.current?.alphaTarget(0.18).restart();
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();

    const container = containerRef.current;

    if (!container) {
      return;
    }

    const currentView = viewRef.current;
    const currentViewport = viewportRef.current;
    const rect = container.getBoundingClientRect();
    const pointer = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    const worldBeforeZoom = getWorldPoint(pointer, currentViewport, currentView);
    const nextZoom = clamp(currentView.zoom * Math.exp(-event.deltaY * 0.00112), 0.56, 1.42);

    setView({
      panX: pointer.x - currentViewport.width / 2 - worldBeforeZoom.x * nextZoom,
      panY: pointer.y - currentViewport.height / 2 - worldBeforeZoom.y * nextZoom,
      zoom: nextZoom,
    });
  };

  if (loading) {
    return null;
  }

  const worldTransform = `translate(${viewport.width / 2 + view.panX} ${viewport.height / 2 + view.panY}) scale(${view.zoom})`;

  return (
    <div
      className="graph-canvas-root"
      onClick={handleBackgroundClick}
      onPointerDown={handleBackgroundPointerDown}
      onPointerLeave={handleCanvasPointerLeave}
      onPointerMove={handleCanvasPointerMove}
      onWheel={handleWheel}
      ref={containerRef}
    >
      <div className="graph-canvas-ambient" />

      <svg className="graph-canvas-svg" role="presentation">
        <defs>
          <filter id="node-shadow" x="-44%" y="-70%" width="188%" height="240%">
            <feDropShadow dx="0" dy="18" floodColor="#000000" floodOpacity="0.28" stdDeviation="18" />
          </filter>
          <filter id="node-selected-shadow" x="-60%" y="-90%" width="220%" height="280%">
            <feDropShadow dx="0" dy="18" floodColor="#000000" floodOpacity="0.32" stdDeviation="18" />
            <feDropShadow dx="0" dy="0" floodColor="#d53a47" floodOpacity="0.18" stdDeviation="11" />
          </filter>
          <linearGradient id="node-base-surface" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(24,24,28,0.985)" />
            <stop offset="50%" stopColor="rgba(15,15,18,0.985)" />
            <stop offset="100%" stopColor="rgba(7,7,9,0.985)" />
          </linearGradient>
          <linearGradient id="node-top-sheen" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,255,255,0.085)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0)" />
          </linearGradient>
          <linearGradient id="node-interaction-heat" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(218,64,77,0.58)" />
            <stop offset="46%" stopColor="rgba(132,24,35,0.14)" />
            <stop offset="100%" stopColor="rgba(88,12,19,0)" />
          </linearGradient>
          <linearGradient id="node-border-sheen" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,255,255,0.05)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0.01)" />
          </linearGradient>
          <marker
            id="edge-arrow-structural"
            markerHeight="8.5"
            markerUnits="userSpaceOnUse"
            markerWidth="8.5"
            orient="auto"
            refX="7.2"
            refY="4.25"
          >
            <path d="M 0 0 L 8.5 4.25 L 0 8.5 z" fill="rgba(255,255,255,0.42)" />
          </marker>
          <marker
            id="edge-arrow-emphasis"
            markerHeight="8.5"
            markerUnits="userSpaceOnUse"
            markerWidth="8.5"
            orient="auto"
            refX="7.2"
            refY="4.25"
          >
            <path d="M 0 0 L 8.5 4.25 L 0 8.5 z" fill="rgba(214,68,82,0.92)" />
          </marker>
        </defs>

        <g transform={worldTransform}>
          {scene.links.map((link) => {
            const emphasized =
              selectedInteraction.connectedEdges.has(link.id) ||
              (!focusNodeId && hoveredInteraction.connectedEdges.has(link.id));
            const dimmed = Boolean(focusNodeId) && !selectedInteraction.connectedEdges.has(link.id);
            const style = getEdgeVisualStyle(link, emphasized, dimmed);

            return (
              <path
                d={getLinkPath(link, idleTime, draggingNodeId)}
                fill="none"
                key={link.id}
                markerEnd={style.markerEnd}
                opacity={style.opacity}
                stroke={style.stroke}
                strokeDasharray={style.dashArray}
                strokeLinecap="round"
                strokeWidth={style.strokeWidth}
              />
            );
          })}

          {scene.nodes.map((node) => {
            const position = getRenderedNodePosition(node, idleTime, draggingNodeId);
            const selected = focusNodeId === node.id;
            const hovered = hoveredNodeId === node.id;
            const inHoveredNeighborhood = hoveredInteraction.connectedNodes.has(node.id);
            const inSelectedNeighborhood = selectedInteraction.connectedNodes.has(node.id);
            const searchHit = searchMatches.has(node.id);
            const visual = getNodeVisualState({
              hovered,
              inHoveredNeighborhood,
              inSelectedNeighborhood,
              searchHit,
              selected,
              selectedNodeId: focusNodeId,
            });
            const nodeFilter = selected ? "url(#node-selected-shadow)" : "url(#node-shadow)";
            const lineHeight = node.lines.length === 1 ? 0 : node.fontSize * 1.04;
            const initialY = node.lines.length === 1 ? 2 : -lineHeight / 2 + 1;
            const cueRadius =
              node.visualTier === "root" ? 5.4 : node.visualTier === "anchor" ? 4.7 : 3.8;
            const nodeRadius = Math.min(node.width, node.height) * 0.44;

            return (
              <g
                data-graph-node="true"
                key={node.id}
                onClick={(event) => {
                  event.stopPropagation();

                  if (movedDuringPointerRef.current) {
                    return;
                  }

                  onSelectNode(node.id);
                }}
                onMouseEnter={() => setHoveredNodeId(node.id)}
                onMouseLeave={() =>
                  setHoveredNodeId((currentNodeId) =>
                    currentNodeId === node.id ? null : currentNodeId,
                  )
                }
                onPointerDown={(event) => handleNodePointerDown(event, node.id)}
                opacity={visual.opacity}
                transform={`translate(${position.x}, ${position.y})`}
              >
                <g filter={nodeFilter}>
                  <rect
                    fill="rgba(4,4,6,0.92)"
                    height={node.height + (selected ? 9 : 6)}
                    opacity={visual.shadowOpacity}
                    rx={Math.min(node.width + (selected ? 9 : 6), node.height + (selected ? 9 : 6)) * 0.44}
                    width={node.width + (selected ? 9 : 6)}
                    x={-(node.width + (selected ? 9 : 6)) / 2}
                    y={-(node.height + (selected ? 9 : 6)) / 2 + 7}
                  />
                  <rect
                    fill="url(#node-base-surface)"
                    height={node.height}
                    rx={nodeRadius}
                    stroke={visual.border}
                    strokeWidth={selected ? 1.55 : hovered ? 1.2 : 1}
                    width={node.width}
                    x={-node.width / 2}
                    y={-node.height / 2}
                  />
                  <rect
                    fill="url(#node-top-sheen)"
                    height={node.height * 0.5}
                    opacity={visual.topSheenOpacity}
                    rx={nodeRadius}
                    width={node.width - 2}
                    x={-(node.width - 2) / 2}
                    y={-node.height / 2 + 1}
                  />
                  <rect
                    fill="url(#node-interaction-heat)"
                    height={node.height - 2}
                    opacity={visual.heatOpacity}
                    rx={Math.max(nodeRadius - 1, 12)}
                    width={node.width - 2}
                    x={-(node.width - 2) / 2}
                    y={-(node.height - 2) / 2}
                  />
                  <rect
                    fill="none"
                    height={node.height - 2}
                    opacity={visual.glowOpacity}
                    rx={Math.max(nodeRadius - 1, 12)}
                    stroke="rgba(213,58,71,0.96)"
                    strokeWidth={selected ? 1.95 : 1.25}
                    width={node.width - 2}
                    x={-(node.width - 2) / 2}
                    y={-(node.height - 2) / 2}
                  />
                  <rect
                    fill="none"
                    height={node.height - 2}
                    opacity={0.32}
                    rx={Math.max(nodeRadius - 1, 12)}
                    stroke="url(#node-border-sheen)"
                    strokeWidth={0.8}
                    width={node.width - 2}
                    x={-(node.width - 2) / 2}
                    y={-(node.height - 2) / 2}
                  />
                  <circle
                    cx={-node.width / 2 + 16}
                    cy={-node.height / 2 + 16}
                    fill={node.categoryColor}
                    opacity={visual.cueOpacity}
                    r={cueRadius}
                  />
                  <circle
                    cx={-node.width / 2 + 16}
                    cy={-node.height / 2 + 16}
                    fill="rgba(255,255,255,0.22)"
                    opacity={0.26}
                    r={cueRadius * 0.42}
                  />
                  <text
                    fill={visual.text}
                    fontFamily="var(--font-geist-sans), sans-serif"
                    fontSize={node.fontSize}
                    fontWeight={560}
                    letterSpacing="-0.02em"
                    textAnchor="middle"
                    y={initialY}
                  >
                    {node.lines.map((line, index) => (
                      <tspan
                        dy={index === 0 ? 0 : lineHeight}
                        key={`${node.id}-${line}`}
                        x={0}
                      >
                        {line}
                      </tspan>
                    ))}
                  </text>
                </g>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
