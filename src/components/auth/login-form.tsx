"use client";

import { useMemo, useRef, useState } from "react";
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
  const [pendingConfirmEmail, setPendingConfirmEmail] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [resendSent, setResendSent] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  // Synchronous in-flight guard: `resending` is async state, so two clicks in
  // the same tick can both clear the disabled guard before React re-renders.
  const resendInFlightRef = useRef(false);

  const isSignUp = authMode === "sign-up";

  const handleResend = async () => {
    if (!supabase || !pendingConfirmEmail || resendInFlightRef.current) {
      return;
    }
    resendInFlightRef.current = true;

    setResending(true);
    setResendError(null);
    setResendSent(false);

    const { error } = await supabase.auth.resend({
      type: "signup",
      email: pendingConfirmEmail,
    });

    resendInFlightRef.current = false;

    if (error) {
      setResendError(error.message);
      setResending(false);
      return;
    }

    setResendSent(true);
    setResending(false);
  };

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
    setPendingConfirmEmail(null);
    setResendSent(false);
    setResendError(null);

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

    if (isSignUp) {
      setPendingConfirmEmail(trimmedEmail);
    } else {
      setStatusMessage("Signed in successfully.");
    }
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
            setPendingConfirmEmail(null);
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
            setPendingConfirmEmail(null);
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

        {pendingConfirmEmail ? (
          <div className={styles.confirmNotice}>
            <p className={styles.status}>
              Account created — check your inbox to confirm your email, then sign in.
            </p>
            <button
              className={styles.resendButton}
              disabled={resending}
              onClick={handleResend}
              type="button"
            >
              {resending ? "Resending..." : "Resend confirmation email"}
            </button>
            {resendSent ? (
              <p className={styles.resendStatus}>Confirmation email sent.</p>
            ) : null}
            {resendError ? <p className={styles.error}>{resendError}</p> : null}
          </div>
        ) : null}

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
