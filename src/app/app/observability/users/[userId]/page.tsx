import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { isOwnerEmail } from "@/lib/auth/owner";
import { fetchUserRuns, summarizeUserSpend, type SpendCall, type SpendGroup } from "@/lib/ai/owner-user-spend";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import styles from "../../observability.module.css";

// One account's AI spend: by request type × model, input vs output, prompt
// cache, per day, and the calls themselves. Owner-only, like ../page.tsx.

const TIME_ZONE = "Europe/Rome";
const PERIODS = [
  { key: "1", label: "Today", days: 1 },
  { key: "7", label: "7 days", days: 7 },
  { key: "30", label: "30 days", days: 30 },
  { key: "all", label: "All time", days: null },
] as const;

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
const int = new Intl.NumberFormat("en-US");

const formatUsd = (value: number | null) => (value == null ? "—" : usd.format(value));
const formatInt = (value: number | null) => (value == null ? "—" : int.format(value));
const formatPct = (value: number | null) => (value == null ? "—" : `${Math.round(value * 100)}%`);
const formatWhen = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
const shortModel = (model: string) => model.replace(/^claude-/, "").replace(/-\d{8}$/, "");

// Midnight in Rome, `days - 1` days back — "Today" is the Rome day so far.
function periodStart(days: number): string {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TIME_ZONE });
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, timeZoneName: "shortOffset" })
    .formatToParts(start)
    .find((part) => part.type === "timeZoneName")?.value; // "GMT+2"
  start.setUTCHours(start.getUTCHours() - (Number(offset?.replace("GMT", "") || 0) || 0));
  return start.toISOString();
}

function Split({ input, output }: { input: number; output: number }) {
  const total = input + output;
  if (total <= 0) return null;
  return (
    <div className={styles.split} title={`input ${formatUsd(input)} · output ${formatUsd(output)}`}>
      <span className={styles.splitInput} style={{ width: `${(input / total) * 100}%` }} />
      <span className={styles.splitOutput} style={{ width: `${(output / total) * 100}%` }} />
    </div>
  );
}

