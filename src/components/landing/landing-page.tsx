"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useInView, AnimatePresence } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import styles from "./landing.module.css";

// ── Pricing cards ─────────────────────────────────────────

type PricingTier = {
  name: string;
  price: string;
  cadence?: string;
  tagline: string;
  features: string[];
  cta: string;
  href: string;
  featured?: boolean;
};

const PRICING_TIERS: PricingTier[] = [
  {
    name: "Free",
    price: "$0",
    tagline: "Get unstuck without commitment.",
    features: [
      "Unlimited brain dumps",
      "Graph of up to 50 nodes",
      "Daily “what’s next” pick",
    ],
    cta: "Get started",
    href: "#pricing",
  },
  {
    name: "Pro",
    price: "$9",
    cadence: "/mo",
    tagline: "For when paralysis is a daily fight.",
    features: [
      "Everything in Free",
      "Unlimited nodes & history",
      "AI planner + weekly review",
      "Habits, roadmap & Pomodoro",
    ],
    cta: "Start free trial",
    href: "#pricing",
    featured: true,
  },
  {
    name: "Team",
    price: "$19",
    cadence: "/user/mo",
    tagline: "Shared brains for small teams.",
    features: [
      "Everything in Pro",
      "Shared workspaces",
      "Priority support",
    ],
    cta: "Contact us",
    href: "#pricing",
  },
];

type PricingCardsProps = {
  variant?: "hero" | "cta";
};

function PricingCards({ variant = "hero" }: PricingCardsProps) {
  return (
    <div className={`${styles.pricingGrid} ${variant === "cta" ? styles.pricingGridCta : ""}`}>
      {PRICING_TIERS.map((tier) => (
        <div
          key={tier.name}
          className={`${styles.pricingCard} ${tier.featured ? styles.pricingCardFeatured : ""}`}
        >
          {tier.featured ? <span className={styles.pricingBadge}>Most popular</span> : null}
          <span className={styles.pricingName}>{tier.name}</span>
          <div className={styles.pricingPrice}>
            <span className={styles.pricingPriceAmount}>{tier.price}</span>
            {tier.cadence ? <span className={styles.pricingPriceCadence}>{tier.cadence}</span> : null}
          </div>
          <p className={styles.pricingTagline}>{tier.tagline}</p>
          <ul className={styles.pricingFeatures}>
            {tier.features.map((feature) => (
              <li key={feature} className={styles.pricingFeature}>{feature}</li>
            ))}
          </ul>
          <a
            href={tier.href}
            className={tier.featured ? styles.waitlistButton : styles.btnGhost}
          >
            {tier.cta}
            <span className={styles.btnArrow}>→</span>
          </a>
        </div>
      ))}
    </div>
  );
}

// ── Palette ───────────────────────────────────────────────

const NC: Record<string, string> = {
  task:     "#a35258",
  goal:     "#d8d0c4",
  idea:     "#5c7a6e",
  concept:  "#677480",
  question: "#7a6b5c",
  journal:  "#6b6b8a",
  project:  "#8c4a57",
  class:    "#96784d",
};

// ── Demo data ─────────────────────────────────────────────

const DEMO_THOUGHTS = [
  { text: "finish the proposal before Friday",  type: "task", title: "Finish proposal" },
  { text: "want to learn Rust this year",        type: "goal", title: "Learn Rust" },
  { text: "auth bug still broken in prod",        type: "task", title: "Fix auth bug" },
  { text: "meeting with Sarah at 3pm tomorrow",   type: "task", title: "Meeting: Sarah" },
  { text: "idea: embeddings for internal search", type: "idea", title: "Embeddings" },
];

const MINI_NODES = [
  { idx: 1, x: 185, y: 26,  label: "Learn Rust" },
  { idx: 2, x:  56, y: 106, label: "Fix auth" },
  { idx: 4, x: 314, y: 106, label: "Embeddings" },
  { idx: 0, x: 140, y: 158, label: "Proposal" },
  { idx: 3, x: 278, y: 158, label: "Meeting" },
];

const MINI_EDGES: [number, number][] = [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4]];

const PHASE_DELAYS = [
  280, 160, 160, 160, 160, 160, 1800,    // input: 0-6
  280, 170, 170, 170, 170, 170, 1500,    // extracted: 7-13
  300, 240, 240, 240, 240, 240,           // graph nodes: 14-19
  280, 280, 280, 280, 280, 1400,          // graph edges + brief hold: 20-25
  320, 260, 260, 260, 1800, 1200,          // focus card: 26-31 (header+summary, item1, item2, item3, hold, hold)
];

const WHAT_NOW_CHIPS = [
  "blocks proposal",
  "due Friday",
  "~25 min",
];

const MARQUEE_R1 = [
  { t: "Redesign the onboarding flow", type: "task" },
  { t: "Learn distributed systems",    type: "goal" },
  { t: "What is vector search?",       type: "question" },
  { t: "Had a breakthrough today",     type: "journal" },
  { t: "Event sourcing pattern",       type: "concept" },
  { t: "API gateway project",          type: "project" },
  { t: "Cache with Redis streams",     type: "idea" },
  { t: "Stanford CS229",               type: "class" },
  { t: "Ship v2 this sprint",          type: "task" },
  { t: "Master WebGL shaders",         type: "goal" },
];

const MARQUEE_R2 = [
  { t: "Fix auth session bug",              type: "task" },
  { t: "How does RAFT consensus work?",     type: "question" },
  { t: "Feeling overwhelmed, need focus",   type: "journal" },
  { t: "Graph neural networks",             type: "concept" },
  { t: "Mobile app rebuild",                type: "project" },
  { t: "Use embeddings for semantic search", type: "idea" },
  { t: "Read Designing Data-Intensive Apps", type: "goal" },
  { t: "MIT 6.824",                         type: "class" },
  { t: "Deploy staging env",                type: "task" },
  { t: "Build a CLI tool for deploys",      type: "idea" },
];

// Review showcase data
const REVIEW_ITEMS = [
  { type: "task",     title: "Finish proposal",       status: "accepted" as const },
  { type: "goal",     title: "Learn Rust",             status: "accepted" as const },
  { type: "idea",     title: "Embedding search",       status: "pending"  as const },
  { type: "task",     title: "Fix auth bug",           status: "accepted" as const },
  { type: "question", title: "Auth ↔ Search link?",    status: "rejected" as const },
  { type: "journal",  title: "Roadmap clarity",        status: "accepted" as const },
];

// ── Grain overlay ─────────────────────────────────────────

