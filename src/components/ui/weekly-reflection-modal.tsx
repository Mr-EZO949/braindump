"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { CloseIcon, ChartBarIcon } from "@/components/ui/icons";
import { NODE_COLOR_BY_TYPE } from "@/lib/graph/node-colors";

type DailyBucket = {
  date: string;
  completed: number;
  created: number;
  scheduled: number;
  scheduled_done: number;
};

type TypeBucket = {
  node_type: string;
  count: number;
};

type ReflectionData = {
  window_days: number;
  daily: DailyBucket[];
  type_breakdown: TypeBucket[];
  totals: {
    completed: number;
    created: number;
    scheduled: number;
    scheduled_done: number;
    completion_rate: number | null;
  };
  commentary: string | null;
};

type MoodValue = {
  energy: number;
  momentum: number;
  satisfaction: number;
  label: string;
};

type WeeklyReflectionModalProps = {
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
};

const MOOD_OPTIONS = [
  { value: "thriving", label: "Thriving" },
  { value: "steady", label: "Steady" },
  { value: "stretched", label: "Stretched" },
  { value: "drifting", label: "Drifting" },
  { value: "burnt-out", label: "Burnt out" },
];

// One palette for every surface; legacy "concept" rows render as notes.
const TYPE_COLORS: Record<string, string> = { ...NODE_COLOR_BY_TYPE, concept: NODE_COLOR_BY_TYPE.note };

function moodStorageKey(workspaceId: string, weekStart: string): string {
  return `braindump:weekly-mood:${workspaceId}:${weekStart}`;
}

function shortDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

// ── Charts (hand-rolled SVG, no chart lib) ────────────────────────────────

