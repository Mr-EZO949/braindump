import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";

import styles from "@/components/auth/auth-experience.module.css";
import { AuthGraphScene } from "@/components/auth/auth-graph-scene";
import { LoginForm } from "@/components/auth/login-form";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export default async function LoginPage() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = supabase ? await supabase.auth.getUser() : { data: { user: null } };

  if (user) {
    redirect("/app");
  }

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
            </div>

            <LoginForm />
          </div>
        </section>
        <div className={styles.authSpacer} aria-hidden />
      </div>
    </main>
  );
}
