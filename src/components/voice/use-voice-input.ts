"use client";

// useVoiceInput — shared Web Speech API binding for any text input.
// Caller passes the current value + onChange; the hook appends committed
// transcripts to the original value while exposing the interim text for
// inline preview. Auto-restarts on browser timeout, stops cleanly on
// unmount, surfaces permission/error states.
//
// Web Speech API is Chrome/Safari only — `supported` is false in Firefox
// and the UI should hide the mic button in that case.

import { useCallback, useEffect, useRef, useState } from "react";

// Web Speech API isn't in default lib.dom yet, so we shim the slice we use.
type SpeechRecognitionResult = {
  isFinal: boolean;
  [index: number]: { transcript: string };
};

type SpeechRecognitionEvent = {
  resultIndex: number;
  results: {
    [index: number]: SpeechRecognitionResult;
    length: number;
  };
};

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

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
  }
}

function getSpeechRecognitionCtor():
  | (new () => SpeechRecognitionInstance)
  | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

export type UseVoiceInputResult = {
  supported: boolean;
  recording: boolean;
  interimText: string;
  error: string | null;
  toggle: () => void;
  stop: () => void;
};

export function useVoiceInput(opts: {
  currentValue: string;
  onChange: (next: string) => void;
}): UseVoiceInputResult {
  const { currentValue, onChange } = opts;

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const committedTranscriptRef = useRef("");
  const valueAtStartRef = useRef("");
  // Keep the live value in a ref so the onresult handler always sees the
  // latest one without re-binding the callback (which would tear down + recreate
  // the recognition instance on every keystroke).
  const currentValueRef = useRef(currentValue);
  useEffect(() => {
    currentValueRef.current = currentValue;
  }, [currentValue]);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const [recording, setRecording] = useState(false);
  const [interimText, setInterimText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const supported = getSpeechRecognitionCtor() !== null;

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setRecording(false);
    setInterimText("");
    committedTranscriptRef.current = "";
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      recognitionRef.current = null;
    };
  }, []);

  const start = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setError("Voice input not supported in this browser");
      return;
    }
    setError(null);

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    valueAtStartRef.current = currentValueRef.current;
    committedTranscriptRef.current = "";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      let newCommitted = committedTranscriptRef.current;

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          newCommitted +=
            (newCommitted.length > 0 ? " " : "") + transcript.trim();
        } else {
          interim = transcript;
        }
      }

      committedTranscriptRef.current = newCommitted;
      setInterimText(interim);

      const base = valueAtStartRef.current.trimEnd();
      const appended =
        base.length > 0 ? base + " " + newCommitted : newCommitted;
      onChangeRef.current(appended);
    };

    recognition.onerror = (event: { error: string }) => {
      if (event.error === "not-allowed") {
        setError("Microphone access denied");
      } else if (event.error !== "no-speech") {
        setError(`Transcription error: ${event.error}`);
      }
      stop();
    };

    recognition.onend = () => {
      // Browser idle-timed-out. Auto-restart if we're still in the "recording"
      // logical state (i.e. user didn't press stop).
      if (recognitionRef.current) {
        try {
          recognition.start();
        } catch {
          // already stopped — leave as-is
        }
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
    setRecording(true);
  }, [stop]);

  const toggle = useCallback(() => {
    if (recording) stop();
    else start();
  }, [recording, start, stop]);

  return { supported, recording, interimText, error, toggle, stop };
}
