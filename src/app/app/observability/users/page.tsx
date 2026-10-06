import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { isOwnerEmail } from "@/lib/auth/owner";
import { getOwnerCostOverview } from "@/lib/ai/owner-cost";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import styles from "../observability.module.css";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

const integerFormatter = new Intl.NumberFormat("en-US");

function formatUsd(value: number | null) {
  if (value == null) return "No data";
  return usdFormatter.format(value);
}

function formatCount(value: number) {
  return integerFormatter.format(value);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(value));
}

function formatTimestamp(value: string | null) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default async function OwnerUsersCostPage() {
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

  // Fail-closed owner gate: non-owners get a 404, not a redirect — we don't even
  // acknowledge the route exists.
  if (!isOwnerEmail(user.email)) {
    notFound();
  }

  const overview = await getOwnerCostOverview();

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <section className={styles.hero}>
          <p className={styles.eyebrow}>Owner</p>
          <div className={styles.titleRow}>
            <div>
              <h1 className={styles.title}>All-User Cost</h1>
              <p className={styles.subtitle}>
                Every account&apos;s AI spend, newest month first. Reads all{" "}
                <code>ai_runs</code> rows via the service-role key — visible only to
                owner accounts. <Link href="/app/observability">← Back to your own metrics</Link>
              </p>
            </div>
            <div className={styles.windowBadge}>
              Cost month: {formatDate(overview.month_start)}
              <br />
              Generated: {formatTimestamp(overview.generated_at)}
            </div>
          </div>
        </section>

        <section className={styles.grid}>
          <article className={styles.card}>
            <p className={styles.label}>This Month — All Users</p>
            <p className={styles.metric}>{formatUsd(overview.total_month_usd)}</p>
            <p className={styles.hint}>Sum of every account&apos;s spend this calendar month.</p>
          </article>

          <article className={styles.card}>
            <p className={styles.label}>All-Time — All Users</p>
            <p className={styles.metric}>{formatUsd(overview.total_all_time_usd)}</p>
            <p className={styles.hint}>Total logged AI cost since day one.</p>
          </article>

          <article className={styles.card}>
            <p className={styles.label}>Active Accounts</p>
            <p className={styles.metric}>{formatCount(overview.user_count)}</p>
            <p className={styles.hint}>Accounts with at least one logged AI run.</p>
          </article>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>Per-User Breakdown</h2>
              <p className={styles.sectionCopy}>
                Sorted by this month&apos;s spend. Projection = per-active-day rate × 30.
              </p>
            </div>
            <div className={styles.sectionMeta}>Uses stored `estimated_cost`.</div>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>This Month</th>
                  <th>All-Time</th>
                  <th>Runs</th>
                  <th>Active Days</th>
                  <th>Per Active Day</th>
                  <th>Projected / 30d</th>
                  <th>Top Model</th>
                  <th>Last Active</th>
                </tr>
              </thead>
              <tbody>
                {overview.users.length === 0 ? (
                  <tr>
                    <td colSpan={9}>
                      <div className={styles.empty}>No AI runs logged for any account yet.</div>
                    </td>
                  </tr>
                ) : (
                  overview.users.map((row) => (
                    <tr key={row.user_id}>
                      <td>
                        <Link href={`/app/observability/users/${row.user_id}`}>{row.email ?? "unknown"}</Link>
                        {row.failed_runs > 0 ? (
                          <>
                            <br />
                            <span className={styles.muted}>{formatCount(row.failed_runs)} failed</span>
                          </>
                        ) : null}
                      </td>
                      <td>{formatUsd(row.month_cost_usd)}</td>
                      <td>{formatUsd(row.total_cost_usd)}</td>
                      <td>
                        {formatCount(row.run_count)}
                        <br />
                        <span className={styles.muted}>{formatCount(row.month_run_count)} this mo.</span>
                      </td>
                      <td>{formatCount(row.active_days)}</td>
                      <td>{formatUsd(row.per_active_day_usd)}</td>
                      <td>{formatUsd(row.projected_30d_usd)}</td>
                      <td>
                        <span className={styles.muted}>{row.top_model ?? "—"}</span>
                      </td>
                      <td>{formatTimestamp(row.last_run_at)}</td>
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
