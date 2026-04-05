"use client";

import { useState } from "react";

const STORAGE_KEY_PREFIX = "braindump_tutorial_v1_";

// ── Illustrations ──────────────────────────────────────────────────────────────

function IllusWelcome() {
  return (
    <div style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, width: "100%" }}>
        {["API bugs, meeting tomorrow…", "Q3 deadline looming", "Need to review the docs"].map((t, i) => (
          <div
            key={i}
            style={{
              background: "#101012",
              borderRadius: 6,
              padding: "7px 10px",
              fontSize: 11,
              color: "#6f6964",
              border: "1px solid rgba(255,255,255,0.05)",
            }}
          >
            {t}
          </div>
        ))}
      </div>
      <svg width="20" height="22" viewBox="0 0 20 22" fill="none">
        <path d="M10 2v16M5 14l5 6 5-6" stroke="#d53a47" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <svg width="160" height="90" viewBox="0 0 160 90" fill="none">
        <line x1="80" y1="44" x2="28" y2="20" stroke="rgba(255,255,255,0.14)" strokeWidth="1.2" />
        <line x1="80" y1="44" x2="132" y2="20" stroke="rgba(255,255,255,0.14)" strokeWidth="1.2" />
        <line x1="80" y1="44" x2="48" y2="74" stroke="rgba(255,255,255,0.14)" strokeWidth="1.2" />
        <line x1="80" y1="44" x2="116" y2="74" stroke="rgba(255,255,255,0.14)" strokeWidth="1.2" />
        <circle cx="80" cy="44" r="16" fill="rgba(213,58,71,0.18)" stroke="#d53a47" strokeWidth="1.5" />
        <text x="80" y="41" textAnchor="middle" fill="#f2efe9" fontSize="8.5" fontFamily="sans-serif" fontWeight="600">Q3</text>
        <text x="80" y="52" textAnchor="middle" fill="#f2efe9" fontSize="8.5" fontFamily="sans-serif" fontWeight="600">Report</text>
        <circle cx="28" cy="20" r="11" fill="#141417" stroke="rgba(255,255,255,0.12)" strokeWidth="1.2" />
        <text x="28" y="24" textAnchor="middle" fill="#928b85" fontSize="8" fontFamily="sans-serif">API</text>
        <circle cx="132" cy="20" r="11" fill="#141417" stroke="rgba(255,255,255,0.12)" strokeWidth="1.2" />
        <text x="132" y="24" textAnchor="middle" fill="#928b85" fontSize="8" fontFamily="sans-serif">Meet</text>
        <circle cx="48" cy="74" r="10" fill="#141417" stroke="rgba(255,255,255,0.12)" strokeWidth="1.2" />
        <text x="48" y="78" textAnchor="middle" fill="#928b85" fontSize="7.5" fontFamily="sans-serif">Docs</text>
        <circle cx="116" cy="74" r="10" fill="#141417" stroke="rgba(255,255,255,0.12)" strokeWidth="1.2" />
        <text x="116" y="78" textAnchor="middle" fill="#928b85" fontSize="7.5" fontFamily="sans-serif">OKRs</text>
      </svg>
    </div>
  );
}

function IllusBrainDump() {
  return (
    <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          background: "#101012",
          borderRadius: 9,
          padding: "14px 14px",
          border: "1px solid rgba(255,255,255,0.07)",
          fontSize: 12,
          color: "#c1bbb5",
          lineHeight: 1.65,
          minHeight: 90,
        }}
      >
        Working on Q3 report, meeting with Alex tomorrow to review OKRs. Need to investigate the API rate limiting issue first —
        <span
          style={{
            display: "inline-block",
            width: 2,
            height: 13,
            background: "#d53a47",
            marginLeft: 2,
            verticalAlign: "middle",
          }}
        />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "#6f6964" }}>103 chars</span>
        <div
          style={{
            background: "#d53a47",
            borderRadius: 7,
            padding: "6px 18px",
            fontSize: 12,
            fontWeight: 600,
            color: "#fff",
          }}
        >
          Submit
        </div>
      </div>
      <div
        style={{
          marginTop: 4,
          display: "flex",
          gap: 8,
          alignItems: "center",
          padding: "8px 12px",
          background: "rgba(213,58,71,0.06)",
          border: "1px solid rgba(213,58,71,0.12)",
          borderRadius: 7,
        }}
      >
        <div
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: "#d53a47",
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 11, color: "#928b85" }}>Voice input available</span>
      </div>
    </div>
  );
}

