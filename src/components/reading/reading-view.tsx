import type { ReactNode } from "react";
import Link from "next/link";

import type { ReadingViewData } from "@/lib/graph/reading-view";

import { EditableBody } from "./editable-body";
import { ReadBody } from "./read-body";
import { ReadingKeyboardNav } from "./reading-keyboard-nav";
import { ReadingMinimap } from "./reading-minimap";
import styles from "./reading-view.module.css";

function formatUpdated(value: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(value));
}

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function ReadingView({
  data,
  nodeHref = (id) => `/n/${id}`,
  editable = true,
  minimapHref = "/app",
  showOrderLink = true,
  topSlot,
}: {
  data: ReadingViewData;
  nodeHref?: (nodeId: string) => string;
  editable?: boolean;
  minimapHref?: string;
  showOrderLink?: boolean;
  topSlot?: ReactNode;
}) {
  const { node, workspace, connections, neighbors, prev, next } = data;
  const prevHref = prev ? nodeHref(prev.id) : null;
  const nextHref = next ? nodeHref(next.id) : null;
  const hasConnections = connections.direct.length > 0 || connections.hidden.length > 0;

  return (
    <main className={styles.page}>
      {topSlot}
      <div className={styles.wrap}>
        <header>
          <div className={styles.metaTop}>
            <span className={styles.typeTag}>
              {workspace ? `${workspace.name} · ` : ""}
              {titleCase(node.node_type)}
            </span>
            <span className={styles.updated}>Updated {formatUpdated(node.updated_at)}</span>
          </div>
          <h1 className={styles.title}>{node.title}</h1>
          {node.summary ? <p className={styles.standfirst}>{node.summary}</p> : null}
          <div className={styles.rule} />
        </header>

        <article className={styles.article}>
          {editable ? (
            <EditableBody nodeId={node.id} initialMarkdown={node.body ?? ""} />
          ) : (
            <ReadBody markdown={node.body ?? ""} />
          )}
        </article>

        {hasConnections ? (
          <nav className={styles.connections} aria-label="Connections">
            <h2 className={styles.connTitle}>Connections</h2>
            <div className={styles.connCols}>
              <div>
                <p className={styles.connLabel}>Direct</p>
                {connections.direct.length > 0 ? (
                  <ul className={`${styles.connList} ${styles.connDirect}`}>
                    {connections.direct.map((connection) => (
                      <li key={`d-${connection.id}-${connection.edge_type}`}>
                        <Link href={nodeHref(connection.id)}>{connection.title}</Link>
                        <span className={styles.connRel}>{connection.label}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.connEmpty}>None</p>
                )}
              </div>
              <div>
                <p className={styles.connLabel}>Hidden</p>
                {connections.hidden.length > 0 ? (
                  <ul className={`${styles.connList} ${styles.connHidden}`}>
                    {connections.hidden.map((connection) => (
                      <li key={`h-${connection.id}-${connection.edge_type}`}>
                        <Link href={nodeHref(connection.id)}>{connection.title}</Link>
                        <span className={styles.connRel}>{connection.label}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.connEmpty}>None</p>
                )}
              </div>
            </div>
          </nav>
        ) : null}

        <nav className={styles.pathnav} aria-label="Reading path">
          {prevHref ? (
            <Link href={prevHref} className={styles.pathLink}>
              <span className={styles.pathDir}>← Prev</span>
              <span className={styles.pathTtl}>{prev?.title}</span>
            </Link>
          ) : (
            <span className={`${styles.pathLink} ${styles.pathDisabled}`}>
              <span className={styles.pathDir}>← Prev</span>
              <span className={styles.pathTtl}>Start of the path</span>
            </span>
          )}
          {nextHref ? (
            <Link href={nextHref} className={`${styles.pathLink} ${styles.pathNext}`}>
              <span className={styles.pathDir}>Next →</span>
              <span className={styles.pathTtl}>{next?.title}</span>
            </Link>
          ) : (
            <span className={`${styles.pathLink} ${styles.pathNext} ${styles.pathDisabled}`}>
              <span className={styles.pathDir}>Next →</span>
              <span className={styles.pathTtl}>End of the path</span>
            </span>
          )}
        </nav>

        {showOrderLink && editable && workspace ? (
          <p className={styles.orderLinkRow}>
            <Link href={`/app/reading-order?w=${workspace.id}`} className={styles.orderLink}>
              Set reading order
            </Link>
            <span className={styles.orderLinkSep} aria-hidden="true">
              ·
            </span>
            <Link href="/app/share" className={styles.orderLink}>
              Share graph
            </Link>
          </p>
        ) : null}
      </div>

      <ReadingMinimap
        workspaceName={workspace?.name ?? null}
        neighbors={neighbors}
        href={minimapHref}
      />
      <ReadingKeyboardNav prevHref={prevHref} nextHref={nextHref} />
    </main>
  );
}
