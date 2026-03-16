import { redirect } from "next/navigation";

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
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-bg-base)] px-6 text-[var(--color-text-primary)]">
      <div className="w-full max-w-sm rounded-[18px] border border-[color:var(--color-border-faint)] bg-[var(--color-bg-surface)] p-8 shadow-[0_22px_44px_rgba(0,0,0,0.28)]">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
          Login
        </p>
        <h1 className="mt-4 text-[24px] font-semibold tracking-[-0.04em]">
          Sign in with email
        </h1>
        <p className="mt-3 text-[14px] leading-6 text-[var(--color-text-secondary)]">
          Use email and password to sign in or create an account.
        </p>

        <LoginForm />
      </div>
    </main>
  );
}
