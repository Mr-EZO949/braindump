"use client";

import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { ArrowUpIcon, CloseIcon } from "@/components/ui/icons";

type BrainDumpOverlayProps = {
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
  submitting: boolean;
  value: string;
};

export function BrainDumpOverlay({
  onChange,
  onClose,
  onSubmit,
  submitting,
  value,
}: BrainDumpOverlayProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <motion.div
      className="brain-dump-card"
      initial={{ opacity: 0, y: 14, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.98 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="brain-dump-header">
        <span className="brain-dump-label">Brain Dump</span>
        <button
          aria-label="Dismiss brain dump"
          className="brain-dump-dismiss"
          onClick={onClose}
          type="button"
        >
          <CloseIcon className="h-[13px] w-[13px]" />
        </button>
      </div>

      <textarea
        className="brain-dump-textarea"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder="Drop a raw thought, paste text, or ask the graph to capture it..."
        ref={textareaRef}
        rows={3}
        value={value}
      />

      <div className="brain-dump-footer">
        <button
          aria-label="Submit thought"
          className="composer-send-button"
          disabled={submitting || value.trim().length === 0}
          onClick={onSubmit}
          type="button"
        >
          <ArrowUpIcon className="h-[15px] w-[15px]" />
        </button>
      </div>
    </motion.div>
  );
}
