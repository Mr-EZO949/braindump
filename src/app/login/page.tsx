import { redirect } from "next/navigation";

import styles from "@/components/auth/auth-experience.module.css";
import { AuthGraphScene } from "@/components/auth/auth-graph-scene";
import { LoginForm } from "@/components/auth/login-form";
import { ProductMark } from "@/components/ui/icons";
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
              <span className={styles.brandMark}>
                <ProductMark className="h-[18px] w-[18px]" />
              </span>
              <span className={styles.brandText}>
                <span className={styles.brandName}>BrainDump</span>
                <span className={styles.brandMeta}>Private workspace</span>
              </span>
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
