"use client";

import { useState } from "react";

import { NodeBodyEditor } from "./node-body-editor";
import { ReadBody } from "./read-body";
import styles from "./reading-view.module.css";

// Read ⇄ edit toggle for the node body on the authed reading view. Read mode
// delegates to ReadBody (markdown + presenter); edit mode swaps in the TipTap
// editor, which autosaves. `markdown` is lifted here so a save reflects
// immediately when the user flips back to read mode without a round-trip.
export function EditableBody({
  nodeId,
  initialMarkdown,
}: {
  nodeId: string;
  initialMarkdown: string;
}) {
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [markdown, setMarkdown] = useState(initialMarkdown);

  if (mode === "edit") {
    return (
      <NodeBodyEditor
        nodeId={nodeId}
        initialMarkdown={markdown}
        onSavedMarkdown={setMarkdown}
        onDone={() => setMode("read")}
      />
    );
  }

  return (
    <ReadBody
      markdown={markdown}
      leadingControl={
        <button type="button" className={styles.editButton} onClick={() => setMode("edit")}>
          Edit
        </button>
      }
    />
  );
}
