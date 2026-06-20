import { describe, it, expect } from "vitest";

import { classifyTaskSize } from "./sizing";

describe("classifyTaskSize", () => {
  it("treats a short concrete action as a task", () => {
    expect(classifyTaskSize("call mom")).toBe("task");
  });

  it("treats a 3-word action-led title as a task", () => {
    expect(classifyTaskSize("fix login bug")).toBe("task");
  });

  it("treats a single token as a task", () => {
    expect(classifyTaskSize("thread_create")).toBe("task");
  });

  it("treats a lone leader verb as a task, not a project", () => {
    // A one-word title has nothing to scope a project around; the single-token
    // guard must win over the project-verb check.
    expect(classifyTaskSize("Build")).toBe("task");
    expect(classifyTaskSize("Learn")).toBe("task");
  });

  it("treats a leading project verb as a project even when short", () => {
    expect(classifyTaskSize("learn italian")).toBe("project");
  });

  it("treats a build-style title as a project", () => {
    expect(classifyTaskSize("build authentication system")).toBe("project");
  });

  it("defers a vague multi-word title to the classifier", () => {
    expect(classifyTaskSize("plan q3 roadmap")).toBe("ambiguous");
  });

  it("is safe on empty input", () => {
    expect(classifyTaskSize("")).toBe("task");
  });

  // --- regression: project verbs used as NOUNS must not promote ---
  // These were misclassified as 'project' when the verb was matched anywhere
  // in the title rather than only in lead position.
  it("does not promote a noun-sense 'design'", () => {
    expect(classifyTaskSize("review the design doc")).toBe("ambiguous");
  });

  it("does not promote a noun-sense 'build'", () => {
    expect(classifyTaskSize("fix the build script")).toBe("ambiguous");
  });

  it("does not auto-promote ambiguous leaders like 'create'", () => {
    expect(classifyTaskSize("create account on stripe")).toBe("ambiguous");
  });

  // --- boundary: the <=3-word action rule. One word over → escalate. ---
  it("escalates an action-led title just past the short boundary", () => {
    expect(classifyTaskSize("fix the login bug")).toBe("ambiguous");
  });

  // A two-imperative compound is no longer force-classified; it escalates to
  // the classifier rather than guessing 'project' (some are one sitting).
  it("escalates a compound title instead of guessing", () => {
    expect(classifyTaskSize("write the rfc and ship the migration")).toBe(
      "ambiguous",
    );
  });
});
