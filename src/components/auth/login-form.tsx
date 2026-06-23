"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import styles from "@/components/auth/auth-experience.module.css";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type OAuthProvider = "google";

function GoogleIcon() {
  return (
    <svg aria-hidden="true" height="18" viewBox="0 0 24 24" width="18">
      <path
        d="M21.6 12.227c0-.66-.06-1.293-.17-1.9H12v3.595h5.38a4.6 4.6 0 0 1-1.995 3.018v2.51h3.23c1.89-1.74 2.985-4.305 2.985-7.223Z"
        fill="currentColor"
        opacity="0.95"
      />
      <path
        d="M12 22c2.7 0 4.965-.895 6.62-2.42l-3.23-2.51c-.895.6-2.04.955-3.39.955-2.605 0-4.81-1.76-5.6-4.125H2.965v2.59A9.997 9.997 0 0 0 12 22Z"
        fill="currentColor"
        opacity="0.72"
      />
      <path
        d="M6.4 13.9A6.01 6.01 0 0 1 6.08 12c0-.66.115-1.3.32-1.9V7.51H2.965A9.997 9.997 0 0 0 2 12c0 1.615.385 3.14 1.065 4.49L6.4 13.9Z"
        fill="currentColor"
        opacity="0.5"
      />
      <path
        d="M12 5.975c1.47 0 2.785.505 3.82 1.495l2.865-2.865C16.96 2.99 14.695 2 12 2A9.997 9.997 0 0 0 2.965 7.51L6.4 10.1C7.19 7.735 9.395 5.975 12 5.975Z"
        fill="currentColor"
        opacity="0.85"
      />
    </svg>
  );
}

// Adding a provider later (Apple, GitHub, Microsoft, …) is a one-line addition
// here, once it's enabled in the Supabase dashboard. Add the matching id to the
// OAuthProvider union above. Apple/Microsoft are omitted for now (heavier config:
// Apple needs a paid developer account).
const OAUTH_PROVIDERS: ReadonlyArray<{
  id: OAuthProvider;
  label: string;
  icon: React.ReactNode;
}> = [
  { id: "google", label: "Continue with Google", icon: <GoogleIcon /> },
];

export function LoginForm() {
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();
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
  // Which OAuth provider has a redirect in flight (disables that one button).
  const [oauthPending, setOauthPending] = useState<OAuthProvider | null>(null);
  // Synchronous in-flight guard: `resending` is async state, so two clicks in
  // the same tick can both clear the disabled guard before React re-renders.
  const resendInFlightRef = useRef(false);

  // A failed/cancelled OAuth bounces to /login?error=... — surface it (the
  // callback redirects server-side, so this form mounts fresh with the param).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const err = params.get("error");
    if (err) {
      setErrorMessage(err);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const isSignUp = authMode === "sign-up";

  const handleOAuth = async (provider: OAuthProvider) => {
    if (!supabase || oauthPending) {
      if (!supabase) {
        setErrorMessage("Supabase auth is not configured.");
      }
      return;
    }

    setOauthPending(provider);
    setErrorMessage(null);
    setStatusMessage(null);

    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });

    // On success the browser is redirected away, so this only runs on failure.
    if (error) {
      setErrorMessage(error.message);
      setOauthPending(null);
    }
  };

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

      <div className={styles.oauthRow}>
        {OAUTH_PROVIDERS.map((provider) => (
          <button
            className={styles.oauthButton}
            disabled={oauthPending !== null}
            key={provider.id}
            onClick={() => handleOAuth(provider.id)}
            type="button"
          >
            <span className={styles.oauthIcon}>{provider.icon}</span>
            <span>
              {oauthPending === provider.id ? "Redirecting..." : provider.label}
            </span>
          </button>
        ))}
      </div>

      <div className={styles.orDivider}>
        <span>or</span>
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
