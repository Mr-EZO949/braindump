import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";

import styles from "@/components/auth/auth-experience.module.css";
import { AuthGraphScene } from "@/components/auth/auth-graph-scene";
import { LoginForm } from "@/components/auth/login-form";
import { isEmailAllowed } from "@/lib/auth/allowlist";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string; error?: string | string[] }>;
}) {
  const { denied, error } = await searchParams;
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = supabase ? await supabase.auth.getUser() : { data: { user: null } };

  // Only forward to the app if this account is actually on the invite list —
  // otherwise a denied-but-signed-in user would ping-pong /app <-> /login.
  if (user && isEmailAllowed(user.email)) {
    redirect("/app");
  }

  const showDenied = denied === "1" || (!!user && !isEmailAllowed(user.email));

  return (
    <main className={styles.page}>
      <AuthGraphScene />
      <div className={styles.shell}>
        <section className={styles.authColumn}>
          <div className={styles.authInner}>
            <div className={styles.brandRow}>
              <Link href="/" aria-label="BrainDump — back to home">
                <Image src="/logo_withtext.svg" alt="BrainDump" width={170} height={34} className={styles.brandLogoImg} />
              </Link>
            </div>

            <div className={styles.authHeader}>
              <h1 className={styles.heading}>Access workspace.</h1>
              <p className={styles.supporting}>
                Sign in or create an account to enter your graph.
              </p>
              {showDenied ? (
                <p
                  role="status"
                  style={{
                    marginTop: 12,
                    padding: "10px 12px",
                    borderRadius: 10,
                    fontSize: 14,
                    lineHeight: 1.4,
                    color: "#ec5d68",
                    background: "rgba(213, 58, 71, 0.08)",
                    border: "1px solid rgba(213, 58, 71, 0.25)",
                  }}
                >
                  This account isn&apos;t on the access list yet. BrainDump is
                  invite-only right now.
                </p>
              ) : null}
            </div>

            <LoginForm initialError={typeof error === "string" && error ? error.slice(0, 300) : null} />
          </div>
        </section>
        <div className={styles.authSpacer} aria-hidden />
      </div>
    </main>
  );
}
