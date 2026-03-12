import Link from "next/link";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-bg-base)] px-6 text-[var(--color-text-primary)]">
      <div className="w-full max-w-sm rounded-[18px] border border-[color:var(--color-border-faint)] bg-[var(--color-bg-surface)] p-8">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
          Login
        </p>
        <h1 className="mt-4 text-[24px] font-semibold tracking-[-0.04em]">
          Public auth route
        </h1>
        <p className="mt-3 text-[14px] leading-6 text-[var(--color-text-secondary)]">
          Auth wiring comes later. This route exists so gating can be added cleanly.
        </p>

        <Link
          className="mt-8 inline-flex h-11 items-center justify-center rounded-[12px] bg-[var(--color-bg-surface-elevated)] px-4 text-[14px] font-medium text-[var(--color-text-primary)]"
          href="/app"
        >
          Continue to app
        </Link>
      </div>
    </main>
  );
}
