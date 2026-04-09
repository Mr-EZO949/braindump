"use client";

import { useCallback, useEffect, useState } from "react";

interface TourStep {
  target: string;
  title: string;
  body: string;
  position: "center" | "above" | "below";
}

const STEPS: TourStep[] = [
  {
    target: "graph-area",
    title: "Your knowledge graph",
    body: "This is where all your nodes live — goals, tasks, ideas, and more. They're connected in a visual graph you can explore, rearrange, and filter.",
    position: "center",
  },
  {
    target: "braindump-btn",
    title: "Brain Dump",
    body: "Hit this to offload whatever is on your mind. Type or speak freely — the AI breaks it into structured nodes and adds them to your graph.",
    position: "above",
  },
  {
    target: "assistant-btn",
    title: "Assistant",
    body: "An AI that knows your entire workspace. Ask it to plan your day, explain connections, or help you prioritize.",
    position: "above",
  },
  {
    target: "context-rail",
    title: "Node details",
    body: "Select any node on the graph to see its details here — description, connections, status, and importance. You can edit everything inline.",
    position: "center",
  },
];

interface Props {
  onDone: () => void;
}

export function GuidedTour({ onDone }: Props) {
  const [step, setStep] = useState(0);
  const [spotRect, setSpotRect] = useState<DOMRect | null>(null);

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  const measure = useCallback(() => {
    const el = document.querySelector(`[data-tour="${current.target}"]`);
    if (el) {
      setSpotRect(el.getBoundingClientRect());
    }
  }, [current.target]);

  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  function handleNext() {
    if (isLast) {
      onDone();
    } else {
      setStep((s) => s + 1);
    }
  }

  // Compute tooltip style based on position strategy
  let tooltipStyle: React.CSSProperties;
  if (current.position === "center" || !spotRect) {
    tooltipStyle = {
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
    };
  } else if (current.position === "above" && spotRect) {
    tooltipStyle = {
      bottom: window.innerHeight - spotRect.top + 14,
      left: Math.max(16, Math.min(spotRect.left + spotRect.width / 2, window.innerWidth - 16)),
      transform: "translateX(-50%)",
    };
  } else {
    // below
    tooltipStyle = {
      top: spotRect!.bottom + 14,
      left: Math.max(16, Math.min(spotRect!.left + spotRect!.width / 2, window.innerWidth - 16)),
      transform: "translateX(-50%)",
    };
  }

  return (
    <div className="tour-overlay">
      {/* Dim background but cut out the target element */}
      {spotRect && current.position !== "center" && (
        <svg className="tour-cutout" viewBox={`0 0 ${window.innerWidth} ${window.innerHeight}`}>
          <defs>
            <mask id="tour-mask">
              <rect width="100%" height="100%" fill="white" />
              <rect
                x={spotRect.left - 6}
                y={spotRect.top - 6}
                width={spotRect.width + 12}
                height={spotRect.height + 12}
                rx="10"
                fill="black"
              />
            </mask>
          </defs>
          <rect
            width="100%"
            height="100%"
            fill="rgba(0,0,0,0.6)"
            mask="url(#tour-mask)"
          />
          <rect
            x={spotRect.left - 6}
            y={spotRect.top - 6}
            width={spotRect.width + 12}
            height={spotRect.height + 12}
            rx="10"
            fill="none"
            stroke="rgba(213,58,71,0.4)"
            strokeWidth="2"
          />
        </svg>
      )}

      {/* Dim overlay for center-positioned steps */}
      {current.position === "center" && (
        <div className="tour-dim" />
      )}

      <div className="tour-tooltip" style={tooltipStyle}>
        <div className="tour-header">
          <span className="tour-counter">
            {step + 1} / {STEPS.length}
          </span>
          <button className="tour-skip" onClick={onDone} type="button">
            Skip tour
          </button>
        </div>
        <h3 className="tour-title">{current.title}</h3>
        <p className="tour-body">{current.body}</p>
        <div className="tour-footer">
          <div className="tour-dots">
            {STEPS.map((_, i) => (
              <span
                key={i}
                className={`tour-dot${i === step ? " tour-dot-active" : ""}`}
              />
            ))}
          </div>
          <div className="tour-actions">
            {step > 0 && (
              <button className="tour-btn-back" onClick={() => setStep((s) => s - 1)} type="button">
                Back
              </button>
            )}
            <button className="tour-btn-next" onClick={handleNext} type="button">
              {isLast ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
