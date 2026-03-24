"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ArrowUpIcon, CloseIcon, ImageIcon, MicIcon } from "@/components/ui/icons";

type AttachedImage = {
  id: string;
  url: string;
  name: string;
};

type BrainDumpOverlayProps = {
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (images: AttachedImage[]) => void;
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const [images, setImages] = useState<AttachedImage[]>([]);
  const [recording, setRecording] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);

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
    // reset input so same file can be re-selected
    e.target.value = "";
  };

  const removeImage = (id: string) => {
    setImages((prev) => {
      const removed = prev.find((img) => img.id === id);
      if (removed) URL.revokeObjectURL(removed.url);
      return prev.filter((img) => img.id !== id);
    });
  };

  // ── Voice recording ─────────────────────────────────────────────────────────

  const startRecording = useCallback(async () => {
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const url = URL.createObjectURL(blob);
        // Append voice note as a special image-like attachment (audio preview)
        setImages((prev) => [
          ...prev,
          { id: `voice-${Date.now()}`, url, name: "Voice note" },
        ]);
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
    } catch {
      setMicError("Microphone access denied");
    }
  }, []);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setRecording(false);
  }, []);

  const toggleRecording = () => {
    if (recording) {
      stopRecording();
    } else {
      void startRecording();
    }
  };

  // ── Submit ──────────────────────────────────────────────────────────────────

  const handleSubmit = () => {
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
              {img.name === "Voice note" ? (
                <div className="brain-dump-voice-chip">
                  <MicIcon className="h-[12px] w-[12px]" />
                  <span>Voice note</span>
                </div>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img alt={img.name} className="brain-dump-thumb" src={img.url} />
              )}
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

      <textarea
        className="brain-dump-textarea"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
          }
        }}
        placeholder="Drop a raw thought, paste text, or capture it..."
        ref={textareaRef}
        rows={3}
        value={value}
      />

      {micError ? <p className="brain-dump-mic-error">{micError}</p> : null}

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
            aria-label={recording ? "Stop recording" : "Record voice note"}
            className={`brain-dump-action-btn${recording ? " brain-dump-action-btn-active" : ""}`}
            onClick={toggleRecording}
            title={recording ? "Stop recording" : "Record voice"}
            type="button"
          >
            <MicIcon className="h-[15px] w-[15px]" />
            {recording ? <span className="brain-dump-rec-dot" /> : null}
          </button>
        </div>

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