function GroupTable({ groups, showModel }: { groups: SpendGroup[]; showModel: boolean }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>{showModel ? "Request" : "Model"}</th>
            {showModel ? <th>Model</th> : null}
            <th>Calls</th>
            <th>Total</th>
            <th>Avg / call</th>
            <th>Input · Output</th>
            <th>Avg tokens in · out</th>
            <th>From cache</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.key}>
              <td>{showModel ? g.label : shortModel(g.model)}</td>
              {showModel ? <td className={styles.muted}>{shortModel(g.model)}</td> : null}
              <td>{formatInt(g.runs)}</td>
              <td>{formatUsd(g.cost)}</td>
              <td>{formatUsd(g.avg_cost)}</td>
              <td>
                {formatUsd(g.input_cost)} · {formatUsd(g.output_cost)}
                <Split input={g.input_cost} output={g.output_cost} />
              </td>
              <td className={styles.muted}>
                {formatInt(g.avg_input_tokens)} · {formatInt(g.avg_output_tokens)}
              </td>
              <td>{formatPct(g.cache_read_share)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CallTable({ calls }: { calls: SpendCall[] }) {
  if (calls.length === 0) return <div className={styles.empty}>No calls in this period.</div>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>When</th>
            <th>Request</th>
            <th>Model</th>
            <th>Cost</th>
            <th>Tokens in · out</th>
            <th>Cache read · write</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c, i) => (
            <tr key={`${c.created_at}-${i}`}>
              <td>{formatWhen(c.created_at)}</td>
              <td>
                {c.label}
                <br />
                <span className={c.status === "success" ? styles.muted : styles.failed}>
                  {c.prompt_version}
                  {c.status !== "success" ? ` · ${c.status}${c.error_text ? `: ${c.error_text.slice(0, 80)}` : ""}` : ""}
                </span>
              </td>
              <td className={styles.muted}>{shortModel(c.model)}</td>
              <td>{formatUsd(c.cost)}</td>
              <td className={styles.muted}>
                {formatInt(c.input_tokens)} · {formatInt(c.output_tokens)}
              </td>
              <td className={styles.muted}>
                {formatInt(c.cache_read_tokens)} · {formatInt(c.cache_write_tokens)}
              </td>
              <td className={styles.muted}>{c.latency_ms == null ? "—" : `${(c.latency_ms / 1000).toFixed(1)} s`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function OwnerUserSpendPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return <main className={styles.page}>Server configuration error.</main>;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  // Fail closed, as on the all-users page: non-owners get a 404.
  if (!isOwnerEmail(user.email)) notFound();

  const { userId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(userId)) notFound();
  const { period: periodKey } = await searchParams;
  const period = PERIODS.find((p) => p.key === periodKey) ?? PERIODS[2];

  const admin = getSupabaseAdminClient();
  if (!admin) return <main className={styles.page}>Service-role key missing.</main>;

  const [{ data: account }, rows] = await Promise.all([
    admin.auth.admin.getUserById(userId),
    fetchUserRuns(admin, userId, period.days ? periodStart(period.days) : null),
  ]);
  const s = summarizeUserSpend(rows, { timeZone: TIME_ZONE });
  const cacheShare = s.cache_reported_input_tokens > 0 ? s.cache_read_tokens / s.cache_reported_input_tokens : null;

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <section className={styles.hero}>
          <p className={styles.eyebrow}>Owner · one account</p>
          <div className={styles.titleRow}>
            <div>
              <h1 className={styles.title}>{account?.user?.email ?? "Unknown account"}</h1>
              <p className={styles.subtitle}>
                Every logged AI call of this account (<code>ai_runs</code>), priced as billed. Days are
                Rome days. <Link href="/app/observability/users">← All accounts</Link>
              </p>
              <nav className={styles.periodNav}>
                {PERIODS.map((p) => (
                  <Link
                    key={p.key}
                    href={`/app/observability/users/${userId}?period=${p.key}`}
                    className={`${styles.pill} ${p.key === period.key ? styles.pillActive : ""}`}
                  >
                    {p.label}
                  </Link>
                ))}
              </nav>
            </div>
            <div className={styles.windowBadge}>
              {period.label}
              <br />
              {formatInt(s.runs)} calls
            </div>
          </div>
        </section>

        <section className={styles.grid}>
          <article className={styles.card}>
            <p className={styles.label}>Spent</p>
            <p className={styles.metric}>{formatUsd(s.cost)}</p>
            <p className={styles.hint}>
              {formatInt(s.runs)} calls{s.failed ? `, ${formatInt(s.failed)} failed` : ""}.
            </p>
          </article>
          <article className={styles.card}>
            <p className={styles.label}>Per active day</p>
            <p className={styles.metric}>{formatUsd(s.per_active_day)}</p>
            <p className={styles.hint}>
              {formatInt(s.active_days)} active days · {formatUsd(s.projected_30d)} if every day of a month were like these.
            </p>
          </article>
          <article className={styles.card}>
            <p className={styles.label}>Input · Output</p>
            <p className={styles.metric}>
              {formatUsd(s.input_cost)} · {formatUsd(s.output_cost)}
            </p>
            <Split input={s.input_cost} output={s.output_cost} />
            <p className={styles.hint}>What we sent the models (incl. cache) vs what they wrote back.</p>
          </article>
          <article className={styles.card}>
            <p className={styles.label}>Prompt cache</p>
            <p className={styles.metric}>{formatPct(cacheShare)}</p>
            <p className={styles.hint}>
              of input tokens read from the cache (0.1× price) · {formatInt(s.cache_write_tokens)} written. Logged
              since 6 Oct 2026; older calls show —.
            </p>
          </article>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>By request</h2>
              <p className={styles.sectionCopy}>What each kind of call cost, on which model. Most expensive first.</p>
            </div>
          </div>
          {s.by_operation.length ? (
            <GroupTable groups={s.by_operation} showModel />
          ) : (
            <div className={styles.empty}>No calls in this period.</div>
          )}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>By model</h2>
            </div>
          </div>
          {s.by_model.length ? <GroupTable groups={s.by_model} showModel={false} /> : null}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>By day</h2>
            </div>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Total</th>
                  <th>Calls</th>
                  <th>Biggest</th>
                </tr>
              </thead>
              <tbody>
                {s.by_day.map((d) => (
                  <tr key={d.day}>
                    <td>{d.day}</td>
                    <td>{formatUsd(d.cost)}</td>
                    <td>{formatInt(d.runs)}</td>
                    <td className={styles.muted}>{d.top.map((t) => `${t.label} ${formatUsd(t.cost)}`).join(" · ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>Most expensive calls</h2>
            </div>
          </div>
          <CallTable calls={s.most_expensive} />
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>Recent calls</h2>
              <p className={styles.sectionCopy}>The last 50, newest first. Embeddings are left out — see By request.</p>
            </div>
          </div>
          <CallTable calls={s.recent} />
        </section>
      </div>
    </main>
  );
}
