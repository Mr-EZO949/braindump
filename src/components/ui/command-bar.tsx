"use client";

// Unified command bar — Phase 1 of the "graph as engine" vision.
// A single input that routes to braindump / chat / plan / edit / status
// based on an LLM-classified intent. Opens on ⌘K / Ctrl+K.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { motion, AnimatePresence } from "framer-motion";

import { ArrowUpIcon, CloseIcon } from "@/components/ui/icons";
import type { IntentType } from "@/types/ai";

type CommandBarProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string | null;
  onDispatch: (intent: IntentType, text: string) => void | Promise<void>;
};

type Phase =
  | { kind: "idle" }
  | { kind: "classifying" }
  | {
      kind: "clarify";
      intent: IntentType;
      confidence: number;
      rationale: string;
      clarifyingQuestion: string;
    }
  | { kind: "error"; message: string };

const INTENT_LABEL: Record<IntentType, string> = {
  braindump: "Brain dump",
  question: "Ask",
  plan: "Plan",
  edit: "Edit graph",
  status: "What now",
  unclear: "Not sure",
};

const MANUAL_OPTIONS: IntentType[] = [
  "braindump",
  "question",
  "plan",
  "edit",
  "status",
];

export function CommandBar({ open, onOpenChange, workspaceId, onDispatch }: CommandBarProps) {
  const [value, setValue] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Focus the input whenever the bar opens.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => textareaRef.current?.focus(), 20);
      return () => clearTimeout(t);
    }
    setPhase({ kind: "idle" });
    return;
  }, [open]);

  // Global ⌘K / Ctrl+K toggle + Escape to close.
  useEffect(() => {
    function handler(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
        return;
      }
      if (open && e.key === "Escape") {
        e.preventDefault();
        onOpenChange(false);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onOpenChange]);

  const reset = useCallback(() => {
    setValue("");
    setPhase({ kind: "idle" });
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const close = useCallback(() => {
    reset();
    onOpenChange(false);
  }, [onOpenChange, reset]);

  const dispatchIntent = useCallback(
    async (intent: IntentType, text: string) => {
      if (!text.trim()) return;
      try {
        await onDispatch(intent, text.trim());
      } finally {
        close();
      }
    },
    [onDispatch, close],
  );

  const classify = useCallback(async () => {
    const text = value.trim();
    if (!text || !workspaceId || phase.kind === "classifying") return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: "classifying" });

    try {
      const res = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, workspace_id: workspaceId }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setPhase({
          kind: "error",
          message: data.error ?? "Could not classify that. Pick one below.",
        });
        return;
      }

      const data = (await res.json()) as {
        intent: IntentType;
        confidence: number;
        rationale: string;
        clarifying_question: string | null;
      };

      const needsClarify =
        data.intent === "unclear" ||
        data.confidence < 0.55 ||
        !!data.clarifying_question;

      if (needsClarify) {
        setPhase({
          kind: "clarify",
          intent: data.intent,
          confidence: data.confidence,
          rationale: data.rationale,
          clarifyingQuestion:
            data.clarifying_question ?? "Which of these matches what you want?",
        });
        return;
      }

      await dispatchIntent(data.intent, text);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setPhase({
        kind: "error",
        message: "Network hiccup. Pick an intent below or retry.",
      });
    }
  }, [value, workspaceId, phase.kind, dispatchIntent]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void classify();
    }
  }

  const busy = phase.kind === "classifying";
  const canSubmit = value.trim().length > 0 && !!workspaceId && !busy;

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="command-bar-root"
          className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-24"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <button
            aria-label="Close command bar"
            className="absolute inset-0 bg-black/30 backdrop-blur-[2px]"
            onClick={close}
            type="button"
          />

          <motion.div
            role="dialog"
            aria-label="Command bar"
            className="relative w-full max-w-xl rounded-2xl border border-[var(--color-border-faint)] bg-[var(--color-bg-shell)] shadow-2xl"
            initial={{ y: -12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -8, opacity: 0 }}
            transition={{ duration: 0.14 }}
          >
            <div className="flex items-start gap-3 px-4 pt-4">
              <div className="mt-1 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                Ask / Dump / Do
              </div>
              <div className="flex-1" />
              <button
                aria-label="Close"
                className="rounded-full p-1 text-[var(--color-text-muted)] transition hover:bg-black/5 hover:text-[var(--color-text)]"
                onClick={close}
                type="button"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>

            <div className="px-4 py-3">
              <textarea
                ref={textareaRef}
                className="min-h-[68px] w-full resize-none border-0 bg-transparent text-[15px] leading-relaxed text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
                maxLength={4000}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  workspaceId
                    ? "Drop a thought, ask a question, or plan your next hour…"
                    : "Pick a workspace first."
                }
                rows={3}
                value={value}
              />
            </div>

            {phase.kind === "clarify" ? (
              <div className="border-t border-[var(--color-border-faint)] px-4 py-3">
                <div className="mb-2 text-xs text-[var(--color-text-muted)]">
                  {phase.clarifyingQuestion}
                  <span className="ml-2 opacity-70">
                    (best guess: {INTENT_LABEL[phase.intent]} · {(phase.confidence * 100).toFixed(0)}%)
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {MANUAL_OPTIONS.map((option) => (
                    <button
                      key={option}
                      className="rounded-full border border-[var(--color-border-faint)] px-3 py-1 text-xs text-[var(--color-text)] transition hover:border-[var(--color-text-muted)] hover:bg-black/5"
                      onClick={() => void dispatchIntent(option, value)}
                      type="button"
                    >
                      {INTENT_LABEL[option]}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {phase.kind === "error" ? (
              <div className="border-t border-[var(--color-border-faint)] px-4 py-3">
                <div className="mb-2 text-xs text-red-500">{phase.message}</div>
                <div className="flex flex-wrap gap-1.5">
                  {MANUAL_OPTIONS.map((option) => (
                    <button
                      key={option}
                      className="rounded-full border border-[var(--color-border-faint)] px-3 py-1 text-xs text-[var(--color-text)] transition hover:border-[var(--color-text-muted)] hover:bg-black/5"
                      onClick={() => void dispatchIntent(option, value)}
                      type="button"
                    >
                      {INTENT_LABEL[option]}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex items-center justify-between border-t border-[var(--color-border-faint)] px-4 py-2.5">
              <div className="text-[11px] text-[var(--color-text-muted)]">
                {busy
                  ? "Reading your intent…"
                  : "Press Enter to send · ⌘K to toggle · Esc to close"}
              </div>
              <button
                aria-label="Send"
                className="flex items-center gap-1.5 rounded-full bg-[var(--color-text)] px-3 py-1.5 text-xs font-medium text-[var(--color-bg-shell)] transition disabled:opacity-40"
                disabled={!canSubmit}
                onClick={() => void classify()}
                type="button"
              >
                <ArrowUpIcon className="h-3 w-3" />
                Go
              </button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
