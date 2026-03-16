"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export function LoginForm() {
  const router = useRouter();
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [authMode, setAuthMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmedEmail = email.trim();
    const trimmedPassword = password.trim();

    if (!supabase) {
      setErrorMessage("Supabase auth is not configured.");
      return;
    }

    if (!trimmedEmail) {
      setErrorMessage("Enter an email address.");
      return;
    }

    if (trimmedPassword.length < 8) {
      setErrorMessage("Password must be at least 8 characters.");
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    setStatusMessage(null);

    const authResult =
      authMode === "sign-in"
        ? await supabase.auth.signInWithPassword({
            email: trimmedEmail,
            password: trimmedPassword,
          })
        : await supabase.auth.signUp({
            email: trimmedEmail,
            password: trimmedPassword,
          });

    const { data, error } = authResult;

    if (error) {
      setErrorMessage(error.message);
      setLoading(false);
      return;
    }

    if (data.session) {
      router.replace("/app");
      router.refresh();
      return;
    }

    setStatusMessage(
      authMode === "sign-up"
        ? "Account created. If email confirmation is enabled, confirm your email before signing in."
        : "Signed in successfully.",
    );
    setLoading(false);
  };

  return (
    <form className="mt-8 space-y-4" onSubmit={handleSubmit}>
      <div className="grid grid-cols-2 gap-2 rounded-[14px] border border-[color:var(--color-border-faint)] bg-[rgba(255,255,255,0.015)] p-1">
        <button
          className={`rounded-[10px] px-3 py-2 text-[13px] font-medium transition-colors duration-150 ease-out ${
            authMode === "sign-in"
              ? "bg-[rgba(255,255,255,0.06)] text-[var(--color-text-primary)]"
              : "text-[var(--color-text-secondary)]"
          }`}
          onClick={() => {
            setAuthMode("sign-in");
            setErrorMessage(null);
            setStatusMessage(null);
          }}
          type="button"
        >
          Sign in
        </button>
        <button
          className={`rounded-[10px] px-3 py-2 text-[13px] font-medium transition-colors duration-150 ease-out ${
            authMode === "sign-up"
              ? "bg-[rgba(255,255,255,0.06)] text-[var(--color-text-primary)]"
              : "text-[var(--color-text-secondary)]"
          }`}
          onClick={() => {
            setAuthMode("sign-up");
            setErrorMessage(null);
            setStatusMessage(null);
          }}
          type="button"
        >
          Create account
        </button>
      </div>

      <label className="block">
        <span className="mb-2 block text-[12px] font-medium tracking-[-0.01em] text-[var(--color-text-secondary)]">
          Email
        </span>
        <input
          autoComplete="email"
          className="h-12 w-full rounded-[12px] border border-[color:var(--color-border-faint)] bg-[var(--color-bg-surface-elevated)] px-4 text-[14px] text-[var(--color-text-primary)] outline-none transition-[border-color,box-shadow] duration-150 ease-out placeholder:text-[var(--color-text-muted)] focus:border-[rgba(213,58,71,0.24)] focus:shadow-[var(--shadow-focus)]"
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          type="email"
          value={email}
        />
      </label>

      <label className="block">
        <span className="mb-2 block text-[12px] font-medium tracking-[-0.01em] text-[var(--color-text-secondary)]">
          Password
        </span>
        <input
          autoComplete={authMode === "sign-in" ? "current-password" : "new-password"}
          className="h-12 w-full rounded-[12px] border border-[color:var(--color-border-faint)] bg-[var(--color-bg-surface-elevated)] px-4 text-[14px] text-[var(--color-text-primary)] outline-none transition-[border-color,box-shadow] duration-150 ease-out placeholder:text-[var(--color-text-muted)] focus:border-[rgba(213,58,71,0.24)] focus:shadow-[var(--shadow-focus)]"
          onChange={(event) => setPassword(event.target.value)}
          placeholder="At least 8 characters"
          type="password"
          value={password}
        />
      </label>

      {statusMessage ? (
        <p className="rounded-[12px] border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.02)] px-4 py-3 text-[13px] leading-5 text-[var(--color-text-secondary)]">
          {statusMessage}
        </p>
      ) : null}

      {errorMessage ? (
        <p className="rounded-[12px] border border-[rgba(213,58,71,0.16)] bg-[rgba(213,58,71,0.07)] px-4 py-3 text-[13px] leading-5 text-[var(--color-text-secondary)]">
          {errorMessage}
        </p>
      ) : null}

      <button
        className="shell-button shell-button-primary inline-flex h-12 w-full items-center justify-center px-4 text-[14px] font-medium"
        disabled={loading}
        type="submit"
      >
        {loading
          ? authMode === "sign-in"
            ? "Signing in..."
            : "Creating account..."
          : authMode === "sign-in"
            ? "Sign in"
            : "Create account"}
      </button>
    </form>
  );
}