function BarChart({ daily }: { daily: DailyBucket[] }) {
  const width = 320;
  const height = 140;
  const padding = { top: 16, right: 12, bottom: 26, left: 24 };
  const inner = {
    w: width - padding.left - padding.right,
    h: height - padding.top - padding.bottom,
  };
  const max = Math.max(1, ...daily.map((d) => d.completed));
  const barW = (inner.w / daily.length) * 0.66;
  const gap = (inner.w / daily.length) * 0.34;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label="Completions per day">
      {/* Y-axis ticks (0 and max) */}
      <line
        x1={padding.left}
        x2={padding.left}
        y1={padding.top}
        y2={padding.top + inner.h}
        stroke="rgba(255,255,255,0.08)"
        strokeWidth="1"
      />
      <text x={padding.left - 6} y={padding.top + 4} textAnchor="end" fontSize="9" fill="rgba(255,255,255,0.45)">
        {max}
      </text>
      <text x={padding.left - 6} y={padding.top + inner.h + 3} textAnchor="end" fontSize="9" fill="rgba(255,255,255,0.45)">
        0
      </text>

      {daily.map((d, i) => {
        const ratio = d.completed / max;
        const h = ratio * inner.h;
        const x = padding.left + (gap / 2) + i * (barW + gap);
        const y = padding.top + inner.h - h;
        return (
          <g key={d.date}>
            {h > 0 ? (
              <rect
                x={x}
                y={y}
                width={barW}
                height={h}
                rx="2.5"
                fill="rgba(95,201,160,0.7)"
                stroke="rgba(95,201,160,0.95)"
                strokeWidth="0.6"
              />
            ) : null}
            <text
              x={x + barW / 2}
              y={padding.top + inner.h + 14}
              textAnchor="middle"
              fontSize="9.5"
              fill="rgba(255,255,255,0.55)"
              fontFamily="ui-sans-serif, system-ui, sans-serif"
            >
              {shortDay(d.date)}
            </text>
            {d.completed > 0 ? (
              <text
                x={x + barW / 2}
                y={y - 3}
                textAnchor="middle"
                fontSize="9"
                fill="rgba(255,255,255,0.7)"
                fontWeight="600"
              >
                {d.completed}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function LineChart({ daily }: { daily: DailyBucket[] }) {
  const width = 320;
  const height = 140;
  const padding = { top: 16, right: 12, bottom: 26, left: 24 };
  const inner = {
    w: width - padding.left - padding.right,
    h: height - padding.top - padding.bottom,
  };

  // Cumulative completions
  let acc = 0;
  const points = daily.map((d, i) => {
    acc += d.completed;
    return { i, value: acc, date: d.date };
  });
  const max = Math.max(1, ...points.map((p) => p.value));
  const xStep = inner.w / Math.max(1, points.length - 1);

  const path = points
    .map((p) => {
      const x = padding.left + p.i * xStep;
      const y = padding.top + inner.h - (p.value / max) * inner.h;
      return `${p.i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  const areaPath =
    path +
    ` L ${(padding.left + (points.length - 1) * xStep).toFixed(2)} ${(padding.top + inner.h).toFixed(2)}` +
    ` L ${padding.left.toFixed(2)} ${(padding.top + inner.h).toFixed(2)} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label="Cumulative completions">
      <line
        x1={padding.left}
        x2={padding.left}
        y1={padding.top}
        y2={padding.top + inner.h}
        stroke="rgba(255,255,255,0.08)"
        strokeWidth="1"
      />
      <text x={padding.left - 6} y={padding.top + 4} textAnchor="end" fontSize="9" fill="rgba(255,255,255,0.45)">
        {max}
      </text>
      <text x={padding.left - 6} y={padding.top + inner.h + 3} textAnchor="end" fontSize="9" fill="rgba(255,255,255,0.45)">
        0
      </text>

      <path d={areaPath} fill="rgba(107,140,239,0.18)" />
      <path d={path} fill="none" stroke="rgba(107,140,239,0.95)" strokeWidth="1.6" strokeLinejoin="round" />

      {points.map((p) => {
        const x = padding.left + p.i * xStep;
        const y = padding.top + inner.h - (p.value / max) * inner.h;
        return (
          <g key={p.date}>
            <circle cx={x} cy={y} r="2.4" fill="rgba(107,140,239,0.95)" />
            <text
              x={x}
              y={padding.top + inner.h + 14}
              textAnchor="middle"
              fontSize="9.5"
              fill="rgba(255,255,255,0.55)"
            >
              {shortDay(p.date)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function PieChart({ types }: { types: TypeBucket[] }) {
  const size = 140;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 56;
  const inner = 30;

  const total = types.reduce((sum, t) => sum + t.count, 0);

  if (total === 0) {
    return (
      <div className="weekly-pie-empty">
        <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
          <circle cx={cx} cy={cy} r={radius} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1.2" />
          <circle cx={cx} cy={cy} r={inner} fill="rgba(255,255,255,0.04)" />
        </svg>
        <p className="weekly-pie-empty-msg">No completions yet this week.</p>
      </div>
    );
  }

  let cursor = -Math.PI / 2; // start at 12 o'clock
  const slices = types.map((t) => {
    const angle = (t.count / total) * Math.PI * 2;
    const startAngle = cursor;
    const endAngle = cursor + angle;
    cursor = endAngle;

    const x1 = cx + Math.cos(startAngle) * radius;
    const y1 = cy + Math.sin(startAngle) * radius;
    const x2 = cx + Math.cos(endAngle) * radius;
    const y2 = cy + Math.sin(endAngle) * radius;
    const x3 = cx + Math.cos(endAngle) * inner;
    const y3 = cy + Math.sin(endAngle) * inner;
    const x4 = cx + Math.cos(startAngle) * inner;
    const y4 = cy + Math.sin(startAngle) * inner;
    const largeArc = angle > Math.PI ? 1 : 0;

    const path = [
      `M ${x1.toFixed(2)} ${y1.toFixed(2)}`,
      `A ${radius} ${radius} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
      `L ${x3.toFixed(2)} ${y3.toFixed(2)}`,
      `A ${inner} ${inner} 0 ${largeArc} 0 ${x4.toFixed(2)} ${y4.toFixed(2)}`,
      "Z",
    ].join(" ");

    return {
      type: t.node_type,
      count: t.count,
      color: TYPE_COLORS[t.node_type] ?? "#cccccc",
      path,
    };
  });

  return (
    <div className="weekly-pie-wrap">
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label="Completed by type">
        {slices.map((s) => (
          <path key={s.type} d={s.path} fill={s.color} fillOpacity="0.78" stroke={s.color} strokeWidth="0.8" />
        ))}
        <text x={cx} y={cy + 4} textAnchor="middle" fontSize="14" fontWeight="700" fill="#f1ece6">
          {total}
        </text>
      </svg>
      <ul className="weekly-pie-legend">
        {slices.map((s) => (
          <li key={s.type}>
            <span className="weekly-pie-swatch" style={{ background: s.color }} />
            <span className="weekly-pie-type">{s.type}</span>
            <span className="weekly-pie-count">{s.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Modal ──────────────────────────────────────────────────────────────────

export function WeeklyReflectionModal({
  workspaceId,
  workspaceName,
  onClose,
}: WeeklyReflectionModalProps) {
  const [data, setData] = useState<ReflectionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mood, setMood] = useState<MoodValue>({
    energy: 5,
    momentum: 5,
    satisfaction: 5,
    label: "steady",
  });
  const [moodSaved, setMoodSaved] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step titles drive the indicator label + body header. Kept short so they
  // don't fight the content for vertical space.
  const STEPS: Array<{ index: 1 | 2 | 3; title: string; caption: string }> = [
    { index: 1, title: "This week", caption: "The headline numbers" },
    { index: 2, title: "How it shaped up", caption: "Pace, shape, reflection" },
    { index: 3, title: "Check in", caption: "How did the week feel?" },
  ];
  const current = STEPS[step - 1];

  // Load mood from localStorage if previously saved this week
  useEffect(() => {
    if (typeof window === "undefined" || !data) return;
    const weekStart = data.daily[0]?.date ?? "";
    const key = moodStorageKey(workspaceId, weekStart);
    try {
      const stored = window.localStorage.getItem(key);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed === "object") {
          setMood({
            energy: typeof parsed.energy === "number" ? parsed.energy : 5,
            momentum: typeof parsed.momentum === "number" ? parsed.momentum : 5,
            satisfaction: typeof parsed.satisfaction === "number" ? parsed.satisfaction : 5,
            label: typeof parsed.label === "string" ? parsed.label : "steady",
          });
          setMoodSaved(true);
        }
      }
    } catch {
      // ignore
    }
  }, [data, workspaceId]);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);

    fetch("/api/assistant/weekly-reflection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId }),
      signal: ac.signal,
    })
      .then(async (r) => {
        const json = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(json?.error ?? "Could not load reflection");
        return json as ReflectionData;
      })
      .then(setData)
      .catch((err) => {
        if (ac.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Could not load reflection");
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });

    return () => ac.abort();
  }, [workspaceId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleSaveMood = () => {
    if (!data) return;
    if (typeof window === "undefined") return;
    const weekStart = data.daily[0]?.date ?? "";
    const key = moodStorageKey(workspaceId, weekStart);
    try {
      window.localStorage.setItem(key, JSON.stringify(mood));
      setMoodSaved(true);
    } catch {
      // ignore
    }
  };

  const completionRatePct =
    data?.totals.completion_rate != null ? Math.round(data.totals.completion_rate * 100) : null;

  return (
    <motion.div
      className="weekly-backdrop"
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      initial={{ opacity: 0 }}
      transition={{ duration: 0.14 }}
      onClick={onClose}
    >
      <motion.div
        className="weekly-modal"
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 12 }}
        initial={{ opacity: 0, y: 12 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Weekly reflection"
      >
        <header className="weekly-header">
          <div>
            <p className="weekly-kicker">
              <ChartBarIcon className="h-[12px] w-[12px]" />
              Weekly review · {workspaceName}
            </p>
            <h2 className="weekly-title">{current.title}</h2>
            <p className="weekly-step-caption">{current.caption}</p>
          </div>
          <button className="weekly-close" type="button" onClick={onClose} aria-label="Close">
            <CloseIcon className="h-[14px] w-[14px]" />
          </button>
        </header>

        {/* Step indicator — three dots, the current one filled. */}
        <div className="weekly-step-indicator" role="tablist" aria-label="Review steps">
          {STEPS.map((s) => (
            <button
              key={s.index}
              type="button"
              role="tab"
              aria-selected={s.index === step}
              aria-label={`Step ${s.index}: ${s.title}`}
              className="weekly-step-dot"
              data-active={s.index === step}
              data-complete={s.index < step}
              onClick={() => setStep(s.index)}
              disabled={loading || !data}
            >
              <span className="weekly-step-dot-num">{s.index}</span>
              <span className="weekly-step-dot-label">{s.title}</span>
            </button>
          ))}
        </div>

        {loading ? (
          <div className="weekly-loading">Loading reflection…</div>
        ) : error ? (
          <div className="weekly-error">{error}</div>
        ) : !data ? null : (
          <div className="weekly-step-body">
            {step === 1 ? (
              <>
                {/* KPI strip — the four headline numbers, given room to breathe. */}
                <section className="weekly-kpi-row">
                  <div className="weekly-kpi">
                    <span className="weekly-kpi-value">{data.totals.completed}</span>
                    <span className="weekly-kpi-label">completed</span>
                  </div>
                  <div className="weekly-kpi">
                    <span className="weekly-kpi-value">{data.totals.created}</span>
                    <span className="weekly-kpi-label">created</span>
                  </div>
                  <div className="weekly-kpi">
                    <span className="weekly-kpi-value">{data.totals.scheduled}</span>
                    <span className="weekly-kpi-label">scheduled</span>
                  </div>
                  <div className="weekly-kpi">
                    <span className="weekly-kpi-value">
                      {completionRatePct !== null ? `${completionRatePct}%` : "—"}
                    </span>
                    <span className="weekly-kpi-label">plan rate</span>
                  </div>
                </section>

                {/* Daily bar chart sits with the KPIs — both answer "how much". */}
                <section className="weekly-chart-solo">
                  <h3 className="weekly-chart-title">Completed per day</h3>
                  <BarChart daily={data.daily} />
                </section>
              </>
            ) : null}

            {step === 2 ? (
              <>
                {/* Cumulative + pie + AI commentary — the "shape" + the read. */}
                <section className="weekly-charts">
                  <div className="weekly-chart-cell">
                    <h3 className="weekly-chart-title">Cumulative</h3>
                    <LineChart daily={data.daily} />
                  </div>
                  <div className="weekly-chart-cell">
                    <h3 className="weekly-chart-title">By type</h3>
                    <PieChart types={data.type_breakdown} />
                  </div>
                </section>

                {data.commentary ? (
                  <section className="weekly-commentary weekly-commentary--prominent">
                    <p className="weekly-commentary-label">Reflection</p>
                    <p className="weekly-commentary-text">{data.commentary}</p>
                  </section>
                ) : null}
              </>
            ) : null}

            {step === 3 ? (
              <section className="weekly-mood">
                <div className="weekly-mood-sliders">
                  <label className="weekly-slider">
                    <span className="weekly-slider-label">
                      Energy <span className="weekly-slider-val">{mood.energy}</span>
                    </span>
                    <input
                      type="range"
                      min={1}
                      max={10}
                      value={mood.energy}
                      onChange={(e) => {
                        setMood({ ...mood, energy: Number(e.target.value) });
                        setMoodSaved(false);
                      }}
                    />
                  </label>
                  <label className="weekly-slider">
                    <span className="weekly-slider-label">
                      Momentum <span className="weekly-slider-val">{mood.momentum}</span>
                    </span>
                    <input
                      type="range"
                      min={1}
                      max={10}
                      value={mood.momentum}
                      onChange={(e) => {
                        setMood({ ...mood, momentum: Number(e.target.value) });
                        setMoodSaved(false);
                      }}
                    />
                  </label>
                  <label className="weekly-slider">
                    <span className="weekly-slider-label">
                      Satisfaction <span className="weekly-slider-val">{mood.satisfaction}</span>
                    </span>
                    <input
                      type="range"
                      min={1}
                      max={10}
                      value={mood.satisfaction}
                      onChange={(e) => {
                        setMood({ ...mood, satisfaction: Number(e.target.value) });
                        setMoodSaved(false);
                      }}
                    />
                  </label>
                </div>

                <div className="weekly-mood-select">
                  {MOOD_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className="weekly-mood-chip"
                      data-active={mood.label === opt.value}
                      onClick={() => {
                        setMood({ ...mood, label: opt.value });
                        setMoodSaved(false);
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        )}

        {/* Step nav: Back / Next on 1-2, Save on 3. Hidden while loading. */}
        {data && !loading && !error ? (
          <footer className="weekly-step-nav">
            <button
              type="button"
              className="weekly-step-back"
              onClick={() => setStep((s) => (s > 1 ? ((s - 1) as 1 | 2 | 3) : s))}
              disabled={step === 1}
            >
              Back
            </button>
            {step < 3 ? (
              <button
                type="button"
                className="weekly-step-next"
                onClick={() => setStep((s) => (s < 3 ? ((s + 1) as 1 | 2 | 3) : s))}
              >
                Next
              </button>
            ) : (
              <button
                type="button"
                className="weekly-mood-save"
                onClick={handleSaveMood}
                disabled={moodSaved}
              >
                {moodSaved ? "Saved" : "Save reflection"}
              </button>
            )}
          </footer>
        ) : null}
      </motion.div>
    </motion.div>
  );
}
