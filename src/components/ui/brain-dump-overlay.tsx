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
  errorMessage?: string | null;
  onChange: (value: string) => void;
  onClose: () => void;
  onRetry?: () => void;
  onSubmit: (images: AttachedImage[]) => void;
  retryAvailable?: boolean;
  retrying?: boolean;
  submitting: boolean;
  value: string;
};

// Web Speech API type shim (not in all TS lib versions)
type SpeechRecognitionInstance = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionEvent = {
  resultIndex: number;
  results: {
    [index: number]: {
      isFinal: boolean;
      [index: number]: { transcript: string };
    };
    length: number;
  };
};

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
  }
}

function getSpeechRecognition(): (new () => SpeechRecognitionInstance) | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

export function BrainDumpOverlay({
  errorMessage = null,
  onChange,
  onClose,
  onRetry,
  onSubmit,
  retryAvailable = false,
  retrying = false,
  submitting,
  value,
}: BrainDumpOverlayProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  // Track the transcript appended so far from the current recording session
  // so interim results can be rendered without duplicating committed text.
  const committedTranscriptRef = useRef("");
  const valueAtStartRef = useRef("");

  const [images, setImages] = useState<AttachedImage[]>([]);
  const [recording, setRecording] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [interimText, setInterimText] = useState("");
  const speechSupported = typeof window !== "undefined" && getSpeechRecognition() !== null;

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

  // Stop recognition on unmount
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

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

  // ── Voice transcription (Web Speech API) ───────────────────────────────────

  const stopRecording = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setRecording(false);
    setInterimText("");
    committedTranscriptRef.current = "";
  }, []);

  const startRecording = useCallback(() => {
    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) {
      setMicError("Voice input not supported in this browser");
      return;
    }
    setMicError(null);

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    // Snapshot the textarea value at start so we can safely append to it.
    valueAtStartRef.current = value;
    committedTranscriptRef.current = "";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      let newCommitted = committedTranscriptRef.current;

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          // Append a space between the existing text and the new transcript
          newCommitted += (newCommitted.length > 0 ? " " : "") + transcript.trim();
        } else {
          interim = transcript;
        }
      }

      committedTranscriptRef.current = newCommitted;
      setInterimText(interim);

      // Merge: original value + committed voice text
      const base = valueAtStartRef.current.trimEnd();
      const appended = base.length > 0
        ? base + " " + newCommitted
        : newCommitted;
      onChange(appended);
    };

    recognition.onerror = (event: { error: string }) => {
      if (event.error === "not-allowed") {
        setMicError("Microphone access denied");
      } else if (event.error !== "no-speech") {
        setMicError(`Transcription error: ${event.error}`);
      }
      stopRecording();
    };

    recognition.onend = () => {
      // Auto-restart if user didn't manually stop (handles browser timeout)
      if (recognitionRef.current) {
        try { recognition.start(); } catch { /* ignore if already stopped */ }
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
    setRecording(true);
  }, [value, onChange, stopRecording]);

  const toggleRecording = () => {
    if (recording) {
      stopRecording();
    } else {
      startRecording();
    }
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
          {speechSupported ? (
            <button
              aria-label={recording ? "Stop voice input" : "Start voice input"}
              className={`brain-dump-action-btn${recording ? " brain-dump-action-btn-active" : ""}`}
              onClick={toggleRecording}
              title={recording ? "Stop voice input" : "Dictate"}
              type="button"
            >
              <MicIcon className="h-[15px] w-[15px]" />
              {recording ? <span className="brain-dump-rec-dot" /> : null}
            </button>
          ) : null}
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
