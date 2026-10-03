import { describe, expect, it } from "vitest";

import { enabledOAuthProviders, oauthRedirectUrl, safeNextPath } from "./oauth";

describe("enabledOAuthProviders", () => {
  it("shows nothing unless a flag is exactly true", () => {
    expect(enabledOAuthProviders({})).toEqual([]);
    expect(enabledOAuthProviders({ google: "1", apple: "yes" })).toEqual([]);
    expect(enabledOAuthProviders({ google: "false", apple: "" })).toEqual([]);
  });

  it("shows each provider on its own flag, Google first", () => {
    expect(enabledOAuthProviders({ google: "true" })).toEqual(["google"]);
    expect(enabledOAuthProviders({ apple: "TRUE " })).toEqual(["apple"]);
    expect(enabledOAuthProviders({ apple: "true", google: "true" })).toEqual(["google", "apple"]);
  });
});

describe("oauthRedirectUrl", () => {
  it("returns to /auth/callback on the same origin", () => {
    expect(oauthRedirectUrl("http://localhost:3033")).toBe("http://localhost:3033/auth/callback");
    expect(oauthRedirectUrl("https://braindump.app")).toBe("https://braindump.app/auth/callback");
  });
});

describe("safeNextPath", () => {
  it("keeps same-origin paths", () => {
    expect(safeNextPath("/app")).toBe("/app");
    expect(safeNextPath("/n/abc?x=1")).toBe("/n/abc?x=1");
  });

  it("refuses anything that could leave the site", () => {
    expect(safeNextPath(null)).toBe("/app");
    expect(safeNextPath("")).toBe("/app");
    expect(safeNextPath("https://evil.com")).toBe("/app");
    expect(safeNextPath("//evil.com")).toBe("/app");
    expect(safeNextPath("/\\evil.com")).toBe("/app");
  });
});
