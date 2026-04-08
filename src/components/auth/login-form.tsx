"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import styles from "@/components/auth/auth-experience.module.css";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export function LoginForm() {
  const router = useRouter();
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [authMode, setAuthMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const isSignUp = authMode === "sign-up";

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

    if (isSignUp && trimmedPassword !== confirmPassword.trim()) {
      setErrorMessage("Passwords do not match.");
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    setStatusMessage(null);

    const authResult = isSignUp
      ? await supabase.auth.signUp({
          email: trimmedEmail,
          password: trimmedPassword,
        })
      : await supabase.auth.signInWithPassword({
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
      isSignUp
        ? "Account created. Confirm your email only if confirmation is enabled in Supabase."
        : "Signed in successfully.",
    );
    setLoading(false);
  };

  return (
    <div className={styles.formShell}>
      <div className={styles.modeToggle}>
        <button
          className={`${styles.modeButton} ${authMode === "sign-in" ? styles.modeButtonActive : ""}`}
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
          className={`${styles.modeButton} ${authMode === "sign-up" ? styles.modeButtonActive : ""}`}
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

      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span className={styles.label}>Email</span>
            <span className={styles.inputWrap}>
              <input
                autoComplete="email"
                className={styles.input}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                type="email"
                value={email}
              />
            </span>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Password</span>
            <span className={styles.inputWrap}>
              <input
                autoComplete={isSignUp ? "new-password" : "current-password"}
                className={styles.input}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="At least 8 characters"
                type="password"
                value={password}
              />
            </span>
          </label>

          {isSignUp ? (
            <label className={styles.field}>
              <span className={styles.label}>Confirm password</span>
              <span className={styles.inputWrap}>
                <input
                  autoComplete="new-password"
                  className={styles.input}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="Repeat your password"
                  type="password"
                  value={confirmPassword}
                />
              </span>
            </label>
          ) : null}
        </div>

        {statusMessage ? <p className={styles.status}>{statusMessage}</p> : null}
        {errorMessage ? <p className={styles.error}>{errorMessage}</p> : null}

        <div className={styles.submitRow}>
          <button className={styles.submitButton} disabled={loading} type="submit">
            {loading
              ? isSignUp
                ? "Creating account..."
                : "Signing in..."
              : isSignUp
                ? "Create account"
                : "Sign in"}
          </button>
        </div>

        <p className={styles.helperLine}>
          {isSignUp
            ? "Start with a lightweight General workspace."
            : "Use your workspace account."}
        </p>
      </form>
    </div>
  );
}
