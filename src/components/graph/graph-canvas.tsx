"use client";

import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from "d3-force";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

import { getImportanceIndex } from "@/lib/graph/importance";
import { buildPrimaryStructuralTree, getStructuralParentCandidate } from "@/lib/graph/structure";
import type { Edge, EdgeType, GraphData, Node, NodeType } from "@/types/graph";

type GraphCanvasProps = {
  editMode: boolean;
  focusNodeId: string | null;
  focusRequestKey: number;
  graphData: GraphData;
  layoutKey: number;
  loading: boolean;
  onCommitNodePosition: (nodeId: string, position: { x: number; y: number }) => void;
  onSelectNode: (nodeId: string | null) => void;
  onViewChange: (view: ViewState) => void;
  searchQuery: string;
  suppressInitialFocusAnimation: boolean;
};

export type GraphCanvasViewState = {
  panX: number;
  panY: number;
  zoom: number;
};

type ViewState = GraphCanvasViewState;

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

type IdleOffset = {
  x: number;
  y: number;
};

type GraphNode = Node &
  SimulationNodeDatum &
  LabelLayout & {
    categoryColor: string;
    driftAngle: number;
    depth: number;
    driftAmplitudeX: number;
    driftAmplitudeY: number;
    driftPhaseX: number;
    driftPhaseY: number;
    driftRateA: number;
    driftRateB: number;
    importanceScore: number;
    restX: number;
    restY: number;
    sizeScale: number;
    visualTier: VisualTier;
  };

