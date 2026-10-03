import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const exchangeCodeForSession = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: async () => ({ auth: { exchangeCodeForSession } }),
}));

import { GET } from "./route";

const ORIGIN = "http://localhost:3033";
const call = (query: string) => GET(new Request(`${ORIGIN}/auth/callback${query}`));
const location = (res: Response) => res.headers.get("location");

describe("GET /auth/callback", () => {
  const savedAllowlist = process.env.ALLOWED_EMAILS;

  beforeEach(() => {
    exchangeCodeForSession.mockReset();
    delete process.env.ALLOWED_EMAILS;
  });
  afterEach(() => {
    if (savedAllowlist === undefined) delete process.env.ALLOWED_EMAILS;
    else process.env.ALLOWED_EMAILS = savedAllowlist;
  });

  it("exchanges the code and goes to the app", async () => {
    exchangeCodeForSession.mockResolvedValue({ data: { user: { email: "a@b.com" } }, error: null });
    const res = await call("?code=abc");
    expect(exchangeCodeForSession).toHaveBeenCalledWith("abc");
    expect(res.status).toBe(307);
    expect(location(res)).toBe(`${ORIGIN}/app`);
  });

  it("honours a same-origin next, refuses an open redirect", async () => {
    exchangeCodeForSession.mockResolvedValue({ data: { user: { email: "a@b.com" } }, error: null });
    expect(location(await call("?code=abc&next=/n/xyz"))).toBe(`${ORIGIN}/n/xyz`);
    expect(location(await call("?code=abc&next=//evil.com"))).toBe(`${ORIGIN}/app`);
    expect(location(await call("?code=abc&next=https://evil.com"))).toBe(`${ORIGIN}/app`);
  });

  it("applies the invite allowlist like a password sign-in", async () => {
    process.env.ALLOWED_EMAILS = "invited@b.com, Other@B.com";
    exchangeCodeForSession.mockResolvedValue({ data: { user: { email: "stranger@b.com" } }, error: null });
    expect(location(await call("?code=abc"))).toBe(`${ORIGIN}/login?denied=1`);

    exchangeCodeForSession.mockResolvedValue({ data: { user: { email: "other@b.com" } }, error: null });
    expect(location(await call("?code=abc"))).toBe(`${ORIGIN}/app`);

    // Apple "Hide my email" gives a relay address — not on the list.
    exchangeCodeForSession.mockResolvedValue({ data: { user: { email: null } }, error: null });
    expect(location(await call("?code=abc"))).toBe(`${ORIGIN}/login?denied=1`);
  });

  it("sends provider errors and a missing code back to /login", async () => {
    expect(location(await call("?error=access_denied"))).toBe(
      `${ORIGIN}/login?error=${encodeURIComponent("Sign-in was cancelled.")}`,
    );
    expect(location(await call("?error=server_error&error_description=Unsupported%20provider"))).toBe(
      `${ORIGIN}/login?error=${encodeURIComponent("Unsupported provider")}`,
    );
    expect(location(await call(""))).toContain("/login?error=");
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("redirects to the host the browser used, not the dev server's bind address", async () => {
    exchangeCodeForSession.mockResolvedValue({ data: { user: { email: "a@b.com" } }, error: null });
    const req = (headers: Record<string, string>) =>
      GET(new Request("http://0.0.0.0:3002/auth/callback?code=abc", { headers }));
    expect(location(await req({ host: "localhost:3002" }))).toBe("http://localhost:3002/app");
    expect(
      location(await req({ host: "internal", "x-forwarded-host": "www.thebraindump.app", "x-forwarded-proto": "https" })),
    ).toBe("https://www.thebraindump.app/app");
  });

  it("reports a failed exchange", async () => {
    exchangeCodeForSession.mockResolvedValue({ data: { user: null }, error: { message: "Code expired" } });
    expect(location(await call("?code=old"))).toBe(`${ORIGIN}/login?error=${encodeURIComponent("Code expired")}`);
  });
});
