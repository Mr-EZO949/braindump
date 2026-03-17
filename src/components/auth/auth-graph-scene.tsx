"use client";

import { useMemo, useState, type CSSProperties } from "react";

import styles from "@/components/auth/auth-experience.module.css";

const SCENE_WIDTH = 1280;
const SCENE_HEIGHT = 760;
const SCENE_CENTER_X = 824;
const SCENE_CENTER_Y = 348;

type SceneNode = {
  accent: string;
  active?: boolean;
  anchor?: boolean;
  depth: "front" | "mid" | "back";
  height: number;
  id: string;
  label?: string;
  task?: boolean;
  width: number;
  x: number;
  y: number;
};

type SceneEdge = {
  id: string;
  source: string;
  target: string;
  tone: "structural" | "support" | "related";
};

type ProjectedNode = SceneNode & {
  projectedX: number;
  projectedY: number;
  radial: number;
  sceneScale: number;
};

const sceneNodes: SceneNode[] = [
  { accent: "#d8d1c6", active: true, depth: "front", height: 80, id: "n1", label: "Semester Plan", width: 186, x: 804, y: 130 },
  { accent: "#8f5160", depth: "mid", height: 68, id: "n2", width: 154, x: 522, y: 286 },
  { accent: "#8f5160", active: true, anchor: true, depth: "front", height: 72, id: "n3", label: "Research Thread", width: 172, x: 846, y: 282 },
  { accent: "#70808d", depth: "mid", height: 66, id: "n4", width: 158, x: 1110, y: 290 },
  { accent: "#9c7a49", depth: "back", height: 58, id: "n5", width: 124, x: 674, y: 486 },
  { accent: "#9c7a49", depth: "mid", height: 60, id: "n6", label: "Evaluation", width: 134, x: 968, y: 514 },
  { accent: "#b04b57", active: true, depth: "front", height: 58, id: "n7", label: "Prototype", task: true, width: 134, x: 526, y: 658 },
  { accent: "#b04b57", depth: "mid", height: 56, id: "n8", task: true, width: 118, x: 816, y: 674 },
  { accent: "#70808d", depth: "back", height: 58, id: "n9", width: 112, x: 1120, y: 652 },
  { accent: "#70808d", depth: "back", height: 54, id: "n10", width: 104, x: 1264, y: 552 },
  { accent: "#8f5160", depth: "back", height: 56, id: "n11", width: 118, x: 206, y: 500 },
  { accent: "#70808d", depth: "back", height: 54, id: "n12", width: 110, x: 116, y: 320 },
  { accent: "#70808d", depth: "back", height: 52, id: "n13", width: 102, x: 1228, y: 240 },
];

const sceneEdges: SceneEdge[] = [
  { id: "e1", source: "n1", target: "n2", tone: "structural" },
  { id: "e2", source: "n1", target: "n3", tone: "structural" },
  { id: "e3", source: "n1", target: "n4", tone: "structural" },
  { id: "e4", source: "n3", target: "n5", tone: "support" },
  { id: "e5", source: "n3", target: "n6", tone: "support" },
  { id: "e6", source: "n2", target: "n7", tone: "support" },
  { id: "e7", source: "n2", target: "n8", tone: "structural" },
  { id: "e8", source: "n3", target: "n9", tone: "related" },
  { id: "e9", source: "n4", target: "n10", tone: "related" },
  { id: "e10", source: "n11", target: "n2", tone: "related" },
  { id: "e11", source: "n12", target: "n2", tone: "related" },
  { id: "e12", source: "n4", target: "n13", tone: "related" },
];

function buildPath(source: SceneNode, target: SceneNode) {
  const centerX = SCENE_CENTER_X;
  const sourceX = source.x;
  const sourceY = source.y + source.height / 2 - 4;
  const targetX = target.x;
  const targetY = target.y - target.height / 2 + 4;
  const midY = sourceY + (targetY - sourceY) * 0.56;
  const centerPull = (centerX - (sourceX + targetX) / 2) * 0.34;
  const sourceControlX = sourceX + centerPull * 0.48;
  const targetControlX = targetX + centerPull * 0.84;

  return `M ${sourceX} ${sourceY} C ${sourceControlX} ${midY}, ${targetControlX} ${midY}, ${targetX} ${targetY}`;
}