function Grain() {
  return (
    <svg className={styles.grain} aria-hidden="true">
      <filter id="noiseFilter">
        <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch" />
      </filter>
      <rect width="100%" height="100%" filter="url(#noiseFilter)" opacity="0.035" />
    </svg>
  );
}

// ── Snowflakes that orbit "Unfreeze your brain." then melt ─
// Anchored around the phrase (top/left relative to it). Each floats in a small
// orbit while frozen, then melts (drips + fades) in sync with the colour thaw.
// ── Marquee ───────────────────────────────────────────────

function MarqueeRow({ items, reverse }: { items: typeof MARQUEE_R1; reverse?: boolean }) {
  const doubled = [...items, ...items];
  return (
    <div className={styles.marqueeRow}>
      <div className={`${styles.marqueeTrack} ${reverse ? styles.marqueeReverse : ""}`}>
        {doubled.map((item, i) => (
          <span key={`${item.t}-${i}`} className={styles.marqueeItem}>
            {item.t}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Context Core (AI section visual) ─────────────────────

const CONTEXT_NODES = [
  { angle:  -90, t: "goal",     label: "Ship v1" },
  { angle:  -45, t: "task",     label: "Auth bug" },
  { angle:    0, t: "idea",     label: "Embed search" },
  { angle:   45, t: "habit",    label: "Spanish 10m" },
  { angle:   90, t: "journal",  label: "Tue: stuck" },
  { angle:  135, t: "project",  label: "API rebuild" },
  { angle:  180, t: "concept",  label: "RAFT" },
  { angle: -135, t: "question", label: "What blocks?" },
];

function ContextCore() {
  const ref = useRef<HTMLDivElement>(null);
  const v = useInView(ref, { once: true, margin: "-60px" });

  const cx = 220, cy = 220, ringR = 150;

  return (
    <div ref={ref} className={styles.contextCore}>
      <div className={styles.panelChrome}>
        <span className={styles.chromeDot} />
        <span className={styles.chromeDot} />
        <span className={styles.chromeDot} />
        <span className={styles.panelLabel}>context · live</span>
      </div>

      <div className={styles.contextStage}>
        <svg viewBox="0 0 440 440" className={styles.contextSvg} aria-hidden="true">
          <defs>
            <radialGradient id="coreGlow">
              <stop offset="0%"  stopColor="rgba(213, 58, 71, 0.6)" />
              <stop offset="55%" stopColor="rgba(213, 58, 71, 0.12)" />
              <stop offset="100%" stopColor="transparent" />
            </radialGradient>
          </defs>

          <circle cx={cx} cy={cy} r={110} fill="url(#coreGlow)" />

          {CONTEXT_NODES.map((n, i) => {
            const rad = (n.angle * Math.PI) / 180;
            const nx = cx + ringR * Math.cos(rad);
            const ny = cy + ringR * Math.sin(rad);
            const c = NC[n.t];
            return (
              <motion.line
                key={`l${i}`}
                x1={nx} y1={ny} x2={cx} y2={cy}
                stroke={c}
                strokeWidth="1"
                strokeOpacity="0.35"
                strokeDasharray="2 5"
                initial={{ pathLength: 0 }}
                animate={v ? { pathLength: 1, strokeDashoffset: [0, -28] } : {}}
                transition={{
                  pathLength: { delay: 0.35 + i * 0.06, duration: 0.55, ease: "easeOut" },
                  strokeDashoffset: {
                    delay: 0.9 + i * 0.06,
                    duration: 2 + (i % 3) * 0.4,
                    repeat: Infinity,
                    ease: "linear",
                  },
                }}
              />
            );
          })}

          <motion.circle
            cx={cx} cy={cy} r={26}
            fill="rgba(213, 58, 71, 0.96)"
            stroke="rgba(255, 255, 255, 0.18)"
            strokeWidth="1.5"
            initial={{ scale: 0 }}
            animate={v ? { scale: 1 } : {}}
            transition={{ delay: 0.15, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          />
          <motion.circle
            cx={cx} cy={cy} r={26}
            fill="none"
            stroke="rgba(213, 58, 71, 0.55)"
            strokeWidth="1.2"
            animate={v ? { r: [26, 50], opacity: [0.55, 0] } : {}}
            transition={{ duration: 2.6, repeat: Infinity, ease: "easeOut" }}
          />
          <text x={cx} y={cy + 4} textAnchor="middle"
            fill="rgba(255,255,255,0.96)" fontSize="11" fontWeight="700"
            fontFamily="ui-monospace, monospace" letterSpacing="0.08em">AI</text>

          {CONTEXT_NODES.map((n, i) => {
            const rad = (n.angle * Math.PI) / 180;
            const nx = cx + ringR * Math.cos(rad);
            const ny = cy + ringR * Math.sin(rad);
            const lx = cx + (ringR + 30) * Math.cos(rad);
            const ly = cy + (ringR + 30) * Math.sin(rad);
            const c = NC[n.t];
            const isLeft = Math.cos(rad) < -0.25;
            const isRight = Math.cos(rad) > 0.25;
            const anchor = isLeft ? "end" : isRight ? "start" : "middle";
            return (
              <motion.g key={`n${i}`}
                initial={{ opacity: 0, scale: 0 }}
                animate={v ? { opacity: 1, scale: 1 } : {}}
                transition={{ delay: 0.5 + i * 0.06, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                style={{ transformOrigin: `${nx}px ${ny}px` }}
              >
                <circle cx={nx} cy={ny} r={17} fill={`${c}1e`} stroke={c} strokeWidth="1.4" strokeOpacity="0.78" />
                <text x={nx} y={ny + 3} textAnchor="middle" fill={c}
                  fontSize="6.5" fontWeight="700" fontFamily="ui-monospace, monospace" opacity="0.92">
                  {n.t.toUpperCase().slice(0, 4)}
                </text>
                <text x={lx} y={ly + 3} textAnchor={anchor}
                  fill="rgba(255,255,255,0.55)" fontSize="9.5"
                  fontFamily="ui-sans-serif, system-ui, sans-serif">
                  {n.label}
                </text>
              </motion.g>
            );
          })}
        </svg>
      </div>

      <div className={styles.contextStats}>
        <div className={styles.contextStat}>
          <span className={styles.contextStatVal}>247</span>
          <span className={styles.contextStatLabel}>nodes</span>
        </div>
        <span className={styles.contextStatDivider} />
        <div className={styles.contextStat}>
          <span className={styles.contextStatVal}>891</span>
          <span className={styles.contextStatLabel}>edges</span>
        </div>
        <span className={styles.contextStatDivider} />
        <div className={styles.contextStat}>
          <span className={styles.contextStatVal}>∞</span>
          <span className={styles.contextStatLabel}>memory</span>
        </div>
      </div>
    </div>
  );
}

// ── Four Lenses (one graph, multiple views) ──────────────

type Lens = {
  key: "graph" | "tasks" | "habits" | "roadmap";
  label: string;
  hint: string;
};

const LENSES: Lens[] = [
  { key: "graph",   label: "Graph",   hint: "how it all connects" },
  { key: "tasks",   label: "Tasks",   hint: "today, this week, blocked" },
  { key: "habits",  label: "Habits",  hint: "streaks, cadence, check-ins" },
  { key: "roadmap", label: "Roadmap", hint: "goals over time" },
];

function LensesShowcase() {
  const [active, setActive] = useState<Lens["key"]>("graph");
  const ref = useRef<HTMLDivElement>(null);
  const v = useInView(ref, { once: true, margin: "-60px" });

  return (
    <div ref={ref} className={styles.lensesWrap}>
      {/* Desktop: the rail of four cards beside the stage. */}
      <div className={styles.lensesTabs} role="tablist" aria-label="Views">
        {LENSES.map((lens, i) => (
          <motion.button
            key={lens.key}
            type="button"
            role="tab"
            aria-selected={active === lens.key}
            className={`${styles.lensesTab} ${active === lens.key ? styles.lensesTabActive : ""}`}
            onClick={() => setActive(lens.key)}
            onMouseEnter={() => setActive(lens.key)}
            initial={{ opacity: 0, y: 12 }}
            animate={v ? { opacity: 1, y: 0 } : {}}
            transition={{ delay: 0.05 + i * 0.06, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          >
            <span className={styles.lensesTabLabel}>{lens.label}</span>
            <span className={styles.lensesTabHint}>{lens.hint}</span>
          </motion.button>
        ))}
      </div>

      <div className={styles.lensesStage}>
        {/* Phones only: the same switcher collapsed into the panel chrome,
            so the section doesn't open with four stacked cards. */}
        <div className={styles.lensesBar} role="tablist" aria-label="Views">
          {LENSES.map((lens) => (
            <button
              key={lens.key}
              type="button"
              role="tab"
              aria-selected={active === lens.key}
              className={`${styles.lensesSeg} ${active === lens.key ? styles.lensesSegActive : ""}`}
              onClick={() => setActive(lens.key)}
            >
              {lens.label}
            </button>
          ))}
          <span className={styles.lensesHint}>
            {LENSES.find((l) => l.key === active)?.hint}
          </span>
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={active}
            className={styles.lensesPane}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
          >
            {active === "graph" && <LensGraph />}
            {active === "tasks" && <LensTasks />}
            {active === "habits" && <LensHabits />}
            {active === "roadmap" && <LensRoadmap />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function LensGraph() {
  const tree = [
    { id: "root", x: 210, y: 30,  t: "goal",     label: "Ship v1" },
    { id: "a",    x: 90,  y: 110, t: "project",  label: "Backend" },
    { id: "b",    x: 210, y: 110, t: "project",  label: "Frontend" },
    { id: "c",    x: 330, y: 110, t: "project",  label: "Launch" },
    { id: "a1",   x: 40,  y: 190, t: "task",     label: "Auth" },
    { id: "a2",   x: 140, y: 190, t: "task",     label: "API" },
    { id: "b1",   x: 210, y: 190, t: "task",     label: "UI" },
    { id: "c1",   x: 290, y: 190, t: "idea",     label: "Beta" },
    { id: "c2",   x: 380, y: 190, t: "task",     label: "Docs" },
  ];
  const edges: [string, string][] = [
    ["root", "a"], ["root", "b"], ["root", "c"],
    ["a", "a1"], ["a", "a2"],
    ["b", "b1"],
    ["c", "c1"], ["c", "c2"],
  ];
  const idx = Object.fromEntries(tree.map((n) => [n.id, n]));
  return (
    <svg viewBox="0 0 420 220" className={styles.lensSvg} aria-hidden="true">
      {edges.map(([from, to], i) => {
        const a = idx[from], b = idx[to];
        const midY = (a.y + b.y) / 2;
        return (
          <path
            key={i}
            d={`M ${a.x} ${a.y + 14} C ${a.x} ${midY}, ${b.x} ${midY}, ${b.x} ${b.y - 14}`}
            stroke="rgba(255,255,255,0.1)"
            strokeWidth="1.2"
            fill="none"
          />
        );
      })}
      {tree.map((n) => {
        const c = NC[n.t];
        return (
          <g key={n.id}>
            <circle cx={n.x} cy={n.y} r={18} fill={`${c}14`} stroke={`${c}48`} strokeWidth="1.4" />
            <text x={n.x} y={n.y + 3.5} textAnchor="middle" fontSize="7.5" fontWeight="700"
              fontFamily="ui-monospace, monospace" fill={c} opacity="0.92">
              {n.t.toUpperCase().slice(0, 4)}
            </text>
            <text x={n.x} y={n.y + 32} textAnchor="middle" fontSize="8.5"
              fontFamily="ui-sans-serif, system-ui, sans-serif" fill="rgba(255,255,255,0.42)">
              {n.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

const LENS_TASKS = [
  { title: "Finish proposal draft",    type: "task",    meta: "due today",       status: "active"   },
  { title: "Debug auth session bug",   type: "task",    meta: "blocks 3 others", status: "active"   },
  { title: "Review PR feedback",       type: "task",    meta: "15m · admin",     status: "active"   },
  { title: "Read RAFT paper §4",       type: "task",    meta: "from CS229",      status: "active"   },
  { title: "Email Sarah re: roadmap",  type: "task",    meta: "this week",       status: "done"     },
];

function LensTasks() {
  return (
    <div className={styles.lensTasks}>
      {LENS_TASKS.map((t, i) => {
        const c = NC[t.type];
        return (
          <motion.div
            key={i}
            className={styles.lensTaskRow}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.04 + i * 0.05, duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
          >
            <span
              className={styles.lensTaskBox}
              data-checked={t.status === "done"}
              style={{ borderColor: `${c}55` }}
            >
              {t.status === "done" ? "✓" : ""}
            </span>
            <span className={styles.lensTaskTitle} data-done={t.status === "done"}>{t.title}</span>
            <span className={styles.lensTaskMeta}>{t.meta}</span>
          </motion.div>
        );
      })}
    </div>
  );
}

const LENS_HABITS = [
  { name: "Spanish · 10m",   streak: 12, days: [1,1,1,1,1,1,0] },
  { name: "Leetcode · 1/d",  streak: 4,  days: [1,0,1,1,1,0,0] },
  { name: "Read · 20 pages", streak: 7,  days: [1,1,1,1,1,1,1] },
];

function LensHabits() {
  return (
    <div className={styles.lensHabits}>
      {LENS_HABITS.map((h, i) => (
        <motion.div
          key={i}
          className={styles.lensHabitRow}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 + i * 0.08, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className={styles.lensHabitInfo}>
            <span className={styles.lensHabitName}>{h.name}</span>
            <span className={styles.lensHabitStreak}>🔥 {h.streak}-day streak</span>
          </div>
          <div className={styles.lensHabitDots}>
            {h.days.map((d, j) => (
              <span
                key={j}
                className={`${styles.lensHabitDot} ${d ? styles.lensHabitDotOn : ""}`}
              />
            ))}
          </div>
        </motion.div>
      ))}
    </div>
  );
}

const ROADMAP_BARS = [
  { label: "Ship Analytics SaaS v1", color: "#a35258", start: 0,  span: 3 },
  { label: "Finish CS229",            color: "#96784d", start: 1,  span: 2 },
  { label: "Launch personal blog",    color: "#5c7a6e", start: 2,  span: 2 },
  { label: "Run a half-marathon",     color: "#677480", start: 0,  span: 5 },
];

function LensRoadmap() {
  const months = ["May", "Jun", "Jul", "Aug", "Sep"];
  return (
    <div className={styles.lensRoadmap}>
      <div className={styles.lensRoadmapHeader}>
        {months.map((m) => (
          <span key={m} className={styles.lensRoadmapMonth}>{m}</span>
        ))}
      </div>
      <div className={styles.lensRoadmapBody}>
        {ROADMAP_BARS.map((b, i) => (
          <motion.div
            key={i}
            className={styles.lensRoadmapRow}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.05 + i * 0.07, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          >
            <span className={styles.lensRoadmapLabel}>{b.label}</span>
            <div className={styles.lensRoadmapTrack}>
              <motion.span
                className={styles.lensRoadmapBar}
                style={{
                  left: `${(b.start / 5) * 100}%`,
                  width: `${(b.span / 5) * 100}%`,
                  background: `linear-gradient(90deg, ${b.color}aa, ${b.color}55)`,
                  borderColor: `${b.color}66`,
                }}
                initial={{ scaleX: 0, transformOrigin: "left" }}
                animate={{ scaleX: 1 }}
                transition={{ delay: 0.15 + i * 0.08, duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
              />
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

// ── Habits & streaks deep section ────────────────────────

const HABITS_CALENDAR = Array.from({ length: 35 }, (_, i) => {
  const seed = (i * 9301 + 49297) % 233280;
  const v = (seed / 233280);
  return v > 0.75 ? 3 : v > 0.55 ? 2 : v > 0.35 ? 1 : 0;
});

function HabitsCalendar() {
  const ref = useRef<HTMLDivElement>(null);
  const v = useInView(ref, { once: true, margin: "-80px" });
  return (
    <div ref={ref} className={styles.habitCalendarWrap}>
      <div className={styles.panelChrome}>
        <span className={styles.chromeDot} />
        <span className={styles.chromeDot} />
        <span className={styles.chromeDot} />
        <span className={styles.panelLabel}>Spanish 10m · feeds &ldquo;Mexico City trip&rdquo;</span>
      </div>
      <div className={styles.habitCalendarBody}>
        <div className={styles.habitCalendarGrid}>
          {HABITS_CALENDAR.map((level, i) => (
            <motion.span
              key={i}
              className={styles.habitCell}
              data-level={level}
              initial={{ opacity: 0, scale: 0.5 }}
              animate={v ? { opacity: 1, scale: 1 } : {}}
              transition={{ delay: (i % 7) * 0.04 + Math.floor(i / 7) * 0.06, duration: 0.28 }}
            />
          ))}
        </div>
        <div className={styles.habitCalendarLegend}>
          <span className={styles.habitLegendLabel}>less</span>
          {[0, 1, 2, 3].map((l) => (
            <span key={l} className={styles.habitCell} data-level={l} />
          ))}
          <span className={styles.habitLegendLabel}>more</span>
        </div>
      </div>
    </div>
  );
}

// ── Control Hub (one chat input → every action) ──────────

// Outcomes the chat can run. Six of them, deliberately diverse so the user
// reads "this covers it all" instead of "this is a notes tool."
const HUB_OUTCOMES = [
  { type: "task",     icon: "+", label: "Add",      example: "“I started Spanish on Duolingo”" },
  { type: "idea",     icon: "⇄", label: "Connect",  example: "“link Spanish to my Mexico trip”" },
  { type: "goal",     icon: "✓", label: "Complete", example: "“I shipped the auth fix”" },
  { type: "project",  icon: "⏱", label: "Schedule", example: "“block 2h Friday for the proposal”" },
  { type: "concept",  icon: "⌫", label: "Archive",  example: "“archive my old job hunt”" },
  { type: "question", icon: "◎", label: "Plan",     example: "“what should I work on next hour?”" },
];

function ControlHubDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const v = useInView(ref, { once: true, margin: "-80px" });

  return (
    <div ref={ref} className={styles.hubDemo}>
      <div className={styles.hubAmbient} aria-hidden="true" />

      {/* Sonar pulse rings emanate from the chat input — convey "broadcast"
          without per-card SVG arcs, so the layout stays responsive. */}
      <motion.div className={styles.hubRing}
        aria-hidden="true"
        initial={{ opacity: 0 }}
        animate={v ? { opacity: 1 } : {}}
        transition={{ delay: 0.3, duration: 0.5 }} />
      <motion.div className={`${styles.hubRing} ${styles.hubRingSlow}`}
        aria-hidden="true"
        initial={{ opacity: 0 }}
        animate={v ? { opacity: 1 } : {}}
        transition={{ delay: 0.5, duration: 0.5 }} />

      {/* The hub: a glowing chat input pill */}
      <motion.div className={styles.hubInput}
        initial={{ opacity: 0, y: 16, scale: 0.96 }}
        animate={v ? { opacity: 1, y: 0, scale: 1 } : {}}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}>
        <span className={styles.hubInputSparkle} aria-hidden="true">✦</span>
        <span className={styles.hubInputText}>Ask anything…</span>
        <span className={styles.hubInputCursor} aria-hidden="true" />
        <span className={styles.hubInputKbd}>⏎</span>
      </motion.div>

      {/* Outcome cards fan out below */}
      <div className={styles.hubCards}>
        {HUB_OUTCOMES.map((outcome, i) => {
          const color = NC[outcome.type];
          return (
            <motion.div key={outcome.label}
              className={styles.hubCard}
              style={{
                "--hub-card-c": color,
              } as React.CSSProperties}
              initial={{ opacity: 0, y: 18, scale: 0.96 }}
              animate={v ? { opacity: 1, y: 0, scale: 1 } : {}}
              transition={{
                delay: 0.55 + i * 0.08,
                duration: 0.42,
                ease: [0.22, 1, 0.36, 1],
              }}>
              <span className={styles.hubCardIcon} aria-hidden="true">
                {outcome.icon}
              </span>
              <span className={styles.hubCardLabel}>{outcome.label}</span>
              <span className={styles.hubCardExample}>{outcome.example}</span>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

// ── Planner demo ─────────────────────────────────────────

const PLANNER_BLOCKS = [
  { label: "Finish proposal draft", type: "focus", duration: "25m", color: "#a35258" },
  { label: "Review PR feedback", type: "admin", duration: "15m", color: "#677480" },
  { label: "Break", type: "break", duration: "10m", color: "#5c7a6e" },
  { label: "Debug auth session bug", type: "focus", duration: "30m", color: "#a35258" },
  { label: "Buffer", type: "buffer", duration: "10m", color: "#7a6b5c" },
];

function PlannerDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const v = useInView(ref, { once: true, margin: "-60px" });
  return (
    <div ref={ref} className={styles.plannerDemo}>
      <div className={styles.plannerChrome}>
        <span className={styles.chromeDot} />
        <span className={styles.chromeDot} />
        <span className={styles.chromeDot} />
        <span className={styles.panelLabel}>planner · next 1h 30m</span>
      </div>
      <div className={styles.plannerBody}>
        <div className={styles.plannerTimeline}>
          {PLANNER_BLOCKS.map((block, i) => (
            <motion.div key={i} className={styles.plannerBlock}
              initial={{ opacity: 0, x: -16 }}
              animate={v ? { opacity: 1, x: 0 } : {}}
              transition={{ delay: 0.2 + i * 0.12, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}>
              <div className={styles.plannerBlockDot} style={{ background: block.color }} />
              <div className={styles.plannerBlockInfo}>
                <span className={styles.plannerBlockLabel}>{block.label}</span>
                <span className={styles.plannerBlockMeta}>{block.type} · {block.duration}</span>
              </div>
              <span className={styles.plannerBlockDuration}>{block.duration}</span>
            </motion.div>
          ))}
        </div>
        <motion.div className={styles.plannerActions}
          initial={{ opacity: 0 }}
          animate={v ? { opacity: 1 } : {}}
          transition={{ delay: 0.9, duration: 0.4 }}>
          <span className={styles.plannerActionBtn} data-variant="accept">Accept plan</span>
          <span className={styles.plannerActionBtn} data-variant="reject">Regenerate</span>
        </motion.div>
      </div>
    </div>
  );
}

// ── Review showcase ───────────────────────────────────────

function ReviewShowcase() {
  const ref = useRef<HTMLDivElement>(null);
  const v = useInView(ref, { once: true, margin: "-60px" });

  return (
    <div ref={ref} className={styles.reviewGrid}>
      {/* Left: the review queue */}
      <div className={styles.reviewPanel}>
        <div className={styles.panelChrome}>
          <span className={styles.chromeDot} />
          <span className={styles.chromeDot} />
          <span className={styles.chromeDot} />
          <span className={styles.panelLabel}>review queue</span>
          <span className={styles.panelCount}>{REVIEW_ITEMS.length}</span>
        </div>
        <div className={styles.panelBody}>
          {REVIEW_ITEMS.map((item, i) => {
            const c = NC[item.type];
            return (
              <motion.div key={i} className={styles.reviewItem}
                initial={{ opacity: 0, x: -16 }}
                animate={v ? { opacity: 1, x: 0 } : {}}
                transition={{ delay: 0.15 + i * 0.08, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}>
                <span className={styles.reviewType} style={{ color: c }}>{item.type}</span>
                <span className={styles.reviewTitle}>{item.title}</span>
                <motion.span
                  className={`${styles.reviewStatus} ${styles[`review_${item.status}`]}`}
                  initial={{ scale: 0 }}
                  animate={v ? { scale: 1 } : {}}
                  transition={{ delay: 0.5 + i * 0.08, duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
                  {item.status === "accepted" ? "✓" : item.status === "rejected" ? "✕" : "…"}
                </motion.span>
              </motion.div>
            );
          })}
        </div>
      </div>

      {/* Right: explanation */}
      <div className={styles.reviewExplain}>
        <span className={styles.secNumBlock}>02</span>
        <h2 className={styles.reviewH2}>
          Dump freely.<br />Approve what sticks.
        </h2>
        <p className={styles.reviewP}>
          Nothing enters your workspace until you say so. Every node waits for a
          yes, so you can dump as messy as you like.
        </p>
        <div className={styles.reviewStats}>
          <div className={styles.statItem}>
            <span className={styles.statValue} style={{ color: "#5c7a6e" }}>4</span>
            <span className={styles.statLabel}>accepted</span>
          </div>
          <div className={styles.statItem}>
            <span className={styles.statValue} style={{ color: "#a35258" }}>1</span>
            <span className={styles.statLabel}>rejected</span>
          </div>
          <div className={styles.statItem}>
            <span className={styles.statValue} style={{ color: "var(--color-text-muted)" }}>1</span>
            <span className={styles.statLabel}>pending</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── MiniGraph (hero demo screen 3) ───────────────────────

function MiniGraph({ visibleNodes, visibleEdges }: { visibleNodes: number; visibleEdges: number }) {
  return (
    <svg viewBox="0 0 370 185" className={styles.miniGraphSvg} aria-hidden="true">
      {MINI_EDGES.map(([ai, bi], i) => {
        const a = MINI_NODES[ai], b = MINI_NODES[bi];
        return (
          <motion.path key={`me${i}`} d={`M ${a.x} ${a.y} L ${b.x} ${b.y}`}
            stroke="rgba(255,255,255,0.1)" strokeWidth="1.5" fill="none" strokeLinecap="round"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={i < visibleEdges ? { pathLength: 1, opacity: 1 } : { pathLength: 0, opacity: 0 }}
            transition={{ duration: 0.4, ease: "easeInOut" }} />
        );
      })}
      {MINI_NODES.map((node, i) => {
        const th = DEMO_THOUGHTS[node.idx], c = NC[th.type];
        return (
          <g key={`mn${i}`} transform={`translate(${node.x}, ${node.y})`}>
            <motion.g
              initial={{ scale: 0, opacity: 0 }}
              animate={i < visibleNodes ? { scale: 1, opacity: 1 } : { scale: 0, opacity: 0 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              style={{ transformBox: "fill-box", transformOrigin: "center" } as React.CSSProperties}>
              <circle r={21} fill={`${c}12`} stroke={`${c}25`} strokeWidth="1" />
              <circle r={13} fill={`${c}1e`} stroke={c} strokeWidth="1.5" strokeOpacity="0.7" />
              <text y={4} textAnchor="middle" fill={c} fontSize="7" fontWeight="700"
                fontFamily="ui-monospace, monospace" opacity="0.9">
                {th.type.slice(0, 4).toUpperCase()}
              </text>
              <text y={32} textAnchor="middle" fill="rgba(255,255,255,0.3)" fontSize="8"
                fontFamily="ui-sans-serif, system-ui, sans-serif">{node.label}</text>
            </motion.g>
          </g>
        );
      })}
    </svg>
  );
}

// ── ThoughtDemo ───────────────────────────────────────────

function ThoughtDemo() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const delay = PHASE_DELAYS[phase] ?? 1000;
    const t = setTimeout(() => setPhase(p => (p >= 31 ? 0 : p + 1)), delay);
    return () => clearTimeout(t);
  }, [phase]);

  const screen: "input" | "extracted" | "graph" | "whatNow" =
    phase < 7 ? "input"
      : phase < 14 ? "extracted"
      : phase < 26 ? "graph"
      : "whatNow";

  const visibleThoughts = Math.min(phase, 5);
  const visiblePills    = phase >= 8 ? Math.min(phase - 7, 5) : 0;
  const visibleNodes    = phase >= 15 ? Math.min(phase - 14, 5) : 0;
  const visibleEdges    = phase >= 20 ? Math.min(phase - 19, 5) : 0;
  const cursorIdx       = phase >= 1 && phase <= 6 ? Math.min(phase - 1, 4) : -1;

  const whatNowQuestionOn = phase >= 26;
  const whatNowAnswerOn   = phase >= 27;
  const whatNowChipsOn    = phase >= 28;
  const whatNowActionOn   = phase >= 29;

  const labels = {
    input: "brain dump",
    extracted: "extracted",
    graph: "graph",
    whatNow: "what now?",
  };

  return (
    <div className={styles.thoughtDemo}>
      <div className={styles.demoChrome}>
        <span className={styles.chromeDot} />
        <span className={styles.chromeDot} />
        <span className={styles.chromeDot} />
        <AnimatePresence mode="wait">
          <motion.span key={screen} className={styles.chromeLabel}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}>
            {labels[screen]}
          </motion.span>
        </AnimatePresence>
        <div className={styles.screenDots}>
          {(["input", "extracted", "graph", "whatNow"] as const).map(s => (
            <span key={s} className={`${styles.screenDot} ${screen === s ? styles.screenDotActive : ""}`} />
          ))}
        </div>
      </div>

      <div className={styles.demoContent}>
        <AnimatePresence mode="wait">
          {screen === "input" && (
            <motion.div key="input" className={styles.demoInput}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.22 }}>
              {DEMO_THOUGHTS.map((th, i) => (
                <motion.div key={th.text} className={styles.demoLine}
                  initial={{ opacity: 0, x: -10 }}
                  animate={i < visibleThoughts ? { opacity: 1, x: 0 } : { opacity: 0, x: -10 }}
                  transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}>
                  {th.text}
                  {i === cursorIdx && <span className={styles.cursor} />}
                </motion.div>
              ))}
            </motion.div>
          )}
          {screen === "extracted" && (
            <motion.div key="extracted" className={styles.demoNodes}
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.22 }}>
              {DEMO_THOUGHTS.map((th, i) => {
                const c = NC[th.type];
                return (
                  <motion.div key={th.text} className={styles.nodePill}
                    style={{ background: `${c}16`, borderColor: `${c}2e` }}
                    initial={{ scale: 0.88, opacity: 0, y: 6 }}
                    animate={i < visiblePills ? { scale: 1, opacity: 1, y: 0 } : { scale: 0.88, opacity: 0, y: 6 }}
                    transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}>
                    <span className={styles.pillType} style={{ color: c, background: `${c}22` }}>{th.type}</span>
                    <span className={styles.pillTitle}>{th.title}</span>
                  </motion.div>
                );
              })}
            </motion.div>
          )}
          {screen === "graph" && (
            <motion.div key="graph" className={styles.miniGraphWrap}
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }} transition={{ duration: 0.28 }}>
              <MiniGraph visibleNodes={visibleNodes} visibleEdges={visibleEdges} />
            </motion.div>
          )}
          {screen === "whatNow" && (
            <motion.div key="whatNow" className={styles.demoWhatNow}
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }} transition={{ duration: 0.28 }}>

              <motion.div className={styles.demoWhatNowQuestion}
                initial={{ opacity: 0, y: 6 }}
                animate={whatNowQuestionOn ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
                transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}>
                What should I work on right now?
              </motion.div>

              <motion.div className={styles.demoWhatNowAnswer}
                initial={{ opacity: 0, y: 10 }}
                animate={whatNowAnswerOn ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
                transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}>
                <div className={styles.demoWhatNowAnswerHeader}>
                  <span className={styles.demoWhatNowAvatar} aria-hidden="true">
                    <span className={styles.demoWhatNowAvatarDot} />
                  </span>
                  <span className={styles.demoWhatNowAvatarName}>BrainDump</span>
                </div>
                <p className={styles.demoWhatNowAnswerText}>
                  Work on the <strong>auth session bug</strong> &mdash; it&apos;s blocking the proposal due Friday, and you&apos;ve avoided it for three days.
                </p>
                <div className={styles.demoWhatNowChips}>
                  {WHAT_NOW_CHIPS.map((label, i) => (
                    <motion.span key={i} className={styles.demoWhatNowChip}
                      initial={{ opacity: 0, scale: 0.94 }}
                      animate={whatNowChipsOn ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.94 }}
                      transition={{ duration: 0.28, delay: i * 0.06, ease: [0.22, 1, 0.36, 1] }}>
                      {label}
                    </motion.span>
                  ))}
                </div>
              </motion.div>

              <motion.button type="button" className={styles.demoWhatNowAction}
                aria-hidden="true" tabIndex={-1}
                initial={{ opacity: 0, y: 6 }}
                animate={whatNowActionOn ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
                transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}>
                <span className={styles.demoWhatNowActionIcon} aria-hidden="true">▶</span>
                Start 25-min focus
              </motion.button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ── FloatingThoughts (problem section ambient) ───────────

const FLOATING_THOUGHTS = [
  "stats homework due Friday",
  "ML project proposal",
  "talk to Prof Martinez",
  "honors program deadline",
  "climate data idea",
  "writing seminar revision",
  "finish thesis outline",
  "rent due next week",
  "gym tomorrow morning",
  "call mom",
  "fix the auth bug",
  "RAFT reading",
  "ship v2 sprint",
  "follow up with Sarah",
];

function FloatingThoughts() {
  return (
    <div className={styles.floatField} aria-hidden="true">
      {FLOATING_THOUGHTS.map((t, i) => {
        const seed = (i * 9301 + 49297) % 233280;
        const left = (seed / 233280) * 100;
        const top = (seed * 7) % 100;
        const delay = (i % 7) * 0.6;
        const dur = 11 + ((i * 3) % 8);
        return (
          <motion.span
            key={t}
            className={styles.floatThought}
            style={{ left: `${left}%`, top: `${top}%` }}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: [0, 0.28, 0.28, 0], y: [8, -4, -4, -16] }}
            transition={{ duration: dur, delay, repeat: Infinity, ease: "easeInOut" }}
          >
            {t}
          </motion.span>
        );
      })}
    </div>
  );
}

// ── FadeUp ────────────────────────────────────────────────

function FadeUp({ children, delay = 0, className }: {
  children: React.ReactNode; delay?: number; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const v = useInView(ref, { once: true, margin: "-60px" });
  return (
    <motion.div ref={ref} className={className}
      initial={{ opacity: 0, y: 28 }}
      animate={v ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.7, delay, ease: [0.22, 1, 0.36, 1] }}>
      {children}
    </motion.div>
  );
}

// ── Page ──────────────────────────────────────────────────

export default function LandingPage() {
  return (
    <>
      <Grain />
      <div className={styles.orbA} aria-hidden="true" />
      <div className={styles.orbB} aria-hidden="true" />

      <div className={styles.root}>
        {/* ── Nav ── */}
        <header className={styles.nav}>
          <Link href="/" className={styles.navLogo}>
            <Image src="/logo_withtext.svg" alt="BrainDump" width={280} height={52} className={styles.navLogoImg} />
          </Link>
          <nav className={styles.navRight}>
            <a href="#pricing" className={styles.navCta}>View pricing</a>
          </nav>
        </header>

        {/* ── Hero — split layout ── */}
        <section className={styles.hero}>
          <div className={styles.heroGlow} aria-hidden="true" />
          <div className={styles.heroDots} aria-hidden="true" />
          <div className={styles.heroInner}>
            <motion.div className={styles.heroText}
              initial={{ opacity: 0, y: 28 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}>
              <div className={styles.heroEyebrow}>
                <span className={styles.heroEyebrowMark} aria-hidden="true" />
                Built for ADHD minds
              </div>
              <h1 className={styles.heroH1}>
                Dump it.
                <span className={styles.heroH1Accent}>Unfreeze your brain.</span>
              </h1>
              <p className={styles.heroProblem}>
                Twenty things to do, each one tangled in the next — so you
                re-read the list, re-plan the plan, and start nothing.
              </p>
              <p className={styles.heroFix}>
                Dump it all here. BrainDump untangles the pile and hands you{" "}
                <em>the one thing to start now.</em>
              </p>
              <div className={styles.heroActions}>
                <a href="#pricing" className={styles.navCta}>Start free</a>
                <a href="#lenses" className={styles.btnGhost}>See what&apos;s inside</a>
              </div>
              <div className={styles.heroTrust}>
                <span>No credit card</span>
                <span>Cancel anytime</span>
                <span>Exportable graph</span>
              </div>
            </motion.div>

            <motion.div className={styles.heroVisual}
              initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.14, ease: [0.22, 1, 0.36, 1] }}>
              <div className={styles.demoGlow} aria-hidden="true" />
              <ThoughtDemo />
            </motion.div>
          </div>
        </section>

        {/* ── Marquee ── */}
        <div className={styles.marquee} aria-hidden="true">
          <MarqueeRow items={[...MARQUEE_R1, ...MARQUEE_R2]} />
        </div>

        {/* ── Problem ── */}
        <section className={styles.problem} id="problem">
          <FloatingThoughts />
          <div className={styles.problemInner}>
            <FadeUp className={styles.secHeadCenter}>
              <h2 className={styles.h2}>
                Your brain didn&apos;t quit.{" "}
                <span className={styles.gradient}>It froze.</span>
              </h2>
              <p className={styles.problemDeck}>
                Too many open loops and too many half-made decisions, and the whole
                pile locks up. You&apos;re not lazy. You&apos;re stuck mid-thought.
              </p>
            </FadeUp>

            <div className={styles.problemSnippets}>
              <FadeUp delay={0.05} className={styles.problemSnippet}>
                <span className={styles.problemSnippetNum}>01</span>
                <p>You open your list. Fifteen things stare back. Your brain just&hellip; stops.</p>
              </FadeUp>
              <FadeUp delay={0.12} className={styles.problemSnippet}>
                <span className={styles.problemSnippetNum}>02</span>
                <p>You finally pick one. It was blocked the whole time. Hour gone.</p>
              </FadeUp>
              <FadeUp delay={0.19} className={styles.problemSnippet}>
                <span className={styles.problemSnippetNum}>03</span>
                <p>You re-plan. You re-prioritize. You never actually start.</p>
              </FadeUp>
            </div>

            <FadeUp delay={0.28}>
              <p className={styles.problemPunch}>
                It&apos;s not the work that&apos;s hard. It&apos;s the minutes you lose deciding what to do.
              </p>
            </FadeUp>
          </div>
        </section>

        {/* ── Four Lenses ── */}
        <section className={styles.section} id="lenses">
          <div className={styles.inner}>
            <FadeUp className={styles.secHeadCenter}>
              <span className={styles.secNumCenter}>01</span>
              <h2 className={styles.h2}>
                One graph. Four ways to look at it.
              </h2>
              <p className={styles.sectionDesc}>
                Not four apps bolted together. Four lenses onto one set of nodes, and
                every one of them is a view the AI reads from when it answers you.
              </p>
            </FadeUp>

            <FadeUp delay={0.12}>
              <LensesShowcase />
            </FadeUp>
          </div>
        </section>

        {/* ── Review ── */}
        <section className={styles.section} id="how">
          <div className={styles.inner}>
            {/* No head above this one — the headline lives inside the split,
                beside the queue it's describing. One section that breaks the
                centred rhythm on purpose. */}
            <FadeUp>
              <ReviewShowcase />
            </FadeUp>
          </div>
        </section>

        {/* ── Control everything via chat ── */}
        <section className={styles.hubSection}>
          <div className={styles.inner}>
            <FadeUp className={styles.secHeadCenter}>
              <span className={styles.secNumCenter}>03</span>
              <h2 className={styles.h2}>
                Whatever you&apos;d click,{" "}
                <span className={styles.gradient}>just type.</span>
              </h2>
              <p className={styles.sectionDesc}>
                Add, link, complete, schedule, merge, plan. No menus, no hunting for
                the right button. Say what you want, look at what we propose, accept.
              </p>
            </FadeUp>

            <FadeUp delay={0.1}>
              <ControlHubDemo />
            </FadeUp>
          </div>
        </section>

        {/* ── Planner ── */}
        <section className={styles.section}>
          <div className={styles.inner}>
            <div className={styles.assistantLayout}>
              <FadeUp className={styles.assistantInfo}>
                <span className={styles.secNumBlock}>04</span>
                <h2 className={styles.h2}>
                  We plan. You do.
                </h2>
                <p className={styles.assistantDesc}>
                  Tell us the window: an hour, an afternoon, a whole day. We know what&apos;s urgent, what&apos;s blocked, and what you&apos;ve been avoiding. You just start the timer.
                </p>
                <ul className={styles.assistantList}>
                  <li>1-hour, 2-hour, or full-day windows</li>
                  <li>Focus, admin, break, buffer — in the right order</li>
                  <li>Learns from what you actually did</li>
                </ul>
              </FadeUp>

              <FadeUp delay={0.15} className={styles.assistantChatWrap}>
                <PlannerDemo />
              </FadeUp>
            </div>
          </div>
        </section>

        {/* ── Habits deep dive ── */}
        <section className={styles.section}>
          <div className={styles.inner}>
            <FadeUp className={styles.secHeadCenter}>
              <span className={styles.secNumCenter}>05</span>
              <h2 className={styles.h2}>
                Streaks with a destination.
              </h2>
              <p className={styles.habitsLede}>
                Every habit points at a real goal you wrote down, so a streak stops
                being a vanity number. It&apos;s a milestone counter.
              </p>
            </FadeUp>

            <FadeUp delay={0.12} className={styles.habitsStage}>
              <HabitsCalendar />
            </FadeUp>

            <FadeUp delay={0.2} className={styles.habitLinks}>
              <div className={styles.habitLinkRow}>
                <span className={styles.habitLinkFrom}>Spanish &middot; 10m/day</span>
                <span className={styles.habitLinkArrow} aria-hidden="true">→</span>
                <span className={styles.habitLinkTo}>Mexico City trip</span>
              </div>
              <div className={styles.habitLinkRow}>
                <span className={styles.habitLinkFrom}>Leetcode &middot; 1/day</span>
                <span className={styles.habitLinkArrow} aria-hidden="true">→</span>
                <span className={styles.habitLinkTo}>Job hunt (started Feb)</span>
              </div>
              <div className={styles.habitLinkRow}>
                <span className={styles.habitLinkFrom}>Read &middot; 20 pages</span>
                <span className={styles.habitLinkArrow} aria-hidden="true">→</span>
                <span className={styles.habitLinkTo}>Finish 6 books · Q3</span>
              </div>
            </FadeUp>
          </div>
        </section>

        {/* ── Differentiator ── */}
        <section className={styles.diff}>
          <div className={styles.inner}>
            <FadeUp className={styles.centered}>
              <span className={styles.label}>Why not just…</span>
              <h2 className={styles.h2}>
                Any other tool?
              </h2>
            </FadeUp>

            <FadeUp delay={0.1}>
              <div className={styles.diffList}>
                <div className={styles.diffRow}>
                  <span className={styles.diffWhat}>To-do apps</span>
                  <span className={styles.diffSays}>track tasks in a vacuum. No habits, no goals, no <em>why</em>.</span>
                </div>
                <div className={styles.diffRow}>
                  <span className={styles.diffWhat}>Habit apps</span>
                  <span className={styles.diffSays}>track streaks. They don&apos;t know what those streaks are <em>for</em>.</span>
                </div>
                <div className={styles.diffRow}>
                  <span className={styles.diffWhat}>Note apps</span>
                  <span className={styles.diffSays}>store. They don&apos;t connect to the work you&apos;re doing.</span>
                </div>
                <div className={styles.diffRow}>
                  <span className={styles.diffWhat}>AI chatbots</span>
                  <span className={styles.diffSays}>answer once, then forget your life every conversation.</span>
                </div>
                <div className={`${styles.diffRow} ${styles.diffRowUs}`}>
                  <span className={styles.diffWhat}>BrainDump</span>
                  <span className={styles.diffSays}>all four — tasks, habits, notes, AI — sharing one graph that <em>actually remembers</em>.</span>
                </div>
              </div>
            </FadeUp>
          </div>
        </section>

        {/* ── CTA ── */}
        <section className={styles.cta} id="pricing">
          <div className={styles.ctaGlow} aria-hidden="true" />
          <FadeUp className={styles.ctaInner}>
            <h2 className={styles.ctaH2}>
              The last productivity app{"\n"}
              <span className={styles.gradient}>you&apos;ll ever need.</span>
            </h2>
            <p className={styles.ctaSub}>Pick a plan. Cancel anytime.</p>
            <div className={styles.ctaActions}>
              <PricingCards variant="cta" />
            </div>
          </FadeUp>
        </section>

        {/* ── Footer ── */}
        <footer className={styles.footer}>
          <div className={styles.footerInner}>
            <Image src="/logo_withtext.svg" alt="BrainDump" width={160} height={32} className={styles.footerLogoImg} />
            <div className={styles.footerLinks}>
              <Link href="/privacy" className={styles.footerLink}>Privacy</Link>
              <Link href="/terms" className={styles.footerLink}>Terms</Link>
            </div>
            <span className={styles.footerCopy}>© 2026 BrainDump</span>
          </div>
        </footer>
      </div>
    </>
  );
}
