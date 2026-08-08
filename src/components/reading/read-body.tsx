"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Markdown } from "./markdown";
import styles from "./reading-view.module.css";

// Read-mode body: renders sanitized markdown, plus Presenter mode — a
// screen-recording aid that reveals the body one top-level block at a time so
// content lands in sync with narration.
//
// Presenter works on the rendered DOM: each direct child of the content wrapper
// is one block. Space / → advance, ← back, Esc exits. Already-revealed blocks
// dim; the current one gets a subtle highlight; later blocks aren't shown yet.
// State is intentionally not persisted.
export function ReadBody({
  markdown,
  leadingControl,
}: {
  markdown: string;
  leadingControl?: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [presenting, setPresenting] = useState(false);
  const [step, setStep] = useState(0);
  const [blockCount, setBlockCount] = useState(0);

  const hasBody = markdown.trim().length > 0;

  const exit = useCallback(() => {
    setPresenting(false);
    setStep(0);
  }, []);

  const start = useCallback(() => {
    const total = contentRef.current?.children.length ?? 0;
    if (total === 0) return;
    setBlockCount(total);
    setStep(0);
    setPresenting(true);
  }, []);

  // Paint reveal state onto the block elements, and keep the current block in
  // view as it advances.
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    const blocks = Array.from(container.children) as HTMLElement[];

    if (!presenting) {
      for (const block of blocks) block.removeAttribute("data-reveal");
      return;
    }

    blocks.forEach((block, index) => {
      block.dataset.reveal = index < step ? "past" : index === step ? "current" : "hidden";
    });

    const current = blocks[step];
    if (current) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      current.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    }
  }, [presenting, step]);

  // Keyboard + a body flag so the reading-path arrow nav stands down while
  // presenting.
  useEffect(() => {
    if (!presenting) return;
    document.body.setAttribute("data-presenting", "");

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        exit();
      } else if (event.key === "ArrowRight" || event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        setStep((current) => Math.min(current + 1, blockCount - 1));
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        setStep((current) => Math.max(current - 1, 0));
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.removeAttribute("data-presenting");
    };
  }, [presenting, blockCount, exit]);

  return (
    <div className={styles.readBody}>
      <div className={styles.readControls}>
        {leadingControl}
        {hasBody ? (
          <button type="button" className={styles.editButton} onClick={start}>
            Present
          </button>
        ) : null}
      </div>

      <div ref={contentRef} className={`${styles.content} ${presenting ? styles.presenting : ""}`}>
        {hasBody ? (
          <Markdown body={markdown} />
        ) : (
          <p className={styles.emptyBody}>This node doesn&apos;t have a write-up yet.</p>
        )}
      </div>

      {presenting ? (
        <div className={styles.presenterBar} role="status">
          <span className={styles.presenterStep}>
            {Math.min(step + 1, blockCount)} / {blockCount}
          </span>
          <span className={styles.presenterHint}>Space to advance · Esc to exit</span>
          <button type="button" className={styles.presenterExit} onClick={exit}>
            Exit
          </button>
        </div>
      ) : null}
    </div>
  );
}
