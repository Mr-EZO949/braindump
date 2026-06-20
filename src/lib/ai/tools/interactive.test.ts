import { describe, it, expect } from "vitest";

import { resolveChoice } from "./interactive";

describe("resolveChoice", () => {
  it("accepts a pick that is one of the offered options", () => {
    expect(resolveChoice(["A", "B"], "A")).toEqual({ ok: true, chosen: "A" });
  });

  it("rejects a pick that was not offered", () => {
    expect(resolveChoice(["A", "B"], "C")).toEqual({ ok: false });
  });

  it("rejects a missing pick", () => {
    expect(resolveChoice(["A", "B"], undefined)).toEqual({ ok: false });
  });

  it("accepts a legitimately-offered empty-string option (no falsy trap)", () => {
    expect(resolveChoice(["", "B"], "")).toEqual({ ok: true, chosen: "" });
  });

  it("rejects when options is a string (no substring matching)", () => {
    // Without the Array.isArray guard, "Full" would substring-match the string.
    expect(resolveChoice("Quick fix or Full rewrite", "Full")).toEqual({ ok: false });
  });

  it("rejects a non-string pick", () => {
    expect(resolveChoice(["A", "B"], 1)).toEqual({ ok: false });
  });
});
