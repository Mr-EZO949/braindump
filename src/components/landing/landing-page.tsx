"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useInView, AnimatePresence } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import styles from "./landing.module.css";

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
  400, 680, 680, 680, 680, 680, 700,
  300, 190, 190, 190, 190, 190, 1800,
  300, 250, 250, 250, 250, 250,
  320, 320, 320, 320, 320, 3400,
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

// Assistant chat messages
const CHAT_MSGS = [
  { role: "user" as const,      text: "What should I focus on this week?" },
  { role: "assistant" as const,  text: "Based on your graph, the auth bug is blocking 3 downstream tasks — including the proposal. I'd start there." },
  { role: "user" as const,      text: "What's connected to the auth bug?" },
  { role: "assistant" as const,  text: "It's upstream of: Finish proposal, Embedding search, and the Sarah meeting. It also relates to your \"Auth ↔ Search\" question node." },
];

// Node type info
const TYPE_INFO = [
  { key: "task",     label: "Tasks",     desc: "Things to do" },
  { key: "goal",     label: "Goals",     desc: "Where you're headed" },
  { key: "idea",     label: "Ideas",     desc: "Sparks worth keeping" },
  { key: "concept",  label: "Concepts",  desc: "Things you're learning" },
  { key: "question", label: "Questions", desc: "Open threads" },
  { key: "journal",  label: "Journals",  desc: "How you feel" },
  { key: "project",  label: "Projects",  desc: "Active efforts" },
  { key: "class",    label: "Classes",   desc: "Courses & study" },
];

// Graph: SaaS project with related classes, tasks, ideas
const GRAPH_NODES = [
  { id: "n1", x: 320, y: 52,  type: "project",  label: "Analytics SaaS" },
  { id: "n2", x: 120, y: 145, type: "class",     label: "MIT 6.824" },
  { id: "n3", x: 310, y: 170, type: "task",      label: "Build ingestion API" },
  { id: "n4", x: 510, y: 140, type: "class",     label: "Stanford CS229" },
  { id: "n5", x:  70, y: 290, type: "concept",   label: "Distributed consensus" },
  { id: "n6", x: 220, y: 310, type: "idea",      label: "Use RAFT for sync" },
  { id: "n7", x: 410, y: 290, type: "task",      label: "Implement dashboard" },
  { id: "n8", x: 540, y: 300, type: "idea",      label: "Anomaly detection" },
  { id: "n9", x: 160, y: 400, type: "question",  label: "Postgres or Clickhouse?" },
  { id: "n10",x: 370, y: 400, type: "goal",      label: "Launch by Q3" },
];