type GraphLink = Edge &
  SimulationLinkDatum<GraphNode> & {
    directional: boolean;
    family: "structural" | "semantic";
    layoutDirection: "up" | "down" | "free";
    primary: boolean;
    semanticIndex: number;
    semanticTotal: number;
    sourceAnchorOffset: number;
    strength: number;
    targetAnchorOffset: number;
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

type PinchState = {
  initialDistance: number;
  initialZoom: number;
  initialPanX: number;
  initialPanY: number;
  midX: number;
  midY: number;
};

type EdgeVisualStyle = {
  dashArray?: string;
  markerEnd?: string;
  opacity: number;
  stroke: string;
  strokeWidth: number;
};

type VisualNodeType = "goal" | "project" | "task" | "concept" | "class" | "habit";

const nodeTypeCueMap: Record<VisualNodeType, string> = {
  goal: "#d8d0c4",
  project: "#8c4a57",
  task: "#a35258",
  class: "#96784d",
  concept: "#677480",
  habit: "#4a7c6b",
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
  habit: 3,
};

const edgeStrengthMap: Record<EdgeType, number> = {
  belongs_to: 1,
  required_for: 0.88,
  prerequisite_for: 0.88,
  supports: 0.56,
  useful_for: 0.44,
  blocks: 0.66,
  inspired_by: 0.34,
  related_to: 0.24,
  depends_on: 0.88,
};

const importanceVisualBounds = {
  maxFontSize: 21.4,
  maxHeight: 136,
  maxScore: 97,
  maxWidth: 232,
  minFontSize: 10.1,
  minHeight: 34,
  minScore: 22,
  minWidth: 64,
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

function hexToRgb(hex: string) {
  const sanitized = hex.replace("#", "");
  const normalized =
    sanitized.length === 3
      ? sanitized
          .split("")
          .map((character) => `${character}${character}`)
          .join("")
      : sanitized;

  const numeric = Number.parseInt(normalized, 16);

  if (Number.isNaN(numeric)) {
    return { blue: 255, green: 255, red: 255 };
  }

  return {
    blue: numeric & 255,
    green: (numeric >> 8) & 255,
    red: (numeric >> 16) & 255,
  };
}

function rgba(hex: string, alpha: number) {
  const color = hexToRgb(hex);

  return `rgba(${color.red}, ${color.green}, ${color.blue}, ${alpha})`;
}

function getVisualNodeType(nodeType: NodeType): VisualNodeType {
  switch (nodeType) {
    case "goal":
    case "project":
    case "task":
    case "class":
    case "concept":
      return nodeType;
    case "idea":
    case "journal":
    case "question":
    default:
      return "concept";
  }
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

function normalizeImportanceScore(score: number) {
  return clamp(
    (score - importanceVisualBounds.minScore) /
      (importanceVisualBounds.maxScore - importanceVisualBounds.minScore),
    0,
    1,
  );
}

function getVisualTierFromScore(score: number): VisualTier {
  if (score >= 90) {
    return "root";
  }

  if (score >= 74) {
    return "anchor";
  }

  if (score >= 40) {
    return "body";
  }

  return "leaf";
}

function getImportanceScore(node: Node) {
  if (typeof node.current_importance_score === "number" && Number.isFinite(node.current_importance_score)) {
    return clamp(node.current_importance_score, importanceVisualBounds.minScore, importanceVisualBounds.maxScore);
  }
  return clamp(getImportanceIndex(node), importanceVisualBounds.minScore, importanceVisualBounds.maxScore);
}

function getAnchorScore(node: Node, childCount: number, depth: number, hasParent: boolean) {
  return getImportanceScore(node) + childCount * 2.8 - depth * 0.8 + (!hasParent ? 1.2 : 0);
}

function createNodeLayout(node: Node, importanceScore: number) {
  const normalizedScore = normalizeImportanceScore(importanceScore);
  const sizeScale = Math.pow(normalizedScore, 1.08);
  const visualTier = getVisualTierFromScore(importanceScore);
  const fontSize = lerp(
    importanceVisualBounds.minFontSize,
    importanceVisualBounds.maxFontSize,
    sizeScale,
  );
  const padX = lerp(11, 25, sizeScale);
  const width = lerp(
    importanceVisualBounds.minWidth,
    importanceVisualBounds.maxWidth,
    sizeScale,
  );
  const height = lerp(
    importanceVisualBounds.minHeight,
    importanceVisualBounds.maxHeight,
    sizeScale,
  );
  const maxCharsPerLine = clamp(
    Math.floor((width - padX * 2) / (fontSize * 0.56)),
    8,
    sizeScale >= 0.84 ? 14 : sizeScale >= 0.7 ? 12 : sizeScale >= 0.48 ? 10 : 9,
  );
  const lines = wrapTitle(node.title, maxCharsPerLine);
  const hash = hashString(node.id);

  return {
    categoryColor: nodeTypeCueMap[getVisualNodeType(node.node_type)],
    depth: 0,
    driftAmplitudeX: lerp(2.9, 1.1, sizeScale),
    driftAmplitudeY: lerp(2.4, 0.9, sizeScale),
    driftAngle: ((hash >> 9) % 360) * (Math.PI / 180),
    driftPhaseX: (hash % 360) * (Math.PI / 180),
    driftPhaseY: ((hash >> 5) % 360) * (Math.PI / 180),
    driftRateA: 0.00024 + ((hash >> 13) % 9) * 0.000012,
    driftRateB: 0.00014 + ((hash >> 17) % 7) * 0.00001,
    fontSize,
    height,
    importanceScore,
    lines,
    restX: 0,
    restY: 0,
    sizeScale,
    visualTier,
    width,
    x: 0,
    y: 0,
  } satisfies Omit<GraphNode, keyof Node>;
}

function getVerticalOffset(depth: number, componentIndex: number) {
  const firstGap = componentIndex === 0 ? 220 : 190;
  const laterGap = componentIndex === 0 ? 168 : 148;

  if (depth === 0) {
    return 0;
  }

  return firstGap + (depth - 1) * laterGap;
}

function getComponentCenterOffset(
  componentIndex: number,
  componentWidth: number,
  componentHeight: number,
) {
  if (componentIndex === 0) {
    return { x: 0, y: -72 };
  }

  const compactIndex = componentIndex - 1;
  const columns = 3;
  const column = compactIndex % columns;
  const row = Math.floor(compactIndex / columns);
  const xSpacing = 720 + Math.min(componentWidth * 0.24, 140);
  const ySpacing = 520 + Math.min(componentHeight * 0.2, 120);

  return {
    x: (column - (columns - 1) / 2) * xSpacing,
    y: 480 + row * ySpacing,
  };
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
  const parentCandidates = new Map<
    string,
    { edgeId: string; parentId: string; priority: number }
  >();

  graphData.edges.forEach((edge) => {
    const candidate = getStructuralParentCandidate(edge);

    if (!candidate) {
      return;
    }

    const current = parentCandidates.get(candidate.childId);

    if (!current || candidate.priority > current.priority) {
      parentCandidates.set(candidate.childId, {
        edgeId: edge.id,
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

  const depthById = new Map<string, number>();

  const getDepth = (nodeId: string, visited = new Set<string>()): number => {
    const cachedDepth = depthById.get(nodeId);

    if (typeof cachedDepth === "number") {
      return cachedDepth;
    }

    if (visited.has(nodeId)) {
      return 0;
    }

    const parentId = parentCandidates.get(nodeId)?.parentId;

    if (!parentId) {
      depthById.set(nodeId, 0);
      return 0;
    }

    const nextVisited = new Set(visited);
    nextVisited.add(nodeId);
    const depth = getDepth(parentId, nextVisited) + 1;
    depthById.set(nodeId, depth);
    return depth;
  };

  graphData.nodes.forEach((node) => {
    getDepth(node.id);
  });

  const importanceScoreById = new Map<string, number>();

  graphData.nodes.forEach((node) => {
    importanceScoreById.set(node.id, getImportanceScore(node));
  });

  const laidOutNodes: GraphNode[] = graphData.nodes.map((node) => {
    return {
      ...node,
      ...createNodeLayout(node, importanceScoreById.get(node.id) ?? 48),
    };
  });

  const laidOutNodeMap = new Map(laidOutNodes.map((node) => [node.id, node]));
  const components = getConnectedComponents(graphData);
  const sortedComponents = [...components].sort((componentA, componentB) => {
    const scoreA = Math.max(
      ...componentA.map((nodeId) => {
        const node = nodesById.get(nodeId);
        return node
          ? getAnchorScore(
              node,
              childrenByParent.get(nodeId)?.length ?? 0,
              depthById.get(nodeId) ?? 0,
              parentCandidates.has(nodeId),
            )
          : 0;
      }),
    );
    const scoreB = Math.max(
      ...componentB.map((nodeId) => {
        const node = nodesById.get(nodeId);
        return node
          ? getAnchorScore(
              node,
              childrenByParent.get(nodeId)?.length ?? 0,
              depthById.get(nodeId) ?? 0,
              parentCandidates.has(nodeId),
            )
          : 0;
      }),
    );

    return scoreB - scoreA || componentB.length - componentA.length;
  });

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
          ? getAnchorScore(
              nodeA,
              childrenByParent.get(nodeIdA)?.length ?? 0,
              depthById.get(nodeIdA) ?? 0,
              parentCandidates.has(nodeIdA),
            )
          : 0;
        const scoreB = nodeB
          ? getAnchorScore(
              nodeB,
              childrenByParent.get(nodeIdB)?.length ?? 0,
              depthById.get(nodeIdB) ?? 0,
              parentCandidates.has(nodeIdB),
            )
          : 0;
        return scoreB - scoreA;
      });

    const normalizedRoots = roots.length > 0 ? roots : [component[0]];
    const horizontalGap = componentIndex === 0 ? 38 : 30;
    const subtreeWidthCache = new Map<string, number>();

    const getSortedChildren = (parentId: string) =>
      (childrenByParent.get(parentId) ?? [])
        .filter((childId) => componentSet.has(childId))
        .sort((childIdA, childIdB) => {
          const nodeA = nodesById.get(childIdA);
          const nodeB = nodesById.get(childIdB);
          const scoreA = nodeA
            ? getAnchorScore(
                nodeA,
                childrenByParent.get(childIdA)?.length ?? 0,
                depthById.get(childIdA) ?? 0,
                parentCandidates.has(childIdA),
              )
            : 0;
          const scoreB = nodeB
            ? getAnchorScore(
                nodeB,
                childrenByParent.get(childIdB)?.length ?? 0,
                depthById.get(childIdB) ?? 0,
                parentCandidates.has(childIdB),
              )
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

    const rootSpacing = componentIndex === 0 ? 72 : 56;
    const totalRootWidth = normalizedRoots.reduce((totalWidth, rootId, rootIndex) => {
      return totalWidth + computeSubtreeWidth(rootId) + (rootIndex === 0 ? 0 : rootSpacing);
    }, 0);
    let rootLeftEdge = -totalRootWidth / 2;

    normalizedRoots.forEach((rootId, rootIndex) => {
      if (rootIndex > 0) {
        rootLeftEdge += rootSpacing;
      }

      placeNode(rootId, rootLeftEdge, 0);
      rootLeftEdge += computeSubtreeWidth(rootId);
    });

    const componentNodes = component
      .map((nodeId) => laidOutNodeMap.get(nodeId))
      .filter(isDefined);
    const bounds = getTreeBounds(componentNodes);
    const componentWidth = bounds.maxX - bounds.minX;
    const componentHeight = bounds.maxY - bounds.minY;
    const componentOffset = getComponentCenterOffset(
      componentIndex,
      componentWidth,
      componentHeight,
    );
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    const shiftX = componentOffset.x - centerX;
    const shiftY = componentOffset.y - centerY;

    componentNodes.forEach((node) => {
      node.restX += shiftX;
      node.restY += shiftY;
      node.x = node.restX;
      node.y = node.restY;
    });
  });

  laidOutNodes.forEach((node) => {
    const savedX = node.position_x;
    const savedY = node.position_y;

    if (
      typeof savedX !== "number" ||
      !Number.isFinite(savedX) ||
      typeof savedY !== "number" ||
      !Number.isFinite(savedY)
    ) {
      return;
    }

    node.manual_position = true;
    node.restX = savedX;
    node.restY = savedY;
    node.x = savedX;
    node.y = savedY;
    node.fx = savedX;
    node.fy = savedY;
    node.vx = 0;
    node.vy = 0;
  });

  const primaryEdgeIds = new Set(
    Array.from(parentCandidates.values()).map((candidate) => candidate.edgeId),
  );
  const childOrderByParent = new Map<string, { count: number; index: number }>();

  Array.from(childrenByParent.entries()).forEach(([parentId, childIds]) => {
    const sortedChildren = [...childIds].sort((childIdA, childIdB) => {
      const nodeA = nodesById.get(childIdA);
      const nodeB = nodesById.get(childIdB);
      const scoreA = nodeA
        ? getAnchorScore(
            nodeA,
            childrenByParent.get(childIdA)?.length ?? 0,
            depthById.get(childIdA) ?? 0,
            parentCandidates.has(childIdA),
          )
        : 0;
      const scoreB = nodeB
        ? getAnchorScore(
            nodeB,
            childrenByParent.get(childIdB)?.length ?? 0,
            depthById.get(childIdB) ?? 0,
            parentCandidates.has(childIdB),
          )
        : 0;

      return scoreB - scoreA || childIdA.localeCompare(childIdB);
    });

    sortedChildren.forEach((childId, index) => {
      childOrderByParent.set(`${parentId}:${childId}`, {
        count: sortedChildren.length,
        index,
      });
    });
  });

  const laidOutLinks: GraphLink[] = graphData.edges.map((edge) => {
    const structuralCandidate =
      edge.edge_type === "belongs_to" ||
      edge.edge_type === "prerequisite_for" ||
      edge.edge_type === "required_for";
    const directional =
      structuralCandidate ||
      edge.edge_type === "blocks" ||
      edge.edge_type === "useful_for" ||
      edge.edge_type === "supports";
    const primary = primaryEdgeIds.has(edge.id);
    const family = structuralCandidate && primary ? "structural" : "semantic";
    const layoutDirection =
      edge.edge_type === "belongs_to"
        ? "up"
        : edge.edge_type === "required_for" || edge.edge_type === "prerequisite_for"
          ? "down"
          : "free";
    let sourceAnchorOffset = 0;
    let targetAnchorOffset = 0;

    if (family === "structural") {
      const parentId =
        edge.edge_type === "belongs_to" ? edge.target_node_id : edge.source_node_id;
      const childId =
        edge.edge_type === "belongs_to" ? edge.source_node_id : edge.target_node_id;
      const childOrder = childOrderByParent.get(`${parentId}:${childId}`);

      if (childOrder) {
        const parentNode = laidOutNodeMap.get(parentId);
        const childNode = laidOutNodeMap.get(childId);
        const spread =
          childOrder.count <= 1
            ? 0
            : (childOrder.index - (childOrder.count - 1) / 2) *
              Math.min((parentNode?.width ?? 120) * 0.22, 34);

        if (edge.edge_type === "belongs_to") {
          sourceAnchorOffset = clamp(spread * 0.28, -(childNode?.width ?? 120) * 0.16, (childNode?.width ?? 120) * 0.16);
          targetAnchorOffset = spread;
        } else {
          sourceAnchorOffset = spread;
          targetAnchorOffset = clamp(spread * 0.26, -(childNode?.width ?? 120) * 0.16, (childNode?.width ?? 120) * 0.16);
        }
      }
    }

    return {
      ...edge,
      directional,
      family,
      layoutDirection,
      primary,
      semanticIndex: 0,
      semanticTotal: 1,
      sourceAnchorOffset,
      source: edge.source_node_id,
      strength: edgeStrengthMap[edge.edge_type],
      targetAnchorOffset,
      target: edge.target_node_id,
    };
  });

  const semanticGroups = new Map<string, GraphLink[]>();

  laidOutLinks.forEach((link) => {
    if (link.family === "structural") {
      return;
    }

    const pairKey = [link.source_node_id, link.target_node_id].sort().join(":");
    const group = semanticGroups.get(pairKey) ?? [];
    group.push(link);
    semanticGroups.set(pairKey, group);
  });

  semanticGroups.forEach((links) => {
    links
      .sort((linkA, linkB) => linkA.edge_type.localeCompare(linkB.edge_type))
      .forEach((link, index) => {
        link.semanticIndex = index;
        link.semanticTotal = links.length;
      });
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

  // Focus on manually pinned nodes when they exist — they represent the user's
  // intentional layout. Using all nodes would zoom out to include scattered
  // auto-layout nodes and make the graph look broken on first load.
  const pinnedNodes = nodes.filter((n) => n.fx !== null && n.fx !== undefined);
  const bounds = getGraphBounds(pinnedNodes.length > 0 ? pinnedNodes : nodes);
  const usableWidth = Math.max(width - 100, 360);
  const usableHeight = Math.max(height - 120, 340);
  const isMobile = width <= 768;
  const zoom = clamp(
    Math.min(usableWidth / Math.max(bounds.width, 1), usableHeight / Math.max(bounds.height, 1)),
    isMobile ? 0.35 : 0.68,
    isMobile ? 0.7 : 1.06,
  );
  const targetX = width * 0.5;
  const targetY = height * 0.42;

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

function getIdleOffset(
  node: GraphNode,
  time: number,
  freeze = false,
): IdleOffset {
  if (freeze) {
    return { x: 0, y: 0 };
  }

  const localX =
    Math.sin(time * node.driftRateA + node.driftPhaseX) * node.driftAmplitudeX * 0.72 +
    Math.sin(time * node.driftRateB + node.driftPhaseY * 0.82) * node.driftAmplitudeX * 0.34;
  const localY =
    Math.cos(time * node.driftRateA * 0.92 + node.driftPhaseY) * node.driftAmplitudeY * 0.68 +
    Math.sin(time * node.driftRateB * 1.08 + node.driftPhaseX * 0.74) * node.driftAmplitudeY * 0.32;
  const cosAngle = Math.cos(node.driftAngle);
  const sinAngle = Math.sin(node.driftAngle);

  return {
    x: localX * cosAngle - localY * sinAngle,
    y: localX * sinAngle + localY * cosAngle,
  };
}

function getRenderedNodePosition(
  node: GraphNode,
  draggingNodeId: string | null,
  idleOffsets?: Map<string, IdleOffset>,
) {
  const baseX = node.x ?? node.restX;
  const baseY = node.y ?? node.restY;

  if (draggingNodeId === node.id) {
    return { x: baseX, y: baseY };
  }

  const idleOffset = idleOffsets?.get(node.id);

  return {
    x: baseX + (idleOffset?.x ?? 0),
    y: baseY + (idleOffset?.y ?? 0),
  };
}

function getRoundedBoundaryAnchor(
  node: GraphNode,
  position: { x: number; y: number },
  target: { x: number; y: number },
  retreat = 0,
) {
  const dx = target.x - position.x;
  const dy = target.y - position.y;
  const distance = Math.max(Math.hypot(dx, dy), 1);
  const rx = Math.max(node.width / 2 - 10, 18);
  const ry = Math.max(node.height / 2 - 8, 16);
  const scale = 1 / Math.max(Math.abs(dx) / rx, Math.abs(dy) / ry, 0.0001);
  const boundaryX = position.x + dx * scale;
  const boundaryY = position.y + dy * scale;

  return {
    x: boundaryX + (dx / distance) * retreat,
    y: boundaryY + (dy / distance) * retreat,
  };
}

function getLinkEndpoints(
  link: GraphLink,
  draggingNodeId: string | null,
  idleOffsets?: Map<string, IdleOffset>,
) {
  const source = link.source as GraphNode;
  const target = link.target as GraphNode;
  const sourcePosition = getRenderedNodePosition(source, draggingNodeId, idleOffsets);
  const targetPosition = getRenderedNodePosition(target, draggingNodeId, idleOffsets);

  if (link.family === "structural") {
    const startSide = link.layoutDirection === "up" ? -1 : 1;
    const endSide = link.layoutDirection === "up" ? 1 : -1;
    const startX = sourcePosition.x + link.sourceAnchorOffset;
    const startY = sourcePosition.y + startSide * (source.height / 2 + 7);
    const endX = targetPosition.x + link.targetAnchorOffset;
    const endY = targetPosition.y + endSide * (target.height / 2 + 10);
    const verticalSpan = Math.max(Math.abs(endY - startY), 44);
    const controlOffset = clamp(
      verticalSpan * (link.edge_type === "belongs_to" ? 0.44 : 0.36),
      38,
      108,
    );

    return {
      controlX: startX,
      controlX2: endX,
      controlY: startY + startSide * controlOffset,
      controlY2: endY + endSide * controlOffset,
      endX,
      endY,
      startX,
      startY,
    };
  }

  const dx = targetPosition.x - sourcePosition.x;
  const dy = targetPosition.y - sourcePosition.y;
  const distance = Math.max(Math.hypot(dx, dy), 1);
  const normalX = -dy / distance;
  const normalY = dx / distance;
  const semanticSpread =
    link.semanticTotal <= 1
      ? 0
      : (link.semanticIndex - (link.semanticTotal - 1) / 2) * 14;
  const midpoint = {
    x: (sourcePosition.x + targetPosition.x) / 2,
    y: (sourcePosition.y + targetPosition.y) / 2,
  };
  const startAnchor = getRoundedBoundaryAnchor(source, sourcePosition, targetPosition, 5);
  const endAnchor = getRoundedBoundaryAnchor(target, targetPosition, sourcePosition, 16);
  const startX = startAnchor.x + normalX * semanticSpread * 0.3;
  const startY = startAnchor.y + normalY * semanticSpread * 0.3;
  const endX = endAnchor.x + normalX * semanticSpread * 0.16;
  const endY = endAnchor.y + normalY * semanticSpread * 0.16;
  const curveMagnitude =
    Math.min(92, Math.max(20, distance * 0.14 + Math.abs(semanticSpread) * 0.9)) *
    (hashString(link.id) % 2 === 0 ? 1 : -1);

  return {
    controlX: midpoint.x + normalX * (curveMagnitude + semanticSpread),
    controlX2: undefined,
    controlY: midpoint.y + normalY * (curveMagnitude + semanticSpread),
    controlY2: undefined,
    endX,
    endY,
    startX,
    startY,
  };
}

function getLinkPath(
  link: GraphLink,
  draggingNodeId: string | null,
  idleOffsets?: Map<string, IdleOffset>,
) {
  const { controlX, controlX2, controlY, controlY2, endX, endY, startX, startY } =
    getLinkEndpoints(
      link,
      draggingNodeId,
      idleOffsets,
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

// Edge decay: fade edges connected to completed nodes over time.
// No ranking engine needed — computed live from completed_at.
// decay_start_days=3, decay_full_days=30, floor=0.05
function computeEdgeDecay(link: GraphLink): number {
  const src = link.source as GraphNode | undefined;
  const tgt = link.target as GraphNode | undefined;

  const completedAts = [src?.completed_at, tgt?.completed_at].filter(Boolean) as string[];
  if (completedAts.length === 0) return 1;

  // Use the most recently completed node to drive decay
  const mostRecentMs = Math.max(...completedAts.map((d) => new Date(d).getTime()));
  const daysSince = (Date.now() - mostRecentMs) / (1000 * 60 * 60 * 24);

  if (daysSince < 3) return 1;
  if (daysSince >= 30) return 0.05;
  // Linear interpolation from 1.0 at day 3 → 0.05 at day 30
  return 1 - ((daysSince - 3) / (30 - 3)) * (1 - 0.05);
}

function getEdgeVisualStyle(
  link: GraphLink,
  emphasized: boolean,
  dimmed: boolean,
): EdgeVisualStyle {
  const structural = link.family === "structural";
  const directional = link.directional;

  let opacity = structural ? 0.26 : 0.09;
  let strokeWidth = structural ? 1.46 : 0.64;
  let stroke = structural ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.10)";
  let dashArray: string | undefined;
  let markerEnd: string | undefined;

  switch (link.edge_type) {
    case "belongs_to":
      opacity = structural ? 0.34 : 0.14;
      strokeWidth = structural ? 1.26 + link.strength * 0.82 : 0.7;
      stroke = structural ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.14)";
      break;
    case "required_for":
    case "prerequisite_for":
      opacity = structural ? 0.29 : 0.12;
      strokeWidth = structural ? 1.44 + link.strength * 0.9 : 0.66;
      stroke = structural ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.12)";
      dashArray = "8 7";
      break;
    case "supports":
      opacity = structural ? 0.34 : 0.10;
      strokeWidth = structural ? 1.0 + link.strength * 0.44 : 0.58;
      stroke = structural ? "rgba(224,215,206,0.38)" : "rgba(224,215,206,0.12)";
      break;
    case "related_to":
      opacity = 0.08;
      strokeWidth = 0.54;
      stroke = "rgba(255,255,255,0.09)";
      dashArray = "3 6";
      break;
    case "useful_for":
      opacity = 0.07;
      strokeWidth = 0.5;
      stroke = "rgba(255,255,255,0.08)";
      break;
    case "blocks":
      opacity = 0.10;
      strokeWidth = 0.58;
      stroke = "rgba(255,255,255,0.11)";
      dashArray = "4 6";
      break;
    case "inspired_by":
      opacity = 0.06;
      strokeWidth = 0.44;
      stroke = "rgba(255,255,255,0.07)";
      dashArray = "2 8";
      break;
  }

  if (emphasized) {
    if (link.edge_type === "belongs_to") {
      opacity = 0.42;
      strokeWidth = 2.0;
      stroke = "rgba(198,76,88,0.62)";
    } else if (link.edge_type === "supports") {
      opacity = 0.36;
      strokeWidth = 1.4;
      stroke = "rgba(205,140,150,0.52)";
    } else if (link.edge_type === "required_for" || link.edge_type === "prerequisite_for") {
      opacity = 0.38;
      strokeWidth = 1.6;
      stroke = "rgba(198,118,128,0.48)";
    } else if (link.edge_type === "related_to") {
      opacity = 0.30;
      strokeWidth = 1.1;
      stroke = "rgba(200,160,168,0.44)";
    } else {
      opacity = 0.28;
      strokeWidth = 1.0;
      stroke = structural ? "rgba(198,76,88,0.56)" : "rgba(198,76,88,0.40)";
    }
  }

  if (dimmed) {
    opacity *= structural ? 0.28 : 0.1;
    strokeWidth *= structural ? 0.86 : 0.6;
    stroke = structural ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.02)";
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
  archived: boolean;
  completed: boolean;
  hovered: boolean;
  inHoveredNeighborhood: boolean;
  inSelectedNeighborhood: boolean;
  searchHit: boolean;
  selected: boolean;
  selectedNodeId: string | null;
}) {
  const {
    archived,
    completed,
    hovered,
    inHoveredNeighborhood,
    inSelectedNeighborhood,
    searchHit,
    selected,
    selectedNodeId,
  } = options;

  // Archived nodes are shown only when the filter is toggled — always highly muted
  if (archived && !selected) {
    return {
      border: "rgba(255,255,255,0.028)",
      surfaceTintOpacity: 0.04,
      glowOpacity: 0,
      heatOpacity: 0,
      opacity: 0.22,
      shadowOpacity: 0.06,
      text: "rgba(200,195,190,0.35)",
      topSheenOpacity: 0.08,
    };
  }

  if (selected) {
    return {
      border: "rgba(223,69,83,0.96)",
      surfaceTintOpacity: 0.34,
      glowOpacity: 0.34,
      heatOpacity: 0.54,
      opacity: 1,
      shadowOpacity: 0.34,
      text: "#f6f2ed",
      topSheenOpacity: 0.66,
    };
  }

  if (hovered) {
    return {
      border: "rgba(220,67,81,0.58)",
      surfaceTintOpacity: 0.28,
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
      surfaceTintOpacity: 0.12,
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
      surfaceTintOpacity: 0.22,
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
      surfaceTintOpacity: 0.18,
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
      surfaceTintOpacity: 0.24,
      glowOpacity: 0.12,
      heatOpacity: 0.12,
      opacity: 0.94,
      shadowOpacity: 0.28,
      text: "#f0ece6",
      topSheenOpacity: 0.54,
    };
  }

  if (completed && !selected) {
    return {
      border: "rgba(255,255,255,0.05)",
      surfaceTintOpacity: 0.07,
      glowOpacity: 0,
      heatOpacity: 0,
      opacity: 0.46,
      shadowOpacity: 0.12,
      text: "rgba(210,220,210,0.5)",
      topSheenOpacity: 0.14,
    };
  }

  return {
    border: "rgba(255,255,255,0.072)",
    surfaceTintOpacity: 0.16,
    glowOpacity: 0,
    heatOpacity: 0,
    opacity: 0.84,
    shadowOpacity: 0.24,
    text: "#e8e2db",
    topSheenOpacity: 0.46,
  };
}

function countDescendants(nodeId: string, childrenByParent: Map<string, string[]>): number {
  let count = 0;
  for (const child of childrenByParent.get(nodeId) ?? []) {
    count += 1 + countDescendants(child, childrenByParent);
  }
  return count;
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
  editMode,
  focusNodeId,
  focusRequestKey,
  graphData,
  layoutKey,
  loading,
  onCommitNodePosition,
  onSelectNode,
  onViewChange,
  searchQuery,
  suppressInitialFocusAnimation,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const linkElementRefs = useRef(new Map<string, SVGPathElement>());
  const nodeElementRefs = useRef(new Map<string, SVGGElement>());
  const simulationRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);
  const animationRef = useRef<number | null>(null);
  const idleAnimationRef = useRef<number | null>(null);
  const idleOffsetsRef = useRef(new Map<string, IdleOffset>());
  const returnAnimationRef = useRef<number | null>(null);
  const returningNodeRef = useRef<GraphNode | null>(null);
  const viewAnimationRef = useRef<number | null>(null);
  const focusFollowUpTimeoutRef = useRef<number | null>(null);
  const focusNodeIdRef = useRef(focusNodeId);
  const suppressInitialFocusAnimationRef = useRef(suppressInitialFocusAnimation);
  const lastHandledFocusRequestRef = useRef(focusRequestKey);
  const nodesRef = useRef<GraphNode[]>([]);
  const lastLayoutKeyRef = useRef(layoutKey);
  const dragStateRef = useRef<DragState | null>(null);
  const panStateRef = useRef<PanState | null>(null);
  const pinchStateRef = useRef<PinchState | null>(null);
  const viewRef = useRef<ViewState>(defaultView);
  const viewportRef = useRef({ height: 0, width: 0 });
  const movedDuringPointerRef = useRef(false);
  const didFitInitialViewRef = useRef(false);
  const [viewport, setViewport] = useState({ height: 0, width: 0 });
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [view, setView] = useState<ViewState>(defaultView);
  const [, setFrameVersion] = useState(0);
  const [collapsedNodeIds, setCollapsedNodeIds] = useState(() => new Set<string>());

  // Structural children map derived from graphData — used for collapse logic.
  const childrenByParent = useMemo(
    () => buildPrimaryStructuralTree(graphData).childrenByParent,
    [graphData],
  );

  // Set of all node IDs that are hidden because an ancestor is collapsed.
  const hiddenNodeIds = useMemo(() => {
    if (collapsedNodeIds.size === 0) return new Set<string>();
    const hidden = new Set<string>();
    function collect(nodeId: string) {
      for (const child of childrenByParent.get(nodeId) ?? []) {
        if (!hidden.has(child)) {
          hidden.add(child);
          collect(child);
        }
      }
    }
    collapsedNodeIds.forEach(collect);
    return hidden;
  }, [collapsedNodeIds, childrenByParent]);
  const requestRender = useCallback(() => {
    if (animationRef.current !== null) {
      return;
    }

    animationRef.current = window.requestAnimationFrame(() => {
      animationRef.current = null;
      setFrameVersion((value) => value + 1);
    });
  }, []);
  const scene = useMemo(() => {
    const nextLayout = buildGraphLayout(graphData);

    // When layoutKey changes, skip position restore — recompute from scratch.
    // eslint-disable-next-line react-hooks/refs
    const freshLayout = layoutKey !== lastLayoutKeyRef.current;
    lastLayoutKeyRef.current = layoutKey;

    if (!freshLayout) {
      // Restore settled positions from the previous simulation BEFORE React
      // renders. This must happen here (in useMemo) rather than in useEffect,
      // because useEffect runs after the browser has already painted — causing
      // a visible one-frame jump to the new layout positions.
      //
      // We also restore restX/restY so the forceX/forceY forces continue
      // pulling nodes toward where they already are, preventing the sim from
      // animating existing nodes to new layout positions every time graphData
      // changes (archive, mark done, toggle filters, etc.).
      //
      // Reading nodesRef (a ref, not a dep) is intentional: we want the
      // previous sim's settled positions without adding a reactive dependency.
      // eslint-disable-next-line react-hooks/refs
      const prevById = new Map(nodesRef.current.map((n) => [n.id, n]));
      nextLayout.nodes.forEach((node) => {
        if (node.manual_position) return; // fx/fy already pinned
        const prev = prevById.get(node.id);
        if (prev?.x != null && prev?.y != null) {
          node.x = prev.x;
          node.y = prev.y;
          // Preserve rest positions so forces don't pull to new layout
          node.restX = prev.restX;
          node.restY = prev.restY;
        }
      });
    }

    const nodeMap = new Map(nextLayout.nodes.map((node) => [node.id, node]));

    return {
      links: nextLayout.links.map((link) => ({
        ...link,
        source: nodeMap.get(link.source_node_id) ?? link.source_node_id,
        target: nodeMap.get(link.target_node_id) ?? link.target_node_id,
      })),
      nodes: nextLayout.nodes,
    };
  }, [graphData, layoutKey]); // nodesRef, lastLayoutKeyRef intentionally omitted — refs

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

  const getFocusView = useCallback((nodeId: string): ViewTarget | null => {
    const currentViewport = viewportRef.current;

    if (currentViewport.width === 0 || currentViewport.height === 0) {
      return null;
    }

    const focusedNode = nodesRef.current.find((node) => node.id === nodeId);

    if (!focusedNode) {
      return null;
    }

    const targetZoom = clamp(Math.max(viewRef.current.zoom, 0.92), 0.72, 1.1);
    const targetY = currentViewport.height * 0.37;
    const targetX = currentViewport.width * 0.46;
    const nodeX = focusedNode.x ?? focusedNode.restX;
    const nodeY = focusedNode.y ?? focusedNode.restY;
    return {
      panX: targetX - currentViewport.width / 2 - nodeX * targetZoom,
      panY: targetY - currentViewport.height / 2 - nodeY * targetZoom,
      zoom: targetZoom,
    };
  }, []);

  const animateToView = useCallback((nextView: ViewTarget, immediate: boolean) => {
    if (viewAnimationRef.current !== null) {
      window.cancelAnimationFrame(viewAnimationRef.current);
      viewAnimationRef.current = null;
    }

    if (immediate) {
      setView(nextView);
      return;
    }

    const startView = viewRef.current;
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
  }, []);

  const focusNodeInView = useCallback(
    (
      nodeId: string,
      options?: {
        followUp?: boolean;
        immediate?: boolean;
      },
    ) => {
      if (focusFollowUpTimeoutRef.current !== null) {
        window.clearTimeout(focusFollowUpTimeoutRef.current);
        focusFollowUpTimeoutRef.current = null;
      }

      const nextView = getFocusView(nodeId);

      if (!nextView) {
        return false;
      }

      animateToView(nextView, options?.immediate ?? false);

      if (options?.followUp) {
        focusFollowUpTimeoutRef.current = window.setTimeout(() => {
          focusFollowUpTimeoutRef.current = null;
          const retryView = getFocusView(nodeId);

          if (retryView) {
            animateToView(retryView, true);
          }
        }, 240);
      }

      return true;
    },
    [animateToView, getFocusView],
  );

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      onViewChange(view);
    }, 90);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [onViewChange, view]);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    suppressInitialFocusAnimationRef.current = suppressInitialFocusAnimation;
  }, [suppressInitialFocusAnimation]);

  useEffect(() => {
    focusNodeIdRef.current = focusNodeId;
  }, [focusNodeId]);

  useEffect(() => {
    // scene.nodes already have correct positions from the useMemo above.
    // Just update the ref so getFocusView and other imperative reads are current.
    nodesRef.current = scene.nodes;

    const linkForce = forceLink<GraphNode, GraphLink>(scene.links)
      .id((node) => node.id)
      .distance((link) => {
        const source = link.source as GraphNode;
        const target = link.target as GraphNode;

        switch (link.edge_type) {
          case "belongs_to":
            return Math.max(source.height, target.height) + 52;
          case "required_for":
          case "prerequisite_for":
            return Math.max(source.width, target.width) * 0.44 + 120;
          case "supports":
            return Math.max(source.width, target.width) * 0.52 + 150;
          case "related_to":
            return Math.max(source.width, target.width) * 0.68 + 200;
          default:
            return Math.max(source.width, target.width) * 0.56 + 170;
        }
      })
      .strength((link) => {
        switch (link.edge_type) {
          case "belongs_to":
            return 0.24;
          case "required_for":
          case "prerequisite_for":
            return 0.09;
          case "supports":
            return 0.025;
          case "related_to":
            return 0.01;
          default:
            return 0.015;
        }
      }) as ForceLink<GraphNode, GraphLink>;

    const simulation = forceSimulation<GraphNode, GraphLink>(scene.nodes)
      .force("link", linkForce)
      .force(
        "charge",
        forceManyBody<GraphNode>().strength((node) => -60 - node.width * 0.35),
      )
      .force(
        "collide",
        forceCollide<GraphNode>().radius(
          (node) => Math.max(node.width, node.height) * 0.52 + 18,
        ),
      )
      .force("restX", forceX<GraphNode>((node) => node.restX).strength(0.82))
      .force("restY", forceY<GraphNode>((node) => node.restY).strength(0.92))
      .velocityDecay(0.72)
      .alphaDecay(0.12)
      .alphaMin(0.02)
      .alphaTarget(0);

    let didSettleRefit = false;

    simulation.on("tick", () => {
      scene.nodes.forEach((node) => {
        if (node.fx === null || node.fx === undefined) {
          node.x = node.x ?? node.restX;
        } else {
          node.x = node.fx;
          node.vx = 0;
        }

        if (node.fy === null || node.fy === undefined) {
          node.y = node.y ?? node.restY;
        } else {
          node.y = node.fy;
          node.vy = 0;
        }
      });

      requestRender();

      // Once the simulation is mostly settled, re-fit the view so the graph
      // is properly centered.  This is more reliable than simulation.on("end")
      // which can be missed if the sim is stopped externally.
      if (!didSettleRefit && simulation.alpha() < 0.06) {
        const vp = viewportRef.current;
        if (vp.width === 0 || vp.height === 0) return; // retry next tick
        didSettleRefit = true;

        const currentFocusId = focusNodeIdRef.current;
        if (currentFocusId) {
          const retryView = getFocusView(currentFocusId);
          if (retryView) {
            animateToView(retryView, false);
          }
        } else {
          animateToView(createFittedView(scene.nodes, vp.width, vp.height), false);
        }
      }
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
  }, [requestRender, scene]);

  useEffect(() => {
    idleOffsetsRef.current = new Map(
      scene.nodes.map((node) => [node.id, { x: 0, y: 0 } satisfies IdleOffset]),
    );

    const animateIdle = (time: number) => {
      const draggingNodeId = dragStateRef.current?.nodeId ?? null;
      const returningNodeId = returningNodeRef.current?.id ?? null;
      const nextOffsets = new Map<string, IdleOffset>();

      scene.nodes.forEach((node) => {
        const freeze = draggingNodeId === node.id || returningNodeId === node.id;
        const offset = getIdleOffset(node, time, freeze);
        nextOffsets.set(node.id, offset);

        const element = nodeElementRefs.current.get(node.id);

        if (!element) {
          return;
        }

        const baseX = node.x ?? node.restX;
        const baseY = node.y ?? node.restY;
        element.setAttribute(
          "transform",
          `translate(${(baseX + offset.x).toFixed(2)}, ${(baseY + offset.y).toFixed(2)})`,
        );
      });

      idleOffsetsRef.current = nextOffsets;

      scene.links.forEach((link) => {
        const element = linkElementRefs.current.get(link.id);

        if (!element) {
          return;
        }

        element.setAttribute(
          "d",
          getLinkPath(link, draggingNodeId, nextOffsets),
        );
      });

      idleAnimationRef.current = window.requestAnimationFrame(animateIdle);
    };

    idleAnimationRef.current = window.requestAnimationFrame(animateIdle);

    return () => {
      if (idleAnimationRef.current !== null) {
        window.cancelAnimationFrame(idleAnimationRef.current);
        idleAnimationRef.current = null;
      }

      idleOffsetsRef.current = new Map();
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

  // Pinch-to-zoom for touch devices
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function getTouchDistance(t1: Touch, t2: Touch) {
      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    function getTouchMidpoint(t1: Touch, t2: Touch, rect: DOMRect) {
      return {
        x: (t1.clientX + t2.clientX) / 2 - rect.left,
        y: (t1.clientY + t2.clientY) / 2 - rect.top,
      };
    }

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        const mid = getTouchMidpoint(e.touches[0], e.touches[1], rect);
        pinchStateRef.current = {
          initialDistance: getTouchDistance(e.touches[0], e.touches[1]),
          initialZoom: viewRef.current.zoom,
          initialPanX: viewRef.current.panX,
          initialPanY: viewRef.current.panY,
          midX: mid.x,
          midY: mid.y,
        };
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchStateRef.current) {
        e.preventDefault();
        const ps = pinchStateRef.current;
        const dist = getTouchDistance(e.touches[0], e.touches[1]);
        const scale = dist / ps.initialDistance;
        const nextZoom = clamp(ps.initialZoom * scale, 0.25, 2.2);

        const vp = viewportRef.current;
        const worldX = (ps.midX - vp.width / 2 - ps.initialPanX) / ps.initialZoom;
        const worldY = (ps.midY - vp.height / 2 - ps.initialPanY) / ps.initialZoom;

        setView({
          panX: ps.midX - vp.width / 2 - worldX * nextZoom,
          panY: ps.midY - vp.height / 2 - worldY * nextZoom,
          zoom: nextZoom,
        });
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        pinchStateRef.current = null;
      }
    };

    container.addEventListener("touchstart", handleTouchStart, { passive: false });
    container.addEventListener("touchmove", handleTouchMove, { passive: false });
    container.addEventListener("touchend", handleTouchEnd);
    container.addEventListener("touchcancel", handleTouchEnd);

    return () => {
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
      container.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, []);

  useEffect(() => {
    if (didFitInitialViewRef.current) return;
    if (viewport.width === 0 || viewport.height === 0) return;
    if (scene.nodes.length === 0) return;

    didFitInitialViewRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      // Always compute a fresh fitted view from current node positions.
      // The saved initialView from localStorage may be stale if nodes changed
      // since the last session. The simulation settle handler will re-fit
      // again after positions stabilize.
      setView(createFittedView(scene.nodes, viewport.width, viewport.height));
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [scene, viewport.width, viewport.height]);

  useEffect(() => {
    if (!focusNodeId || viewport.width === 0 || viewport.height === 0) {
      return;
    }

    const hasExplicitFocusRequest = focusRequestKey !== lastHandledFocusRequestRef.current;

    if (suppressInitialFocusAnimationRef.current && !hasExplicitFocusRequest) {
      suppressInitialFocusAnimationRef.current = false;
      return;
    }

    suppressInitialFocusAnimationRef.current = false;
    lastHandledFocusRequestRef.current = focusRequestKey;
    const frame = window.requestAnimationFrame(() => {
      focusNodeInView(focusNodeId, { followUp: true });
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [
    focusNodeId,
    focusNodeInView,
    focusRequestKey,
    scene,
    suppressInitialFocusAnimation,
    viewport.height,
    viewport.width,
  ]);

  useEffect(() => {
    return () => {
      if (focusFollowUpTimeoutRef.current !== null) {
        window.clearTimeout(focusFollowUpTimeoutRef.current);
        focusFollowUpTimeoutRef.current = null;
      }

      if (returnAnimationRef.current !== null) {
        window.cancelAnimationFrame(returnAnimationRef.current);
        returnAnimationRef.current = null;
      }
      returningNodeRef.current = null;

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
        draggedNode.x = draggedNode.fx;
        draggedNode.y = draggedNode.fy;
        movedDuringPointerRef.current = true;
        requestRender();
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
          const committedX = draggedNode.fx ?? draggedNode.x ?? draggedNode.restX;
          const committedY = draggedNode.fy ?? draggedNode.y ?? draggedNode.restY;
          const moved = movedDuringPointerRef.current;

          if (!moved) {
            draggedNode.x = draggedNode.restX;
            draggedNode.y = draggedNode.restY;
            draggedNode.vx = 0;
            draggedNode.vy = 0;

            if (draggedNode.manual_position === true) {
              draggedNode.fx = draggedNode.restX;
              draggedNode.fy = draggedNode.restY;
            } else {
              draggedNode.fx = null;
              draggedNode.fy = null;
            }

            requestRender();
          } else if (editMode) {
            draggedNode.manual_position = true;
            draggedNode.position_x = committedX;
            draggedNode.position_y = committedY;
            draggedNode.restX = committedX;
            draggedNode.restY = committedY;
            draggedNode.x = committedX;
            draggedNode.y = committedY;
            draggedNode.fx = committedX;
            draggedNode.fy = committedY;
            draggedNode.vx = 0;
            draggedNode.vy = 0;
            requestRender();
            onCommitNodePosition(draggedNode.id, { x: committedX, y: committedY });
          } else {
            const startX = committedX;
            const startY = committedY;
            const targetX = draggedNode.restX;
            const targetY = draggedNode.restY;
            const shouldRepin = draggedNode.manual_position === true;
            const startTime = performance.now();
            const duration = 260;

            if (returnAnimationRef.current !== null) {
              window.cancelAnimationFrame(returnAnimationRef.current);
              returnAnimationRef.current = null;
            }
            returningNodeRef.current = draggedNode;

            const animateReturn = (now: number) => {
              const progress = clamp((now - startTime) / duration, 0, 1);
              const eased = easeOutCubic(progress);
              const nextX = lerp(startX, targetX, eased);
              const nextY = lerp(startY, targetY, eased);

              draggedNode.fx = nextX;
              draggedNode.fy = nextY;
              draggedNode.x = nextX;
              draggedNode.y = nextY;
              draggedNode.vx = 0;
              draggedNode.vy = 0;
              requestRender();

              if (progress < 1) {
                returnAnimationRef.current = window.requestAnimationFrame(animateReturn);
                return;
              }

              draggedNode.x = targetX;
              draggedNode.y = targetY;
              draggedNode.vx = 0;
              draggedNode.vy = 0;

              if (shouldRepin) {
                draggedNode.fx = targetX;
                draggedNode.fy = targetY;
              } else {
                draggedNode.fx = null;
                draggedNode.fy = null;
              }

              returnAnimationRef.current = null;
              returningNodeRef.current = null;
              requestRender();
            };

            returnAnimationRef.current = window.requestAnimationFrame(animateReturn);
          }
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
  }, [editMode, onCommitNodePosition, requestRender]);

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

  const handleCollapseToggle = useCallback(
    (event: React.MouseEvent, nodeId: string) => {
      event.stopPropagation();
      setCollapsedNodeIds((prev) => {
        const next = new Set(prev);
        if (next.has(nodeId)) {
          next.delete(nodeId);
        } else {
          next.add(nodeId);
        }
        return next;
      });
    },
    [],
  );

  const handleNodePointerDown = (event: ReactPointerEvent<SVGGElement>, nodeId: string) => {
    event.stopPropagation();
    updateAmbientGlow(containerRef.current, event.clientX, event.clientY, 1);

    const targetNode = nodesRef.current.find((node) => node.id === nodeId);

    if (!targetNode) {
      return;
    }

    if (returnAnimationRef.current !== null) {
      window.cancelAnimationFrame(returnAnimationRef.current);
      returnAnimationRef.current = null;
      const returningNode = returningNodeRef.current;

      if (returningNode) {
        returningNode.x = returningNode.restX;
        returningNode.y = returningNode.restY;
        returningNode.vx = 0;
        returningNode.vy = 0;

        if (returningNode.manual_position === true) {
          returningNode.fx = returningNode.restX;
          returningNode.fy = returningNode.restY;
        } else {
          returningNode.fx = null;
          returningNode.fy = null;
        }
      }

      returningNodeRef.current = null;
    }

    const worldPoint = getWorldPoint(
      { x: event.clientX, y: event.clientY },
      viewportRef.current,
      viewRef.current,
    );
    const renderedPosition = getRenderedNodePosition(targetNode, null);

    dragStateRef.current = {
      nodeId,
      offsetX: worldPoint.x - renderedPosition.x,
      offsetY: worldPoint.y - renderedPosition.y,
    };
    movedDuringPointerRef.current = false;
    setDraggingNodeId(nodeId);
    targetNode.x = renderedPosition.x;
    targetNode.y = renderedPosition.y;
    targetNode.fx = renderedPosition.x;
    targetNode.fy = renderedPosition.y;
    targetNode.vx = 0;
    targetNode.vy = 0;
    requestRender();
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
    const nextZoom = clamp(currentView.zoom * Math.exp(-event.deltaY * 0.00112), 0.25, 2.2);

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
            markerHeight="6"
            markerUnits="userSpaceOnUse"
            markerWidth="6"
            orient="auto"
            refX="0.6"
            refY="3"
          >
            <path d="M 0 0 L 6 3 L 0 6 z" fill="rgba(255,255,255,0.38)" />
          </marker>
          <marker
            id="edge-arrow-emphasis"
            markerHeight="6"
            markerUnits="userSpaceOnUse"
            markerWidth="6"
            orient="auto"
            refX="0.6"
            refY="3"
          >
            <path d="M 0 0 L 6 3 L 0 6 z" fill="rgba(198,76,88,0.68)" />
          </marker>
        </defs>

        <g transform={worldTransform}>
          {scene.links.filter(
            (link) =>
              !hiddenNodeIds.has(link.source_node_id) &&
              !hiddenNodeIds.has(link.target_node_id),
          ).map((link) => {
            const emphasized =
              selectedInteraction.connectedEdges.has(link.id) ||
              (!focusNodeId && hoveredInteraction.connectedEdges.has(link.id));
            const dimmed = Boolean(focusNodeId) && !selectedInteraction.connectedEdges.has(link.id);
            const decay = computeEdgeDecay(link);
            const style = getEdgeVisualStyle(link, emphasized, dimmed);
            style.opacity *= decay;

            return (
              <path
                d={getLinkPath(link, draggingNodeId)}
                fill="none"
                key={link.id}
                markerEnd={style.markerEnd}
                opacity={style.opacity}
                ref={(element) => {
                  if (element) {
                    linkElementRefs.current.set(link.id, element);
                  } else {
                    linkElementRefs.current.delete(link.id);
                  }
                }}
                stroke={style.stroke}
                strokeDasharray={style.dashArray}
                strokeLinecap={style.dashArray ? "round" : "butt"}
                strokeLinejoin="round"
                strokeWidth={style.strokeWidth}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}

          {scene.nodes.filter((node) => !hiddenNodeIds.has(node.id)).map((node) => {
            const position = getRenderedNodePosition(node, draggingNodeId);
            const selected = focusNodeId === node.id;
            const hovered = hoveredNodeId === node.id;
            const isCollapsed = collapsedNodeIds.has(node.id);
            const nodeChildCount = (childrenByParent.get(node.id) ?? []).length;
            const hiddenDescendantCount = isCollapsed
              ? countDescendants(node.id, childrenByParent)
              : 0;
            const inHoveredNeighborhood = hoveredInteraction.connectedNodes.has(node.id);
            const inSelectedNeighborhood = selectedInteraction.connectedNodes.has(node.id);
            const searchHit = searchMatches.has(node.id);
            const visual = getNodeVisualState({
              archived: node.status === "archived",
              completed: node.status === "completed",
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
            const nodeRadius = Math.min(node.width, node.height) * 0.44;
            const topBandId = `node-top-band-${node.id}`;
            const actionWashId = `node-action-wash-${node.id}`;
            const actionable = node.node_type === "task";
            const topBandOpacity = actionable
              ? selected
                ? 0.4
                : hovered
                  ? 0.34
                  : searchHit
                    ? 0.3
                    : 0.24
              : visual.surfaceTintOpacity * 2.15;
            const actionWashOpacity = actionable
              ? selected
                ? 0.28
                : hovered
                  ? 0.24
                  : searchHit
                    ? 0.22
                    : 0.2
              : 0;
            const topBandHeight = actionable
              ? clamp(node.height * 0.08, 4, 6)
              : clamp(node.height * 0.094, 5, 7.5);

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
                ref={(element) => {
                  if (element) {
                    nodeElementRefs.current.set(node.id, element);
                  } else {
                    nodeElementRefs.current.delete(node.id);
                  }
                }}
                style={{ cursor: draggingNodeId === node.id ? "grabbing" : nodeChildCount > 0 ? "grab" : "grab" }}
                transform={`translate(${position.x}, ${position.y})`}
              >
                <defs>
                  <linearGradient id={topBandId} x1="0" x2="1" y1="0" y2="0">
                    <stop
                      offset="0%"
                      stopColor={rgba(node.categoryColor, 0)}
                    />
                    <stop
                      offset="18%"
                      stopColor={rgba(node.categoryColor, topBandOpacity * 0.72)}
                    />
                    <stop
                      offset="50%"
                      stopColor={rgba(node.categoryColor, topBandOpacity * 1.56)}
                    />
                    <stop
                      offset="82%"
                      stopColor={rgba(node.categoryColor, topBandOpacity * 0.72)}
                    />
                    <stop offset="100%" stopColor={rgba(node.categoryColor, 0)} />
                  </linearGradient>
                  {actionable ? (
                    <linearGradient id={actionWashId} x1="0" x2="1" y1="0" y2="1">
                      <stop offset="0%" stopColor={rgba("#c44150", actionWashOpacity * 1.12)} />
                      <stop offset="38%" stopColor={rgba("#92293a", actionWashOpacity * 0.8)} />
                      <stop offset="76%" stopColor={rgba("#60131f", actionWashOpacity * 0.34)} />
                      <stop offset="100%" stopColor={rgba("#60131f", 0)} />
                    </linearGradient>
                  ) : null}
                </defs>
                <g filter={nodeFilter}>
                  <rect
                    fill="rgba(4,4,6,0.92)"
                    height={node.height + 6}
                    opacity={visual.shadowOpacity}
                    rx={Math.min(node.width + 6, node.height + 6) * 0.44}
                    width={node.width + 6}
                    x={-(node.width + 6) / 2}
                    y={-(node.height + 6) / 2 + 7}
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
                    fill={`url(#${topBandId})`}
                    height={topBandHeight}
                    opacity={1}
                    rx={Math.max(nodeRadius - 4, 10)}
                    width={node.width - 12}
                    x={-(node.width - 12) / 2}
                    y={-node.height / 2 + 3}
                  />
                  {actionable ? (
                    <rect
                      fill={`url(#${actionWashId})`}
                      height={node.height - 2}
                      opacity={1}
                      rx={Math.max(nodeRadius - 1, 12)}
                      width={node.width - 2}
                      x={-(node.width - 2) / 2}
                      y={-(node.height - 2) / 2}
                    />
                  ) : null}
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
                    strokeWidth={selected ? 1.55 : 1.25}
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
                  <text
                    fill={visual.text}
                    fontFamily="var(--font-geist-sans), sans-serif"
                    fontSize={node.fontSize}
                    fontWeight={560}
                    letterSpacing="-0.02em"
                    textAnchor="middle"
                    textDecoration={node.status === "completed" ? "line-through" : undefined}
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

                {/* Collapsed-children badge — shown when node has hidden subtree */}
                {isCollapsed && hiddenDescendantCount > 0 && (
                  <g
                    style={{ pointerEvents: "none" }}
                    transform={`translate(0, ${node.height / 2 + 11})`}
                  >
                    <rect
                      fill="rgba(196,65,80,0.86)"
                      height={14}
                      rx={7}
                      stroke="rgba(255,255,255,0.12)"
                      strokeWidth={0.8}
                      width={hiddenDescendantCount > 9 ? 28 : 24}
                      x={hiddenDescendantCount > 9 ? -14 : -12}
                      y={-7}
                    />
                    <text
                      fill="rgba(255,255,255,0.92)"
                      fontSize={8}
                      fontWeight={700}
                      letterSpacing="-0.01em"
                      textAnchor="middle"
                      y={3}
                    >
                      +{hiddenDescendantCount}
                    </text>
                  </g>
                )}

                {/* Collapse/expand toggle — clickable on nodes with children */}
                {nodeChildCount > 0 && (
                  <g
                    className="graph-collapse-toggle"
                    onClick={(e) => handleCollapseToggle(e, node.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <circle
                      cx={0}
                      cy={node.height / 2 + 10}
                      fill="rgba(255,255,255,0.06)"
                      r={9}
                    />
                    <text
                      x={0}
                      y={node.height / 2 + 13.5}
                      textAnchor="middle"
                      fill="rgba(255,255,255,0.45)"
                      fontSize="10"
                      fontFamily="ui-sans-serif, system-ui, sans-serif"
                      fontWeight="600"
                    >
                      {isCollapsed ? "▸" : "▾"}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