function IllusReview() {
  const items = [
    { title: "Q3 Report", type: "task", checked: true },
    { title: "OKRs Alignment", type: "goal", checked: true },
    { title: "API Rate Limiting", type: "task", checked: false },
  ];
  return (
    <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ fontSize: 11, color: "#6f6964", marginBottom: 4 }}>3 nodes extracted</div>
      {items.map((item, i) => (
        <div
          key={i}
          style={{
            background: "#101012",
            borderRadius: 8,
            padding: "10px 14px",
            border: `1px solid ${item.checked ? "rgba(213,58,71,0.2)" : "rgba(255,255,255,0.06)"}`,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div
            style={{
              width: 15,
              height: 15,
              borderRadius: 4,
              border: `1.5px solid ${item.checked ? "#d53a47" : "rgba(255,255,255,0.18)"}`,
              background: item.checked ? "#d53a47" : "transparent",
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {item.checked && (
              <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                <path d="M1.5 4.5L3.5 6.5L7.5 2.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: item.checked ? "#f2efe9" : "#928b85", fontWeight: 500 }}>{item.title}</div>
            <div style={{ fontSize: 10, color: "#6f6964", marginTop: 1 }}>{item.type}</div>
          </div>
        </div>
      ))}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 6,
          marginTop: 4,
        }}
      >
        <div
          style={{
            padding: "5px 14px",
            borderRadius: 6,
            border: "1px solid rgba(255,255,255,0.1)",
            fontSize: 11,
            color: "#6f6964",
          }}
        >
          Reject
        </div>
        <div
          style={{
            padding: "5px 14px",
            borderRadius: 6,
            background: "#d53a47",
            fontSize: 11,
            fontWeight: 600,
            color: "#fff",
          }}
        >
          Accept 2
        </div>
      </div>
    </div>
  );
}

function IllusGraph() {
  return (
    <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
        }}
      >
        {["All types", "Active only"].map((label, i) => (
          <div
            key={label}
            style={{
              padding: "3px 8px",
              borderRadius: 5,
              background: i === 1 ? "rgba(213,58,71,0.15)" : "transparent",
              border: `1px solid ${i === 1 ? "rgba(213,58,71,0.3)" : "rgba(255,255,255,0.07)"}`,
              fontSize: 10,
              color: i === 1 ? "#e87d85" : "#6f6964",
            }}
          >
            {label}
          </div>
        ))}
      </div>
      <svg width="240" height="150" viewBox="0 0 240 150" fill="none" style={{ width: "100%", height: "auto" }}>
        <line x1="120" y1="75" x2="52" y2="38" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />
        <line x1="120" y1="75" x2="188" y2="38" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />
        <line x1="120" y1="75" x2="62" y2="122" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />
        <line x1="120" y1="75" x2="178" y2="122" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />
        <line x1="52" y1="38" x2="188" y2="38" stroke="rgba(255,255,255,0.06)" strokeWidth="1" strokeDasharray="3 3" />
        <circle cx="120" cy="75" r="22" fill="rgba(213,58,71,0.16)" stroke="#d53a47" strokeWidth="1.5" />
        <text x="120" y="72" textAnchor="middle" fill="#f2efe9" fontSize="9" fontFamily="sans-serif" fontWeight="600">Q3</text>
        <text x="120" y="83" textAnchor="middle" fill="#f2efe9" fontSize="9" fontFamily="sans-serif" fontWeight="600">Report</text>
        <circle cx="52" cy="38" r="15" fill="#141417" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />
        <text x="52" y="42" textAnchor="middle" fill="#c1bbb5" fontSize="8" fontFamily="sans-serif">Meeting</text>
        <circle cx="188" cy="38" r="15" fill="#141417" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />
        <text x="188" y="42" textAnchor="middle" fill="#c1bbb5" fontSize="8" fontFamily="sans-serif">OKRs</text>
        <circle cx="62" cy="122" r="13" fill="#141417" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />
        <text x="62" y="126" textAnchor="middle" fill="#c1bbb5" fontSize="8" fontFamily="sans-serif">API fix</text>
        <circle cx="178" cy="122" r="13" fill="#141417" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />
        <text x="178" y="126" textAnchor="middle" fill="#c1bbb5" fontSize="8" fontFamily="sans-serif">Alex</text>
      </svg>
    </div>
  );
}

