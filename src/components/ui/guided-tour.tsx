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
    target: "workspace-switcher",
    title: "Workspaces",
    body: "Keep separate parts of your life in separate graphs — school, a side project, the job hunt. Switch or spin up a new one here anytime.",
    position: "below",
  },
  {
    target: "graph-area",
    title: "Your knowledge graph",
    body: "Everything lives here as connected nodes — goals, projects, tasks, ideas. Pan, zoom, filter, and rearrange to see how it all fits together.",
    position: "center",
  },
  {
    target: "braindump-btn",
    title: "Brain Dump",
    body: "Offload whatever's on your mind — type or speak freely. The AI breaks it into structured nodes, groups them under your life-areas, and adds them to the graph.",
    position: "above",
  },
  {
    target: "context-rail",
    title: "Side panel & roadmaps",
    body: "Click any node to open the side panel — see its details, connections, and importance, and turn a project into a step-by-step roadmap in one tap.",
    position: "center",
  },
  {
    target: "rail-chat",
    title: "Chat about your graph",
    body: "Switch to the Chat tab in the side panel to ask anything — how things connect, what to prioritize, or just think out loud. It can capture and reshape your graph as you talk.",
    position: "center",
  },
  {
    target: "assistant-btn",
    title: "Planner",
    body: "Plan your day, time-blocked. Tell the Planner what you want to tackle and it lays your tasks onto a calendar — building, scheduling, and rescheduling blocks for you.",
    position: "above",
  },
  {
    target: "lists-btn",
    title: "Lists",
    body: "Prefer a list to a graph? See your Todos, Habits, and a Roadmap view of everything — same data, linear layout.",
    position: "above",
  },
  {
    target: "focus-btn",
    title: "Focus",
    body: "Frozen on what to do? Focus surfaces your top priorities right now so you can start on one thing instead of staring at everything.",
    position: "above",
  },
  {
    target: "weekly-reflection-btn",
    title: "Weekly Review",
    body: "Each week, see what you completed, your momentum, and a short reflection — so progress is visible, not just the backlog.",
    position: "below",
  },
  {
    target: "history-btn",
    title: "Brain dump history",
    body: "Every dump you've ever made, kept with its date — revisit your past thinking so nothing gets lost.",
    position: "below",
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

  // Compute tooltip style based on position strategy. The tooltip is 320px
  // wide and centered with translateX(-50%), so its center must stay at least
  // half-width + margin from each edge — otherwise a corner target (e.g. the
  // top-left workspace switcher) spills the tooltip off-screen.
  const ttHalf = Math.min(320, window.innerWidth - 32) / 2;
  const clampX = (center: number) =>
    Math.max(ttHalf + 16, Math.min(center, window.innerWidth - ttHalf - 16));
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
      left: clampX(spotRect.left + spotRect.width / 2),
      transform: "translateX(-50%)",
    };
  } else {
    // below
    tooltipStyle = {
      top: spotRect!.bottom + 14,
      left: clampX(spotRect!.left + spotRect!.width / 2),
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
