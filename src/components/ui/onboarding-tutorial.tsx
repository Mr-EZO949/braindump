"use client";

const STORAGE_KEY = "braindump_onboarded_v2_";

export function shouldShowWelcome(userId: string): boolean {
  if (typeof window === "undefined") return false;
  return !localStorage.getItem(`${STORAGE_KEY}${userId}`);
}

export function markWelcomeDone(userId: string) {
  localStorage.setItem(`${STORAGE_KEY}${userId}`, "1");
}

interface Props {
  onGetStarted: () => void;
  onSkip: () => void;
}

export function WelcomeScreen({ onGetStarted, onSkip }: Props) {
  return (
    <div className="welcome-overlay">
      <div className="welcome-card">
        <div className="welcome-glow" aria-hidden="true" />

        <div className="welcome-logo">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <circle cx="16" cy="16" r="14" stroke="#d53a47" strokeWidth="1.5" fill="rgba(213,58,71,0.1)" />
            <circle cx="16" cy="12" r="3" fill="#d53a47" opacity="0.8" />
            <circle cx="10" cy="20" r="2.5" fill="#d53a47" opacity="0.5" />
            <circle cx="22" cy="20" r="2.5" fill="#d53a47" opacity="0.5" />
            <line x1="16" y1="12" x2="10" y2="20" stroke="#d53a47" strokeWidth="1" opacity="0.4" />
            <line x1="16" y1="12" x2="22" y2="20" stroke="#d53a47" strokeWidth="1" opacity="0.4" />
          </svg>
        </div>

        <h2 className="welcome-title">Welcome to BrainDump</h2>

        <p className="welcome-body">
          Dump whatever is on your mind — tasks, ideas, plans, anything.
          The AI will organize it into a visual knowledge graph for you.
        </p>

        <p className="welcome-sub">
          Let&apos;s set up your workspace first.
        </p>

        <button className="welcome-cta" onClick={onGetStarted} type="button">
          Get started
        </button>

        <button className="welcome-skip" onClick={onSkip} type="button">
          I&apos;ll explore on my own
        </button>
      </div>
    </div>
  );
}