function IllusAssistant() {
  return (
    <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 5, marginBottom: 2 }}>
        {[
          { label: "Explain", active: false },
          { label: "Plan", active: true },
          { label: "Transform", active: false },
        ].map(({ label, active }) => (
          <div
            key={label}
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              background: active ? "rgba(213,58,71,0.18)" : "transparent",
              border: `1px solid ${active ? "rgba(213,58,71,0.35)" : "rgba(255,255,255,0.07)"}`,
              fontSize: 10,
              color: active ? "#e87d85" : "#6f6964",
              fontWeight: active ? 500 : 400,
            }}
          >
            {label}
          </div>
        ))}
      </div>
      <div
        style={{
          alignSelf: "flex-end",
          background: "rgba(213,58,71,0.14)",
          border: "1px solid rgba(213,58,71,0.18)",
          borderRadius: "10px 10px 3px 10px",
          padding: "8px 12px",
          fontSize: 11,
          color: "#f2efe9",
          maxWidth: "82%",
        }}
      >
        What should I focus on today?
      </div>
      <div
        style={{
          alignSelf: "flex-start",
          background: "#101012",
          border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: "10px 10px 10px 3px",
          padding: "9px 12px",
          fontSize: 11,
          color: "#c1bbb5",
          maxWidth: "92%",
          lineHeight: 1.6,
        }}
      >
        The <span style={{ color: "#f2efe9", fontWeight: 500 }}>Q3 Report</span> is your highest-priority node — it blocks 2 others and has an upcoming deadline.
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: "#101012",
          border: "1px solid rgba(255,255,255,0.05)",
          borderRadius: 7,
          padding: "6px 10px",
          marginTop: 2,
        }}
      >
        <span style={{ fontSize: 11, color: "#6f6964", flex: 1 }}>Ask anything about your graph…</span>
        <div
          style={{
            width: 22,
            height: 22,
            borderRadius: 5,
            background: "rgba(213,58,71,0.2)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M5 1v8M1 5l4-4 4 4" stroke="#d53a47" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>
    </div>
  );
}

// ── Step definitions ───────────────────────────────────────────────────────────

interface TutorialStep {
  id: string;
  title: string;
  body: string;
  Illustration: () => React.ReactElement;
}

const STEPS: TutorialStep[] = [
  {
    id: "welcome",
    title: "Welcome to BrainDump",
    body: "BrainDump turns messy thoughts into an organized, living knowledge graph. Write however you think — the AI handles structure.",
    Illustration: IllusWelcome,
  },
  {
    id: "brain-dump",
    title: "Start with a Brain Dump",
    body: "Hit the Brain Dump button and offload your thoughts in plain text. You can type or use voice. The AI extracts structured nodes from anything you write.",
    Illustration: IllusBrainDump,
  },
  {
    id: "review",
    title: "Review & Approve",
    body: "After submitting, the AI proposes nodes for you to review. Edit titles, change types, or skip anything that doesn't belong before it touches your graph.",
    Illustration: IllusReview,
  },
  {
    id: "graph",
    title: "Your Knowledge Graph",
    body: "Approved nodes appear as a connected graph. Filter by type, importance, or status. Double-click a node to collapse its subtree.",
    Illustration: IllusGraph,
  },
  {
    id: "assistant",
    title: "Ask the Assistant",
    body: "Switch to Assistant mode to chat with an AI that knows your entire workspace — all nodes, connections, and recent activity. Use Plan mode to generate a focused work session.",
    Illustration: IllusAssistant,
  },
];

// ── Public API ─────────────────────────────────────────────────────────────────

export function shouldShowTutorial(userId: string): boolean {
  if (typeof window === "undefined") return false;
  return !localStorage.getItem(`${STORAGE_KEY_PREFIX}${userId}`);
}

interface Props {
  userId: string;
  onDone: () => void;
}

export function OnboardingTutorial({ userId, onDone }: Props) {
  const [step, setStep] = useState(0);

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;
  const { Illustration } = current;

  function markDone() {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${userId}`, "1");
    onDone();
  }

  function handleNext() {
    if (isLast) {
      markDone();
    } else {
      setStep((s) => s + 1);
    }
  }

  return (
    <div className="tut-modal">
      <div className="tut-panel">
        <div className="tut-panel-body">
          <div className="tut-illus-wrap">
            <Illustration />
          </div>
          <div className="tut-content">
            <span className="tut-counter">
              {step + 1} / {STEPS.length}
            </span>
            <h3 className="tut-title">{current.title}</h3>
            <p className="tut-body">{current.body}</p>
          </div>
        </div>
        <div className="tut-footer">
          <div className="tut-dots">
            {STEPS.map((s, i) => (
              <button
                key={s.id}
                aria-label={`Go to step ${i + 1}`}
                className={`tut-dot${i === step ? " tut-dot-active" : ""}`}
                onClick={() => setStep(i)}
                type="button"
              />
            ))}
          </div>
          <div className="tut-nav">
            <button className="tut-skip-btn" onClick={markDone} type="button">
              Skip tour
            </button>
            {step > 0 && (
              <button className="tut-btn tut-btn-back" onClick={() => setStep((s) => s - 1)} type="button">
                Back
              </button>
            )}
            <button className="tut-btn tut-btn-next" onClick={handleNext} type="button">
              {isLast ? "Get started" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