function getDistance(x1: number, y1: number, x2: number, y2: number) {
  const dx = x1 - x2;
  const dy = y1 - y2;

  return Math.sqrt(dx * dx + dy * dy);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function projectNode(node: SceneNode): ProjectedNode {
  const centerX = SCENE_CENTER_X;
  const centerY = SCENE_CENTER_Y;
  const dx = (node.x - centerX) / (SCENE_WIDTH * 0.5);
  const dy = (node.y - centerY) / (SCENE_HEIGHT * 0.5);
  const radial = Math.min(1, Math.sqrt(dx * dx + dy * dy));
  const radialWeight = radial * radial;
  const edgeWeight = Math.abs(dx);
  const recess = clamp(radialWeight * 0.92 + edgeWeight * 0.34, 0, 1);
  const depthOffset =
    node.depth === "front" ? 0.03 : node.depth === "mid" ? -0.05 : -0.12;
  const sceneScale = clamp(1.01 - recess * 0.46 + depthOffset, 0.5, 1.04);
  const projectedX = centerX + (node.x - centerX) * (1 - recess * 0.24);
  const projectedY =
    centerY +
    (node.y - centerY) * (1 - recess * 0.14) -
    edgeWeight * 34 +
    radialWeight * 14;

  return {
    ...node,
    projectedX,
    projectedY,
    radial,
    sceneScale,
  };
}

export function AuthGraphScene() {
  const [pointer, setPointer] = useState({ active: false, x: 0.56, y: 0.44 });

  const projectedNodes = useMemo(
    () =>
      sceneNodes.map((node) => projectNode(node)).reduce<Record<string, ProjectedNode>>(
        (accumulator, node) => {
          accumulator[node.id] = node;
          return accumulator;
        },
        {},
      ),
    [],
  );

  const renderedEdges = useMemo(() => {
    return sceneEdges
      .map((edge) => {
        const source = projectedNodes[edge.source];
        const target = projectedNodes[edge.target];

        if (!source || !target) {
          return null;
        }

        const averageRadial = (source.radial + target.radial) / 2;

        return {
          ...edge,
          averageRadial,
          path: buildPath(
            {
              ...source,
              x: source.projectedX,
              y: source.projectedY,
            },
            {
              ...target,
              x: target.projectedX,
              y: target.projectedY,
            },
          ),
        };
      })
      .filter(
        (edge): edge is SceneEdge & { averageRadial: number; path: string } => edge !== null,
      );
  }, [projectedNodes]);

  const fieldTransform = `perspective(2240px) rotateX(${17.6 - (pointer.y - 0.5) * 1.9}deg) rotateY(${
    9.4 + (pointer.x - 0.5) * 2.9
  }deg) rotateZ(${-10.2 + (pointer.x - 0.5) * 0.95}deg) translate(${-178 + (pointer.x - 0.5) * 18}px, ${
    26 + (pointer.y - 0.5) * 12
  }px) scale(1.132, 0.954)`;

  return (
    <div
      className={styles.sceneViewport}
      onMouseLeave={() => setPointer((current) => ({ ...current, active: false }))}
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setPointer({
          active: true,
          x: (event.clientX - rect.left) / rect.width,
          y: (event.clientY - rect.top) / rect.height,
        });
      }}
    >
      <div className={styles.sceneSurface} />
      <div className={styles.sceneGrid} />
      <div className={styles.sceneBeamPrimary} />
      <div className={styles.sceneBeamSecondary} />
      <div className={styles.sceneHazeFar} />
      <div className={styles.sceneHazeNear} />
      <div
        className={styles.sceneCursorGlow}
        style={{
          opacity: pointer.active ? 1 : 0,
          transform: `translate(${pointer.x * 100}%, ${pointer.y * 100}%)`,
        }}
      />
      <div className={styles.sceneVignette} />
      <div className={styles.sceneField} style={{ transform: fieldTransform }}>
        <svg
          className={styles.sceneSvg}
          viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`}
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="auth-edge-structural" x1="0%" x2="100%" y1="0%" y2="0%">
              <stop offset="0%" stopColor="rgba(224,224,224,0.16)" />
              <stop offset="100%" stopColor="rgba(224,224,224,0.05)" />
            </linearGradient>
            <linearGradient id="auth-edge-support" x1="0%" x2="100%" y1="0%" y2="0%">
              <stop offset="0%" stopColor="rgba(156,86,98,0.15)" />
              <stop offset="100%" stopColor="rgba(156,86,98,0.04)" />
            </linearGradient>
            <linearGradient id="auth-edge-related" x1="0%" x2="100%" y1="0%" y2="0%">
              <stop offset="0%" stopColor="rgba(128,138,146,0.08)" />
              <stop offset="100%" stopColor="rgba(128,138,146,0.02)" />
            </linearGradient>
          </defs>

          {renderedEdges.map((edge) => {
            const stroke =
              edge.tone === "structural"
                ? "url(#auth-edge-structural)"
                : edge.tone === "support"
                  ? "url(#auth-edge-support)"
                  : "url(#auth-edge-related)";
            const width = edge.tone === "structural" ? 2 : edge.tone === "support" ? 1.5 : 1.05;
            const radialFalloff = 1 - edge.averageRadial * 0.46;
            const opacity =
              (edge.tone === "structural" ? 0.88 : edge.tone === "support" ? 0.58 : 0.28) *
              radialFalloff;

            return (
              <path
                key={edge.id}
                className={styles.sceneEdge}
                d={edge.path}
                fill="none"
                opacity={opacity}
                stroke={stroke}
                strokeWidth={width}
              />
            );
          })}
        </svg>

        <div className={styles.sceneNodes}>
          {sceneNodes.map((node, index) => {
            const projectedNode = projectedNodes[node.id];
            const baseScale = projectedNode.sceneScale;
            const pointerX = pointer.x * SCENE_WIDTH;
            const pointerY = pointer.y * SCENE_HEIGHT;
            const distance = getDistance(
              pointerX,
              pointerY,
              projectedNode.projectedX,
              projectedNode.projectedY,
            );
            const proximity = pointer.active ? Math.max(0, 1 - distance / 230) : 0;
            const shiftX = (pointerX - projectedNode.projectedX) * 0.008 * proximity;
            const shiftY = (pointerY - projectedNode.projectedY) * 0.008 * proximity;
            const scale = baseScale + (node.anchor ? 0.056 : 0) + proximity * 0.018;
            const borderAlpha =
              (node.depth === "front" ? 0.08 : node.depth === "mid" ? 0.06 : 0.045) +
              (node.anchor ? 0.04 : 0);

            return (
              <div
                className={`${styles.sceneNodeWrap} ${
                  node.depth === "front"
                    ? styles.sceneNodeFront
                    : node.depth === "mid"
                      ? styles.sceneNodeMid
                      : styles.sceneNodeBack
                }`}
                key={node.id}
                style={{
                  height: `${node.height}px`,
                  left: `${(projectedNode.projectedX / SCENE_WIDTH) * 100}%`,
                  top: `${(projectedNode.projectedY / SCENE_HEIGHT) * 100}%`,
                  transform: `translate(-50%, -50%) translate(${shiftX}px, ${shiftY}px) scale(${scale})`,
                  width: `${node.width}px`,
                }}
              >
                <div
                  className={`${styles.sceneNode} ${node.active ? styles.sceneNodeActive : ""} ${
                    node.anchor ? styles.sceneNodeAnchor : ""
                  }`}
                  style={{
                    "--auth-node-accent": node.accent,
                    animationDelay: `${index * 0.28}s`,
                    borderColor: `rgba(255,255,255,${borderAlpha + proximity * 0.08})`,
                  } as CSSProperties}
                >
                  <div className={styles.sceneNodeBand} />
                  {node.task ? <div className={styles.sceneNodeWash} /> : null}
                  <div className={styles.sceneNodeSheen} />
                  {node.label ? (
                    <div
                      className={`${styles.sceneNodeLabel} ${
                        node.anchor ? styles.sceneNodeLabelAnchor : ""
                      }`}
                    >
                      {node.label}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
