// Where a slow request spends its time (a long brain dump took 30–35 s on
// 2026-10-02). Spans recorded anywhere under withTimings — the builder, the
// change set — end up in ONE server log line when it finishes; outside it,
// timed() just runs the work. Server only.

import { AsyncLocalStorage } from "node:async_hooks";

interface Span {
  name: string;
  // ms after the request started.
  start: number;
  ms: number;
}

interface Timings {
  label: string;
  t0: number;
  spans: Span[];
}

const current = new AsyncLocalStorage<Timings>();

export async function withTimings<T>(label: string, t0: number, work: () => Promise<T>): Promise<T> {
  const timings: Timings = { label, t0, spans: [] };
  try {
    return await current.run(timings, work);
  } finally {
    console.log(formatTimings(timings.label, timings.spans, Date.now() - timings.t0));
  }
}

export async function timed<T>(name: string, work: () => PromiseLike<T>): Promise<T> {
  const timings = current.getStore();
  if (!timings) return work();
  const start = Date.now();
  try {
    return await work();
  } finally {
    timings.spans.push({ name, start: start - timings.t0, ms: Date.now() - start });
  }
}

// A span whose start and end were taken by hand (e.g. from a callback).
export function recordSpan(name: string, startedAt: number, endedAt = Date.now()): void {
  const timings = current.getStore();
  if (timings) timings.spans.push({ name, start: startedAt - timings.t0, ms: endedAt - startedAt });
}

const seconds = (ms: number) => (ms / 1000).toFixed(2);

// "[timing] dump 31.42s" then one "  name  @start  duration" line per span, in start order.
export function formatTimings(label: string, spans: Span[], totalMs: number): string {
  const width = Math.max(0, ...spans.map((s) => s.name.length));
  const lines = [...spans]
    .sort((a, b) => a.start - b.start || b.ms - a.ms)
    .map((s) => `  ${s.name.padEnd(width)}  @${seconds(s.start).padStart(6)}  ${seconds(s.ms).padStart(6)}s`);
  return [`[timing] ${label} ${seconds(totalMs)}s`, ...lines].join("\n");
}