const GRAPH_EDGES = [
  { from: "n1", to: "n3" },  // project → task
  { from: "n1", to: "n7" },  // project → task
  { from: "n2", to: "n5" },  // class → concept
  { from: "n5", to: "n6" },  // concept → idea
  { from: "n6", to: "n3" },  // idea → task
  { from: "n4", to: "n8" },  // class → idea
  { from: "n8", to: "n7" },  // idea → task
  { from: "n3", to: "n9" },  // task → question
  { from: "n7", to: "n10" }, // task → goal
  { from: "n6", to: "n9" },  // idea → question
  { from: "n1", to: "n10" }, // project → goal
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

// ── Marquee ───────────────────────────────────────────────

function MarqueeRow({ items, reverse }: { items: typeof MARQUEE_R1; reverse?: boolean }) {
  const doubled = [...items, ...items];
  return (
    <div className={styles.marqueeRow}>
      <div className={`${styles.marqueeTrack} ${reverse ? styles.marqueeReverse : ""}`}>
        {doubled.map((item, i) => (
          <span key={`${item.t}-${i}`} className={styles.marqueePill}
            style={{ borderColor: `${NC[item.type]}35` }}>
            <span className={styles.marqueeType} style={{ color: NC[item.type] }}>{item.type}</span>
            {item.t}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Create-from-chat demo ────────────────────────────────

const CREATE_DEMO_PROMPT = "Break my ML paper into tasks with a literature review section";

const CREATE_DEMO_NODES = [
  { title: "ML Paper", type: "project", delay: 0 },
  { title: "Literature Review", type: "goal", delay: 0.18 },
  { title: "Find related papers", type: "task", delay: 0.32 },
  { title: "Summarize key findings", type: "task", delay: 0.44 },
  { title: "Write methodology draft", type: "task", delay: 0.56 },
  { title: "Outline experiments", type: "task", delay: 0.68 },
];

const CREATE_DEMO_EDGES: [number, number][] = [[0, 1], [1, 2], [1, 3], [0, 4], [0, 5]];

function CreateFromChatDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const v = useInView(ref, { once: true, margin: "-60px" });
  return (
    <div ref={ref} className={styles.createDemo}>
      {/* Prompt bubble */}
      <motion.div className={styles.createPrompt}
        initial={{ opacity: 0, y: 14 }}
        animate={v ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}>
        <span className={styles.createPromptLabel}>You said</span>
        <p className={styles.createPromptText}>&ldquo;{CREATE_DEMO_PROMPT}&rdquo;</p>
      </motion.div>

      {/* Arrow */}
      <motion.div className={styles.createArrow} aria-hidden="true"
        initial={{ opacity: 0, scaleY: 0 }}
        animate={v ? { opacity: 1, scaleY: 1 } : {}}
        transition={{ delay: 0.3, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}>
        <svg width="2" height="40" viewBox="0 0 2 40">
          <line x1="1" y1="0" x2="1" y2="40" stroke="rgba(213,58,71,0.3)" strokeWidth="2" strokeDasharray="4 4" />
        </svg>
        <svg width="12" height="8" viewBox="0 0 12 8" className={styles.createArrowHead}>
          <path d="M1 1 L6 6 L11 1" stroke="rgba(213,58,71,0.4)" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      </motion.div>

      {/* Generated graph preview */}
      <div className={styles.createGraph}>
        <svg viewBox="0 0 400 220" className={styles.createGraphSvg} aria-hidden="true">
          {CREATE_DEMO_EDGES.map(([ai, bi], i) => {
            const positions = [
              { x: 200, y: 30 },   // ML Paper
              { x: 100, y: 100 },  // Literature Review
              { x: 40, y: 180 },   // Find related papers
              { x: 160, y: 180 },  // Summarize key findings
              { x: 280, y: 100 },  // Write methodology draft
              { x: 360, y: 100 },  // Outline experiments
            ];
            const pa = positions[ai], pb = positions[bi];
            return (
              <motion.path key={`ce${i}`}
                d={`M ${pa.x} ${pa.y} L ${pb.x} ${pb.y}`}
                stroke="rgba(213,58,71,0.25)" strokeWidth="1.5" fill="none" strokeLinecap="round"
                initial={{ pathLength: 0, opacity: 0 }}
                animate={v ? { pathLength: 1, opacity: 1 } : {}}
                transition={{ delay: 0.6 + CREATE_DEMO_NODES[bi].delay, duration: 0.35, ease: "easeOut" }} />
            );
          })}
          {CREATE_DEMO_NODES.map((node, i) => {
            const positions = [
              { x: 200, y: 30 },
              { x: 100, y: 100 },
              { x: 40, y: 180 },
              { x: 160, y: 180 },
              { x: 280, y: 100 },
              { x: 360, y: 100 },
            ];
            const pos = positions[i];
            const c = NC[node.type];
            return (
              <motion.g key={`cn${i}`}
                initial={{ opacity: 0 }}
                animate={v ? { opacity: 1 } : {}}
                transition={{ delay: 0.5 + node.delay, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}>
                <circle cx={pos.x} cy={pos.y} r={18} fill={`${c}20`} stroke={`${c}40`} strokeWidth="1" />
                <circle cx={pos.x} cy={pos.y} r={11} fill={`${c}30`} stroke={c} strokeWidth="1.5" strokeOpacity="0.8" />
                <text x={pos.x} y={pos.y + 3.5} textAnchor="middle" fill={c} fontSize="6.5" fontWeight="700"
                  fontFamily="ui-monospace, monospace" opacity="0.95">
                  {node.type.slice(0, 4).toUpperCase()}
                </text>
                <text x={pos.x} y={pos.y + 32} textAnchor="middle" fill="rgba(255,255,255,0.5)" fontSize="8"
                  fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight="500">
                  {node.title}
                </text>
              </motion.g>
            );
          })}
        </svg>
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
        <div className={styles.reviewAccentLine} />
        <h3 className={styles.reviewH3}>You approve every node.</h3>
        <p className={styles.reviewP}>
          AI extracts structure from your dumps — but nothing enters the graph
          until you say so. Accept what&apos;s useful, reject what&apos;s noise, edit what&apos;s close.
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

// ── Node types grid ───────────────────────────────────────

function NodeTypesGrid() {
  const ref = useRef<HTMLDivElement>(null);
  const v = useInView(ref, { once: true, margin: "-60px" });
  return (
    <div ref={ref} className={styles.typesGrid}>
      {TYPE_INFO.map((t, i) => {
        const c = NC[t.key];
        return (
          <motion.div key={t.key} className={styles.typeCard}
            style={{ "--type-c": c } as React.CSSProperties}
            initial={{ opacity: 0, y: 16 }}
            animate={v ? { opacity: 1, y: 0 } : {}}
            transition={{ delay: i * 0.05, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}>
            <div className={styles.typeCardDot} style={{ background: c }} />
            <span className={styles.typeCardName}>{t.label}</span>
            <span className={styles.typeCardDesc}>{t.desc}</span>
          </motion.div>
        );
      })}
    </div>
  );
}

// ── Assistant chat mockup ─────────────────────────────────

function AssistantChat() {
  const ref = useRef<HTMLDivElement>(null);
  const v = useInView(ref, { once: true, margin: "-60px" });
  return (
    <div ref={ref} className={styles.chatPanel}>
      <div className={styles.panelChrome}>
        <span className={styles.chromeDot} />
        <span className={styles.chromeDot} />
        <span className={styles.chromeDot} />
        <span className={styles.panelLabel}>assistant</span>
      </div>
      <div className={styles.chatBody}>
        {CHAT_MSGS.map((msg, i) => (
          <motion.div key={i}
            className={`${styles.chatMsg} ${msg.role === "user" ? styles.chatUser : styles.chatBot}`}
            initial={{ opacity: 0, y: 12, scale: 0.97 }}
            animate={v ? { opacity: 1, y: 0, scale: 1 } : {}}
            transition={{ delay: 0.2 + i * 0.25, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}>
            {msg.role === "assistant" && <Image src="/logo_icon.svg" alt="" width={24} height={24} className={styles.chatIcon} />}
            <span className={styles.chatText}>{msg.text}</span>
          </motion.div>
        ))}
      </div>
      <div className={styles.chatInput}>
        <span className={styles.chatPlaceholder}>Ask your graph anything…</span>
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
    const t = setTimeout(() => setPhase(p => (p >= 25 ? 0 : p + 1)), delay);
    return () => clearTimeout(t);
  }, [phase]);

  const screen: "input" | "extracted" | "graph" =
    phase < 7 ? "input" : phase < 14 ? "extracted" : "graph";

  const visibleThoughts = Math.min(phase, 5);
  const visiblePills    = phase >= 8 ? Math.min(phase - 7, 5) : 0;
  const visibleNodes    = phase >= 15 ? Math.min(phase - 14, 5) : 0;
  const visibleEdges    = phase >= 20 ? Math.min(phase - 19, 5) : 0;
  const cursorIdx       = phase >= 1 && phase <= 6 ? Math.min(phase - 1, 4) : -1;

  const labels = { input: "brain dump", extracted: "extracted", graph: "graph" };

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
          {(["input", "extracted", "graph"] as const).map(s => (
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
        </AnimatePresence>
      </div>
    </div>
  );
}

// ── GraphPreview ──────────────────────────────────────────

function GraphPreview() {
  const svgRef = useRef<SVGSVGElement>(null);
  const inView = useInView(svgRef, { once: true, margin: "-80px" });
  const nodeMap = Object.fromEntries(GRAPH_NODES.map(n => [n.id, n]));

  return (
    <svg ref={svgRef} viewBox="0 0 640 430" className={styles.graphSvg} aria-hidden="true">
      {GRAPH_EDGES.map((e, i) => {
        const a = nodeMap[e.from], b = nodeMap[e.to];
        return (
          <motion.path key={`e${i}`} d={`M ${a.x} ${a.y} L ${b.x} ${b.y}`}
            stroke="rgba(255,255,255,0.07)" strokeWidth="1.5" fill="none" strokeLinecap="round"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={inView ? { pathLength: 1, opacity: 1 } : {}}
            transition={{ duration: 0.7, delay: 0.25 + i * 0.1, ease: "easeInOut" }} />
        );
      })}
      {GRAPH_NODES.map((nd, i) => {
        const c = NC[nd.type];
        return (
          <motion.g key={nd.id} initial={{ opacity: 0 }}
            animate={inView ? { opacity: 1 } : {}}
            transition={{ duration: 0.45, delay: 0.08 + i * 0.07, ease: [0.22, 1, 0.36, 1] }}>
            <circle cx={nd.x} cy={nd.y} r={27} fill={`${c}08`} stroke={`${c}22`} strokeWidth="1" />
            <circle cx={nd.x} cy={nd.y} r={18} fill={`${c}18`} stroke={c} strokeWidth="1.5" strokeOpacity="0.62" />
            <text x={nd.x} y={nd.y + 4} textAnchor="middle" fill={c}
              fontSize="8" fontWeight="700" fontFamily="ui-monospace, monospace" opacity="0.88">
              {nd.type.toUpperCase().slice(0, 4)}
            </text>
            <text x={nd.x} y={nd.y + 40} textAnchor="middle" fill="rgba(255,255,255,0.3)"
              fontSize="9.5" fontFamily="ui-sans-serif, system-ui, sans-serif">{nd.label}</text>
          </motion.g>
        );
      })}
    </svg>
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
            <Image src="/logo_withtext.svg" alt="BrainDump" width={200} height={40} className={styles.navLogoImg} />
          </Link>
          <nav className={styles.navRight}>
            <Link href="/login" className={styles.navLink}>Sign in</Link>
            <Link href="/login" className={styles.navCta}>Get started</Link>
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
              <div className={styles.badge}>
                <span className={styles.badgeDot} />
                AI-powered knowledge graph
              </div>
              <h1 className={styles.heroH1}>
                Stop organizing.<br />
                <span className={styles.gradient}>Start thinking.</span>
              </h1>
              <p className={styles.heroSub}>
                Dump your raw thoughts into BrainDump. AI structures them into a living
                knowledge graph — tasks, goals, ideas, and connections you didn&apos;t know existed.
              </p>
              <div className={styles.heroActions}>
                <Link href="/login" className={styles.btnPrimary}>
                  Start for free <span className={styles.btnArrow}>→</span>
                </Link>
                <a href="#how" className={styles.btnGhost}>How it works</a>
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
          <MarqueeRow items={MARQUEE_R1} />
          <MarqueeRow items={MARQUEE_R2} reverse />
        </div>

        {/* ── Review ── */}
        <section className={styles.section} id="how">
          <div className={styles.inner}>
            <FadeUp className={styles.centered}>
              <span className={styles.label}>Human in the loop</span>
              <h2 className={styles.h2}>
                AI extracts.<br />
                <span className={styles.gradient}>You decide what stays.</span>
              </h2>
            </FadeUp>

            <FadeUp delay={0.1}>
              <ReviewShowcase />
            </FadeUp>
          </div>
        </section>

        {/* ── Node types ── */}
        <section className={styles.sectionAlt}>
          <div className={styles.inner}>
            <FadeUp className={styles.centered}>
              <span className={styles.label}>Eight types of thought</span>
              <h2 className={styles.h2}>
                Not everything is a to-do
              </h2>
            </FadeUp>

            <FadeUp delay={0.1}>
              <NodeTypesGrid />
            </FadeUp>
          </div>
        </section>

        {/* ── Assistant ── */}
        <section className={styles.section}>
          <div className={styles.inner}>
            <div className={styles.assistantLayout}>
              <FadeUp className={styles.assistantInfo}>
                <span className={styles.label}>Built-in assistant</span>
                <h2 className={styles.h2}>
                  Ask your graph,<br />
                  not the internet
                </h2>
                <p className={styles.assistantDesc}>
                  A conversational assistant grounded in your actual knowledge graph.
                  It doesn&apos;t hallucinate from training data — it reads your nodes,
                  traces connections, and answers from what you&apos;ve actually dumped.
                </p>
                <ul className={styles.assistantList}>
                  <li>&ldquo;What&apos;s blocking my project?&rdquo;</li>
                  <li>&ldquo;Summarize what I learned this week&rdquo;</li>
                  <li>&ldquo;Which tasks relate to my CS229 notes?&rdquo;</li>
                </ul>
              </FadeUp>

              <FadeUp delay={0.15} className={styles.assistantChatWrap}>
                <AssistantChat />
              </FadeUp>
            </div>
          </div>
        </section>

        {/* ── Create from chat ── */}
        <section className={styles.sectionAlt}>
          <div className={styles.inner}>
            <div className={styles.createLayout}>
              <FadeUp delay={0.1} className={styles.createVisualWrap}>
                <CreateFromChatDemo />
              </FadeUp>

              <FadeUp className={styles.createInfo}>
                <span className={styles.label}>Talk, don&apos;t click</span>
                <h2 className={styles.h2}>
                  Describe it once.<br />
                  <span className={styles.gradient}>Get a full structure.</span>
                </h2>
                <ul className={styles.assistantList}>
                  <li>&ldquo;Break this goal into weekly tasks&rdquo;</li>
                  <li>&ldquo;Add a project for the ML paper with subtasks&rdquo;</li>
                  <li>&ldquo;Track my job search — applications, prep, interviews&rdquo;</li>
                </ul>
              </FadeUp>
            </div>
          </div>
        </section>

        {/* ── Planner ── */}
        <section className={styles.section}>
          <div className={styles.inner}>
            <div className={styles.assistantLayout}>
              <FadeUp className={styles.assistantInfo}>
                <span className={styles.label}>AI planner</span>
                <h2 className={styles.h2}>
                  Plan the next hour.<br />
                  <span className={styles.gradient}>From your graph.</span>
                </h2>
                <p className={styles.assistantDesc}>
                  The planner reads your tasks, priorities, dependencies, and due dates,
                  then builds a realistic time-blocked schedule — focus blocks, admin,
                  breaks, and buffers. Drag to reorder, accept, or regenerate.
                </p>
                <ul className={styles.assistantList}>
                  <li>1-hour, 2-hour, or full-day windows</li>
                  <li>Respects blockers and prerequisite chains</li>
                  <li>Learns from your edits and rejections</li>
                </ul>
              </FadeUp>

              <FadeUp delay={0.15} className={styles.assistantChatWrap}>
                <PlannerDemo />
              </FadeUp>
            </div>
          </div>
        </section>

        {/* ── CTA ── */}
        <section className={styles.cta}>
          <div className={styles.ctaGlow} aria-hidden="true" />
          <FadeUp className={styles.ctaInner}>
            <h2 className={styles.ctaH2}>
              Your thoughts are already connected.{"\n"}
              <span className={styles.gradient}>Let us show you how.</span>
            </h2>
            <p className={styles.ctaSub}>Free to start. No card required.</p>
            <div className={styles.ctaActions}>
              <Link href="/login" className={styles.btnPrimary}>
                Start for free <span className={styles.btnArrow}>→</span>
              </Link>
            </div>
          </FadeUp>
        </section>

        {/* ── Footer ── */}
        <footer className={styles.footer}>
          <div className={styles.footerInner}>
            <Image src="/logo_withtext.svg" alt="BrainDump" width={160} height={32} className={styles.footerLogoImg} />
            <div className={styles.footerLinks}>
              <a href="#" className={styles.footerLink}>Privacy</a>
              <a href="#" className={styles.footerLink}>Terms</a>
            </div>
            <span className={styles.footerCopy}>© 2026 BrainDump</span>
          </div>
        </footer>
      </div>
    </>
  );
}
