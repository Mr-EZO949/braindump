"use client";

import { useState } from "react";

import styles from "@/app/app/reading-order/reading-order.module.css";

type NodeRow = {
  id: string;
  title: string;
  node_type: string;
  reading_order: number | null;
};

type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

function move<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) {
    return list;
  }
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function ReadingOrderEditor({
  workspaceId,
  initialNodes,
}: {
  workspaceId: string;
  initialNodes: NodeRow[];
}) {
  const [items, setItems] = useState<NodeRow[]>(initialNodes);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [status, setStatus] = useState<SaveStatus>("idle");

  function reorder(from: number, to: number) {
    setItems((current) => move(current, from, to));
    setStatus("dirty");
  }

  async function save() {
    setStatus("saving");
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/reading-order`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds: items.map((node) => node.id) }),
      });
      if (!res.ok) throw new Error(`save failed: ${res.status}`);
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }

  if (items.length === 0) {
    return <p className={styles.empty}>This workspace has no nodes yet.</p>;
  }

  return (
    <div className={styles.editor}>
      <div className={styles.toolbar}>
        <span className={styles.count}>{items.length} nodes</span>
        <div className={styles.toolbarRight}>
          <span className={styles.saveState} aria-live="polite">
            {status === "saving"
              ? "Saving…"
              : status === "saved"
                ? "Saved"
                : status === "error"
                  ? "Couldn't save"
                  : status === "dirty"
                    ? "Unsaved changes"
                    : ""}
          </span>
          <button
            type="button"
            className={styles.saveButton}
            onClick={() => void save()}
            disabled={status === "saving" || status === "idle"}
          >
            Save order
          </button>
        </div>
      </div>

      <ol className={styles.list}>
        {items.map((node, index) => (
          <li
            key={node.id}
            className={`${styles.row} ${dragIndex === index ? styles.rowDragging : ""}`}
            draggable
            onDragStart={() => setDragIndex(index)}
            onDragOver={(event) => {
              event.preventDefault();
              if (dragIndex !== null && dragIndex !== index) {
                reorder(dragIndex, index);
                setDragIndex(index);
              }
            }}
            onDragEnd={() => setDragIndex(null)}
          >
            <span className={styles.handle} aria-hidden="true">⠿</span>
            <span className={styles.position}>{index + 1}</span>
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>{node.title}</span>
              <span className={styles.rowType}>{node.node_type}</span>
            </span>
            <span className={styles.rowButtons}>
              <button
                type="button"
                className={styles.moveButton}
                aria-label={`Move ${node.title} up`}
                disabled={index === 0}
                onClick={() => reorder(index, index - 1)}
              >
                ↑
              </button>
              <button
                type="button"
                className={styles.moveButton}
                aria-label={`Move ${node.title} down`}
                disabled={index === items.length - 1}
                onClick={() => reorder(index, index + 1)}
              >
                ↓
              </button>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
