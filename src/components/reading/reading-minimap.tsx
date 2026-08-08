import Link from "next/link";

import type { ReadingNeighborPoint } from "@/lib/graph/reading-view";

import styles from "./reading-view.module.css";

// Bottom-right minimap. For now it shows the current node and its immediate
// neighbourhood in a simple radial layout (direct = solid link, hidden =
// dashed), which is enough orientation for a single-node read. Step 5 swaps
// this for the real graph minimap with true positions. Tapping it returns to
// the full graph.
export function ReadingMinimap({
  workspaceName,
  neighbors,
  href = "/app",
}: {
  workspaceName: string | null;
  neighbors: ReadingNeighborPoint[];
  href?: string;
}) {
  const shown = neighbors.slice(0, 9);
  const cx = 50;
  const cy = 50;
  const radius = 34;

  const points = shown.map((neighbor, index) => {
    const angle = (index / Math.max(1, shown.length)) * Math.PI * 2 - Math.PI / 2;
    return {
      ...neighbor,
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    };
  });

  return (
    <Link
      href={href}
      className={styles.minimap}
      aria-label="Open the full graph"
      title="Open the full graph"
    >
      <svg viewBox="0 0 100 100" aria-hidden="true">
        {points.map((point) => (
          <line
            key={`l-${point.id}`}
            className={`${styles.mmLink} ${point.family === "hidden" ? styles.mmHidden : ""}`}
            x1={cx}
            y1={cy}
            x2={point.x}
            y2={point.y}
          />
        ))}
        {points.map((point) => (
          <circle key={`n-${point.id}`} className={styles.mmNode} cx={point.x} cy={point.y} r={2.6} />
        ))}
        <circle className={styles.mmHereRing} cx={cx} cy={cy} r={7} />
        <circle className={styles.mmHere} cx={cx} cy={cy} r={4} />
      </svg>
      {workspaceName ? <span className={styles.minimapLabel}>{workspaceName}</span> : null}
    </Link>
  );
}
