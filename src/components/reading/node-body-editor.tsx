"use client";

import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { EditorView } from "@tiptap/pm/view";
import { Markdown } from "tiptap-markdown";
import { useCallback, useEffect, useRef, useState } from "react";

import styles from "./reading-view.module.css";

type SaveStatus = "idle" | "unsaved" | "saving" | "saved" | "error";

function getMarkdownFromEditor(editor: { storage: Record<string, unknown> }): string {
  const markdownStorage = editor.storage.markdown as
    | { getMarkdown?: () => string }
    | undefined;
  return markdownStorage?.getMarkdown?.() ?? "";
}

async function uploadImageFile(file: File, nodeId: string): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  form.append("nodeId", nodeId);
  const res = await fetch("/api/images", { method: "POST", body: form });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? `upload failed: ${res.status}`);
  }
  const data = (await res.json()) as { url: string };
  return data.url;
}

// TipTap (ProseMirror) body editor. StarterKit gives the markdown input rules
// out of the box (## → heading, - → bullet, > → quote, ``` → code block, etc.);
// tiptap-markdown parses the stored markdown in and serialises it back out — so
// Postgres only ever holds markdown, never HTML. Images are dropped or pasted
// in, uploaded to Storage, and inserted as standard markdown image nodes.
export function NodeBodyEditor({
  nodeId,
  initialMarkdown,
  onSavedMarkdown,
  onDone,
}: {
  nodeId: string;
  initialMarkdown: string;
  onSavedMarkdown?: (markdown: string) => void;
  onDone?: () => void;
}) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [uploadingCount, setUploadingCount] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef(initialMarkdown);
  const savedRef = useRef(initialMarkdown);
  const editorRef = useRef<Editor | null>(null);

  const save = useCallback(
    async (markdown: string) => {
      if (markdown === savedRef.current) {
        setStatus("saved");
        return;
      }
      setStatus("saving");
      try {
        const res = await fetch(`/api/nodes/${nodeId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: markdown }),
        });
        if (!res.ok) throw new Error(`save failed: ${res.status}`);
        savedRef.current = markdown;
        setStatus("saved");
        onSavedMarkdown?.(markdown);
      } catch {
        setStatus("error");
      }
    },
    [nodeId, onSavedMarkdown],
  );

  // Upload each image file, then insert it as an image node (which
  // tiptap-markdown serialises to `![](url)`). `atPos` targets a drop point;
  // pasted images go in at the current selection.
  const insertImageFiles = useCallback(
    (files: File[], atPos?: number) => {
      const images = files.filter((file) => file.type.startsWith("image/"));
      if (images.length === 0) return;
      setUploadError(null);

      for (const file of images) {
        setUploadingCount((count) => count + 1);
        void uploadImageFile(file, nodeId)
          .then((url) => {
            const editor = editorRef.current;
            if (!editor) return;
            const chain = editor.chain().focus();
            if (typeof atPos === "number") {
              chain.insertContentAt(atPos, { type: "image", attrs: { src: url } });
            } else {
              chain.setImage({ src: url });
            }
            chain.run();
          })
          .catch((error: unknown) => {
            setUploadError(error instanceof Error ? error.message : "Image upload failed");
          })
          .finally(() => {
            setUploadingCount((count) => Math.max(0, count - 1));
          });
      }
    },
    [nodeId],
  );

  const editor = useEditor({
    // Next SSR: don't render on the server, avoids a hydration mismatch.
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] }, // h1 is the node title; body uses two levels
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" },
      }),
      Image.configure({ inline: false, allowBase64: false }),
      Placeholder.configure({ placeholder: "Write the story of this node…" }),
      Markdown.configure({ html: false, linkify: true, transformPastedText: true }),
    ],
    content: initialMarkdown,
    editorProps: {
      handlePaste: (_view: EditorView, event: ClipboardEvent) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
          file.type.startsWith("image/"),
        );
        if (files.length === 0) return false;
        event.preventDefault();
        insertImageFiles(files);
        return true;
      },
      handleDrop: (view: EditorView, event: DragEvent, _slice: unknown, moved: boolean) => {
        if (moved) return false; // internal node drag, not an external file
        const files = Array.from(event.dataTransfer?.files ?? []).filter((file) =>
          file.type.startsWith("image/"),
        );
        if (files.length === 0) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        insertImageFiles(files, pos);
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      const markdown = getMarkdownFromEditor(editor);
      latestRef.current = markdown;
      setStatus("unsaved");
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => void save(markdown), 800);
    },
  });

  editorRef.current = editor;

  // Flush any pending edit when leaving edit mode / unmounting.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (latestRef.current !== savedRef.current) {
        void save(latestRef.current);
      }
    };
  }, [save]);

  const flushAndDone = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    void save(latestRef.current);
    onDone?.();
  };

  return (
    <div className={styles.editorWrap}>
      <div className={styles.editorBar}>
        {uploadingCount > 0 ? (
          <span className={styles.saveStatus} aria-live="polite">
            Uploading image…
          </span>
        ) : uploadError ? (
          <span className={styles.saveStatusError}>{uploadError}</span>
        ) : (
          <SaveIndicator status={status} onRetry={() => void save(latestRef.current)} />
        )}
        <button type="button" className={styles.editDone} onClick={flushAndDone}>
          Done
        </button>
      </div>
      <EditorContent editor={editor} />
      <p className={styles.editorHint}>
        Markdown shortcuts work as you type. Drag or paste an image to embed it.
      </p>
    </div>
  );
}

function SaveIndicator({ status, onRetry }: { status: SaveStatus; onRetry: () => void }) {
  if (status === "error") {
    return (
      <button type="button" className={styles.saveStatusError} onClick={onRetry}>
        Couldn&apos;t save — retry
      </button>
    );
  }
  const label =
    status === "saving"
      ? "Saving…"
      : status === "unsaved"
        ? "Unsaved"
        : status === "saved"
          ? "Saved"
          : "";
  return (
    <span className={styles.saveStatus} aria-live="polite">
      {label}
    </span>
  );
}
