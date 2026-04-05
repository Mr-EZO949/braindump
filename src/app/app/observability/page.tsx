import { redirect } from "next/navigation";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getAIObservabilitySnapshot } from "@/lib/ai/telemetry";

import styles from "./observability.module.css";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

const integerFormatter = new Intl.NumberFormat("en-US");

function formatUsd(value: number | null) {
  if (value == null) {
    return "No data";
  }

  return usdFormatter.format(value);
}

function formatPercent(value: number | null) {
  if (value == null) {
    return "No data";
  }

  return `${value.toFixed(1)}%`;
}

function formatCount(value: number) {
  return integerFormatter.format(value);
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
  }).format(new Date(value));
}

function statusClassName(status: "success" | "failed" | "retrying") {
  if (status === "success") {
    return `${styles.pill} ${styles.success}`;
  }

  if (status === "retrying") {
    return `${styles.pill} ${styles.retrying}`;
  }

  return `${styles.pill} ${styles.failed}`;
}

export default async function ObservabilityPage() {
  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return <main className={styles.page}>Server configuration error.</main>;
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const snapshot = await getAIObservabilitySnapshot({
    supabase,
    userId: user.id,
  });

  const recentFailures = snapshot.recent_runs
    .filter((run) => run.status !== "success")
    .slice(0, 8);

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <section className={styles.hero}>
          <p className={styles.eyebrow}>Phase 14</p>
          <div className={styles.titleRow}>
            <div>
              <h1 className={styles.title}>AI Observability</h1>
              <p className={styles.subtitle}>
                Recent run health, operator-facing cost tracking, and the core
                product counters that show whether the graph pipeline is getting
                better or just getting busier.
              </p>
            </div>
            <div className={styles.windowBadge}>
              Recent window: {formatDate(snapshot.window.recent_start)}
              <br />
              Cost month: {formatDate(snapshot.window.cost_month_start)}
            </div>
          </div>
        </section>

        <section className={styles.grid}>
          <article className={styles.card}>
            <p className={styles.label}>Monthly AI Cost</p>
            <p className={styles.metric}>
              {formatUsd(snapshot.cost_summary.monthly_total_usd)}
            </p>
            <p className={styles.hint}>Current month across all logged AI runs.</p>
          </article>

          <article className={styles.card}>
            <p className={styles.label}>Avg Brain Dump Session</p>
            <p className={styles.metric}>
              {formatUsd(snapshot.cost_summary.average_brain_dump_session_cost_usd)}
            </p>
            <p className={styles.hint}>
              Average `extract` run cost this month.
            </p>
          </article>

          <article className={styles.card}>
            <p className={styles.label}>Rate Limit Frequency</p>
            <p className={styles.metric}>
              {formatPercent(snapshot.counter_metrics.rate_limit_hit_frequency.rate)}
            </p>
            <p className={styles.hint}>
              {formatCount(snapshot.counter_metrics.rate_limit_hit_frequency.numerator)} of{" "}
              {formatCount(snapshot.counter_metrics.rate_limit_hit_frequency.denominator)} recent
              runs.
            </p>
          </article>

          <article className={styles.card}>
            <p className={styles.label}>Node Proposal Acceptance</p>
            <p className={styles.metric}>
              {formatPercent(snapshot.counter_metrics.node_proposal_acceptance_rate.rate)}
            </p>
            <p className={styles.hint}>
              {formatCount(snapshot.counter_metrics.node_proposal_acceptance_rate.numerator)} accepted /{" "}
              {formatCount(snapshot.counter_metrics.node_proposal_acceptance_rate.denominator)} reviewed.
            </p>
          </article>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>Cost Tracking</h2>
              <p className={styles.sectionCopy}>
                Provider and model totals plus the daily run-type breakdown for the current month.
              </p>
            </div>
            <div className={styles.sectionMeta}>Uses stored token counts and `estimated_cost`.</div>
          </div>

          <div className={styles.twoCol}>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Provider / Model</th>
                    <th>Runs</th>
                    <th>Total</th>
                    <th>Avg / Run</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.cost_summary.provider_totals.length === 0 ? (
                    <tr>
                      <td colSpan={4}>
                        <div className={styles.empty}>No cost-tracked AI runs in the current month yet.</div>
                      </td>
                    </tr>
                  ) : (
                    snapshot.cost_summary.provider_totals.map((row) => (
                      <tr key={`${row.provider}:${row.model_name}`}>
                        <td>
                          {row.provider}
                          <br />
                          <span className={styles.muted}>{row.model_name}</span>
                        </td>
                        <td>{formatCount(row.run_count)}</td>
                        <td>{formatUsd(row.total_cost_usd)}</td>
                        <td>{formatUsd(row.average_cost_usd)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Total</th>
                    <th>Run Type Breakdown</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.cost_summary.daily_by_run_type.length === 0 ? (
                    <tr>
                      <td colSpan={3}>
                        <div className={styles.empty}>No daily cost data yet.</div>
                      </td>
                    </tr>
                  ) : (
                    snapshot.cost_summary.daily_by_run_type.map((row) => (
                      <tr key={row.date}>
                        <td>{formatDate(row.date)}</td>
                        <td>{formatUsd(row.total_cost_usd)}</td>
                        <td>
                          {Object.entries(row.run_type_costs)
                            .sort(([a], [b]) => a.localeCompare(b))
                            .map(([runType, value]) => `${runType}: ${formatUsd(value ?? null)}`)
                            .join(" · ")}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>Run Health</h2>
              <p className={styles.sectionCopy}>
                Recent latency by run type and the failure profile from the last 30 days.
              </p>
            </div>
            <div className={styles.sectionMeta}>Error codes are derived from logged failure text.</div>
          </div>

          <div className={styles.twoCol}>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Run Type</th>
                    <th>Runs</th>
                    <th>Avg Latency</th>
                    <th>P95</th>
                    <th>Failure Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.latency_by_run_type.length === 0 ? (
                    <tr>
                      <td colSpan={5}>
                        <div className={styles.empty}>No recent AI runs yet.</div>
                      </td>
                    </tr>
                  ) : (
                    snapshot.latency_by_run_type.map((row) => (
                      <tr key={row.run_type}>
                        <td>{row.run_type}</td>
                        <td>{formatCount(row.run_count)}</td>
                        <td>
                          {row.average_latency_ms == null
                            ? "No data"
                            : `${Math.round(row.average_latency_ms)} ms`}
                        </td>
                        <td>
                          {row.p95_latency_ms == null
                            ? "No data"
                            : `${Math.round(row.p95_latency_ms)} ms`}
                        </td>
                        <td>{formatPercent(row.failure_rate)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className={styles.stack}>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Error Code</th>
                      <th>Count</th>
                      <th>Latest</th>
                      <th>Run Types</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.error_dashboard.length === 0 ? (
                      <tr>
                        <td colSpan={4}>
                          <div className={styles.empty}>No recent AI failures.</div>
                        </td>
                      </tr>
                    ) : (
                      snapshot.error_dashboard.slice(0, 8).map((row) => (
                        <tr key={row.error_code}>
                          <td>{row.error_code}</td>
                          <td>{formatCount(row.count)}</td>
                          <td>{formatTimestamp(row.latest_at)}</td>
                          <td>{row.run_types.join(", ")}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className={styles.card}>
                <p className={styles.label}>Recent Failed Runs</p>
                {recentFailures.length === 0 ? (
                  <div className={styles.empty}>No failed or retrying runs in the latest window.</div>
                ) : (
                  <div className={styles.stack}>
                    {recentFailures.map((run) => (
                      <div key={run.id}>
                        <div className={statusClassName(run.status)}>{run.status}</div>
                        <p className={styles.hint}>
                          {run.run_type} · {run.provider} / {run.model_name}
                        </p>
                        <p className={styles.hint}>{truncateRunError(run.error_text)}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>Core Counters</h2>
              <p className={styles.sectionCopy}>
                Product-quality metrics tied to proposal review, planning, lifecycle, and save-back usage.
              </p>
            </div>
          </div>

          <div className={styles.grid}>
            <article className={styles.card}>
              <p className={styles.label}>Edge Proposal Acceptance</p>
              <p className={styles.metric}>
                {formatPercent(snapshot.counter_metrics.edge_proposal_acceptance_rate.rate)}
              </p>
              <p className={styles.hint}>
                {formatCount(snapshot.counter_metrics.edge_proposal_acceptance_rate.numerator)} accepted /{" "}
                {formatCount(snapshot.counter_metrics.edge_proposal_acceptance_rate.denominator)} reviewed.
              </p>
            </article>

            <article className={styles.card}>
              <p className={styles.label}>Merge Suggestion Precision</p>
              <p className={styles.metric}>
                {formatPercent(snapshot.counter_metrics.merge_suggestion_precision.rate)}
              </p>
              <p className={styles.hint}>
                {formatCount(snapshot.counter_metrics.merge_suggestion_precision.numerator)} merged /{" "}
                {formatCount(snapshot.counter_metrics.merge_suggestion_precision.denominator)} resolved.
              </p>
            </article>

            <article className={styles.card}>
              <p className={styles.label}>Plan Acceptance Rate</p>
              <p className={styles.metric}>
                {formatPercent(snapshot.counter_metrics.plan_rate.acceptance.rate)}
              </p>
              <p className={styles.hint}>
                Edit rate after acceptance:{" "}
                {formatPercent(snapshot.counter_metrics.plan_rate.edits_after_acceptance.rate)}
              </p>
            </article>

            <article className={styles.card}>
              <p className={styles.label}>Assistant Save-To-Graph</p>
              <p className={styles.metric}>
                {formatPercent(snapshot.counter_metrics.assistant_save_to_graph_usage.rate)}
              </p>
              <p className={styles.hint}>
                {formatCount(snapshot.counter_metrics.assistant_save_to_graph_usage.numerator)} assistant saves /{" "}
                {formatCount(snapshot.counter_metrics.assistant_save_to_graph_usage.denominator)} total entries.
              </p>
            </article>

            <article className={styles.card}>
              <p className={styles.label}>Node Completion Rate</p>
              <p className={styles.metric}>
                {formatPercent(snapshot.counter_metrics.node_completion_rate.rate)}
              </p>
              <p className={styles.hint}>
                {formatCount(snapshot.counter_metrics.node_completion_rate.numerator)} completed /{" "}
                {formatCount(snapshot.counter_metrics.node_completion_rate.denominator)} total nodes.
              </p>
            </article>

            <article className={styles.card}>
              <p className={styles.label}>Lifecycle Cascade Frequency</p>
              <p className={styles.metric}>
                {formatPercent(snapshot.counter_metrics.lifecycle_cascade_trigger_frequency.rate)}
              </p>
              <p className={styles.hint}>
                {formatCount(snapshot.counter_metrics.lifecycle_cascade_trigger_frequency.numerator)} cascades /{" "}
                {formatCount(snapshot.counter_metrics.lifecycle_cascade_trigger_frequency.denominator)} lifecycle events.
              </p>
            </article>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>Recent AI Runs</h2>
              <p className={styles.sectionCopy}>
                The latest persisted runs with workspace context, costs, latency, and error state.
              </p>
            </div>
            <div className={styles.sectionMeta}>Last {formatCount(snapshot.recent_runs.length)} runs</div>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Run</th>
                  <th>Status</th>
                  <th>Workspace</th>
                  <th>Latency</th>
                  <th>Cost</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.recent_runs.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <div className={styles.empty}>No AI runs have been logged yet.</div>
                    </td>
                  </tr>
                ) : (
                  snapshot.recent_runs.map((run) => (
                    <tr key={run.id}>
                      <td>{formatTimestamp(run.created_at)}</td>
                      <td>
                        {run.run_type}
                        <br />
                        <span className={styles.muted}>
                          {run.provider} / {run.model_name}
                        </span>
                      </td>
                      <td>
                        <span className={statusClassName(run.status)}>{run.status}</span>
                      </td>
                      <td>{run.workspace_name ?? "No workspace"}</td>
                      <td>
                        {run.latency_ms == null ? "No data" : `${Math.round(run.latency_ms)} ms`}
                      </td>
                      <td>{formatUsd(run.estimated_cost)}</td>
                      <td>
                        {run.error_code ? `${run.error_code}: ` : ""}
                        {run.error_text ?? "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}

function truncateRunError(errorText: string | null) {
  if (!errorText) {
    return "No error text captured.";
  }

  return errorText.length > 120 ? `${errorText.slice(0, 117)}...` : errorText;
}
