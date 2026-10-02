"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ArrowUpIcon, CloseIcon, ImageIcon, MicIcon } from "@/components/ui/icons";
import { DumpProgressLabel, type DumpProgressState } from "@/components/ui/dump-progress";
import { useVoiceInput } from "@/components/voice/use-voice-input";

type AttachedImage = {
  id: string;
  url: string;
  name: string;
};

type BrainDumpOverlayProps = {
  errorMessage?: string | null;
  onChange: (value: string) => void;
  onClose: () => void;
  onRetry?: () => void;
  onSubmit: (images: AttachedImage[]) => void;
  retryAvailable?: boolean;
  retrying?: boolean;
  submitting: boolean;
  // Where the submitted dump is (streamed by /api/entries).
  progress?: DumpProgressState | null;
  value: string;
};

export function BrainDumpOverlay({
  errorMessage = null,
  onChange,
  onClose,
  onRetry,
  onSubmit,
  retryAvailable = false,
  retrying = false,
  submitting,
  progress = null,
  value,
}: BrainDumpOverlayProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [images, setImages] = useState<AttachedImage[]>([]);

  const {
    supported: speechSupported,
    recording,
    interimText,
    error: micError,
    toggle: toggleRecording,
    stop: stopRecording,
  } = useVoiceInput({ currentValue: value, onChange });

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // ── Image attachment ────────────────────────────────────────────────────────

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const next: AttachedImage[] = files
      .filter((f) => f.type.startsWith("image/"))
      .map((f) => ({
        id: `img-${Date.now()}-${f.name}`,
        url: URL.createObjectURL(f),
        name: f.name,
      }));
    setImages((prev) => [...prev, ...next]);
    e.target.value = "";
  };

  const removeImage = (id: string) => {
    setImages((prev) => {
      const removed = prev.find((img) => img.id === id);
      if (removed) URL.revokeObjectURL(removed.url);
      return prev.filter((img) => img.id !== id);
    });
  };

  // ── Submit ──────────────────────────────────────────────────────────────────

  const handleSubmit = () => {
    if (recording) stopRecording();
    onSubmit(images);
    images.forEach((img) => URL.revokeObjectURL(img.url));
    setImages([]);
  };

  const canSubmit = !submitting && (value.trim().length > 0 || images.length > 0);

  // ── Render ──────────────────────────────────────────────────────────────────

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

      {/* Image previews */}
      {images.length > 0 ? (
        <div className="brain-dump-attachments">
          {images.map((img) => (
            <div className="brain-dump-attachment" key={img.id}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt={img.name} className="brain-dump-thumb" src={img.url} />
              <button
                aria-label={`Remove ${img.name}`}
                className="brain-dump-attachment-remove"
                onClick={() => removeImage(img.id)}
                type="button"
              >
                <CloseIcon className="h-[9px] w-[9px]" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="brain-dump-textarea-wrap">
        <textarea
          className="brain-dump-textarea"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={recording ? "Listening…" : "Drop a raw thought, paste text, or capture it..."}
          ref={textareaRef}
          rows={3}
          value={value}
        />
        {/* Inline interim transcription preview */}
        {recording && interimText ? (
          <span className="brain-dump-interim">{interimText}</span>
        ) : null}
      </div>

      {micError ? <p className="brain-dump-mic-error">{micError}</p> : null}
      {errorMessage ? (
        <div className="brain-dump-error">
          <p className="brain-dump-error-text">{errorMessage}</p>
          {retryAvailable && onRetry ? (
            <button
              className="brain-dump-retry-btn"
              disabled={retrying || submitting}
              onClick={onRetry}
              type="button"
            >
              {retrying ? "Retrying…" : "Retry extraction"}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="brain-dump-footer">
        <div className="brain-dump-actions">
          {/* Hidden file input */}
          <input
            accept="image/*"
            className="hidden"
            multiple
            onChange={handleFileChange}
            ref={fileInputRef}
            type="file"
          />
          <button
            aria-label="Attach image"
            className="brain-dump-action-btn"
            onClick={() => fileInputRef.current?.click()}
            title="Attach image"
            type="button"
          >
            <ImageIcon className="h-[15px] w-[15px]" />
          </button>
          <button
            aria-label={recording ? "Stop voice input" : "Start voice input"}
            className={`brain-dump-action-btn${recording ? " brain-dump-action-btn-active" : ""}`}
            data-supported={speechSupported ? "true" : "false"}
            onClick={toggleRecording}
            title={
              speechSupported
                ? recording
                  ? "Stop voice input"
                  : "Dictate"
                : "Voice input not supported in this browser"
            }
            type="button"
          >
            <MicIcon className="h-[15px] w-[15px]" />
            {recording ? <span className="brain-dump-rec-dot" /> : null}
          </button>
        </div>

        {submitting && progress ? <DumpProgressLabel className="brain-dump-progress" progress={progress} /> : null}

        <button
          aria-label="Submit thought"
          className="composer-send-button"
          disabled={!canSubmit}
          onClick={handleSubmit}
          type="button"
        >
          <ArrowUpIcon className="h-[15px] w-[15px]" />
        </button>
      </div>
    </motion.div>
  );
}
