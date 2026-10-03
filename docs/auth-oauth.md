# Google / Apple sign-in — setup

The code is in place: Supabase OAuth with PKCE (`signInWithOAuth` in
`src/components/auth/login-form.tsx`), the return route `src/app/auth/callback/route.ts`
(exchanges the code, applies the invite allowlist), and the flags in `src/lib/auth/oauth.ts`.
Each button is **hidden until its flag is on**, so prod never shows a button whose provider
isn't configured.

As of 2026-10-03 the hosted Supabase project has **only email** enabled (`/auth/v1/settings`
→ `external.google: false`, `external.apple: false`). The Google button that used to show
on the login page therefore led to "Unsupported provider" — it is hidden now until step 4.

## How it works

1. The button calls `supabase.auth.signInWithOAuth({ provider, options: { redirectTo:
   "<origin>/auth/callback" } })`. The browser goes to Supabase → Google/Apple → Supabase
   (`https://<project-ref>.supabase.co/auth/v1/callback`) → back to `<origin>/auth/callback?code=…`.
2. `/auth/callback` exchanges the code for a session (cookies), then:
   - email on `ALLOWED_EMAILS` (or the list is empty) → `/app` (or a same-origin `?next=`);
   - email not on the list → `/login?denied=1` ("This account isn't on the access list yet")
     — exactly what a password sign-in gets from the middleware; the session is kept.
   - provider error / cancelled / bad code → `/login?error=…`, shown under the form.
3. The first OAuth sign-in creates the Supabase user, like a sign-up. The intake and the
   workspace wizard run as for any new account.

## 1 · Google

1. [Google Cloud Console](https://console.cloud.google.com/) → pick or create a project.
2. **Google Auth Platform → Branding** (OAuth consent screen): app name "BrainDump", support
   email, logo, home page `https://www.thebraindump.app`, privacy
   `https://www.thebraindump.app/privacy`, terms `https://www.thebraindump.app/terms`,
   authorized domain `thebraindump.app`. Brand verification can take a few business days;
   until then Google shows the project id on the consent screen.
3. **Audience**: External. While it is "Testing", only listed test users can sign in —
   publish it to let anyone in (the invite allowlist still gates the app).
4. **Data Access (scopes)**: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`.
5. **Clients → Create client → Web application**:
   - Authorized JavaScript origins: `https://www.thebraindump.app`, `http://localhost:3002`
   - Authorized redirect URIs: `https://<project-ref>.supabase.co/auth/v1/callback`
     (Supabase's callback, not the app's — the dashboard shows it on the Google provider page)
6. Copy the **Client ID** and **Client secret**.

## 2 · Apple (needs the paid Apple Developer Program, $99/year)

1. [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list)
   → **Identifiers → App IDs → +**: e.g. `app.thebraindump`, capability **Sign in with Apple**
   on. Leave the server-to-server notification endpoint blank (Supabase doesn't use it).
2. **Identifiers → Services IDs → +**: e.g. `app.thebraindump.web`, enable **Sign in with
   Apple → Configure**:
   - Primary App ID: the App ID above
   - Domains and Subdomains: `<project-ref>.supabase.co`
   - Return URLs: `https://<project-ref>.supabase.co/auth/v1/callback`
3. **Services → Sign in with Apple for Email Communication**: register `thebraindump.app`
   (and any sending address) so Apple's private relay forwards mail to users who hide
   their email.
4. **Keys → +**: enable **Sign in with Apple**, pick the App ID, download the `.p8` file
   (one download only — keep it somewhere safe). Note the **Key ID** and your **Team ID**
   (top right of the developer site).
5. Generate the **client secret** (a JWT signed with the `.p8`): Supabase's Apple guide has a
   generator; it needs Team ID, Key ID, Services ID and the `.p8`. **It expires after at
   most 6 months** — put a calendar reminder to make a new one and paste it into Supabase,
   or Apple sign-in stops working.

Apple caveats:
- Apple sends the user's name **only on the first sign-in**; we don't store it today (the
  "About you" intake asks for a name anyway).
- A user who picks **Hide My Email** signs in as `…@privaterelay.appleid.com`. That address
  won't be on `ALLOWED_EMAILS`, so while the app is invite-only such a user lands on "not on
  the access list". Add the relay address to the list, or ask invitees to share their email.

## 3 · Supabase dashboard

1. **Authentication → Sign In / Providers**:
   - **Google**: enable, paste Client ID + Client secret. Leave "Skip nonce checks" off.
   - **Apple**: enable, **Client IDs** = the Services ID (first in the list if a native app
     is ever added), **Secret Key** = the JWT from Apple step 5.
2. **Authentication → URL Configuration**:
   - Site URL: `https://www.thebraindump.app`
   - Redirect URLs (add all that apply):
     - `https://www.thebraindump.app/auth/callback`
     - `http://localhost:3002/auth/callback` (local dev; add other ports you use)
     - previews, if wanted: `https://*-<vercel-team>.vercel.app/auth/callback`
   A `redirectTo` that isn't on this list makes Supabase fall back to the Site URL.
3. Account linking needs no setting: Supabase links a Google/Apple identity to an existing
   user with the same **verified** email automatically, so a Google sign-in with the email
   of an existing password account opens that same account and graph.

## 4 · Vercel env (Production, and Preview if wanted)

| Variable | Value | Effect |
|---|---|---|
| `NEXT_PUBLIC_AUTH_GOOGLE` | `true` | shows "Continue with Google" |
| `NEXT_PUBLIC_AUTH_APPLE` | `true` | shows "Continue with Apple" |

They're read at **build time** (`NEXT_PUBLIC_*`), so redeploy after setting them. Set a flag
only after the provider is enabled in step 3. Locally, put them in `.env.local` and restart
`npm run dev`.

## 5 · Check it

1. Open `/login` in a private window: the buttons you enabled show above "or".
2. Click one, sign in → you land in `/app`.
3. With `ALLOWED_EMAILS` set, sign in with a Google account that isn't on it → `/login` with
   "This account isn't on the access list yet".
4. Cancel on the Google/Apple screen → `/login` with "Sign-in was cancelled."

Tests without real credentials: `src/app/auth/callback/route.test.ts` (code exchange, allowlist,
open-redirect guard, provider errors) and `src/lib/auth/oauth.test.ts` (flags, redirect URL).
