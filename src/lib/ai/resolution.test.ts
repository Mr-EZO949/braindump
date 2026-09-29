import { describe, expect, it } from "vitest";
import { findIntraDumpDuplicates, judgeSameItem, titleTokens } from "./resolution";

// Every case below is a REAL pair from the live database (2026-09-28 study of
// 9,746 node pairs) with its real cosine similarity. The point of the rule is
// that similarity alone gets these wrong — note the non-duplicates scoring
// HIGHER than the true duplicates.
const task = (title: string) => ({ title, node_type: "task" });
const goal = (title: string) => ({ title, node_type: "goal" });
const project = (title: string) => ({ title, node_type: "project" });
const klass = (title: string) => ({ title, node_type: "class" });

describe("judgeSameItem — real non-duplicates that score very high", () => {
  it("two different shifts (0.954, the MOST similar pair in the DB)", () => {
    const verdict = judgeSameItem(task("TA Shift Wednesday"), task("TA Shift Thursday"), 0.954);
    expect(verdict.same).toBe(false);
    // Certain, not ambiguous — a new Thursday shift must not be held for review.
    expect(verdict.certainlyDistinct).toBe(true);
  });

  it("two different courses (0.948)", () => {
    expect(judgeSameItem(task("Pass Machine Learning"), task("Pass Deep Learning"), 0.948).same).toBe(false);
  });

  it("two different exams (0.934)", () => {
    const verdict = judgeSameItem(task("Pass DL Exam"), task("Pass ML Exam"), 0.934);
    expect(verdict.same).toBe(false);
    // Abbreviations are ambiguous in general → not certain (review, not auto).
    expect(verdict.certainlyDistinct).toBe(false);
  });

  it("a class and a task inside it (0.936)", () => {
    expect(judgeSameItem(task("Stats 302 Midterm Review"), klass("Stats 302"), 0.936).same).toBe(false);
  });

  it("two different reading tasks (0.934)", () => {
    expect(
      judgeSameItem(
        task("Read Remaining 24 Attention Papers"),
        task("Read 4 More Lit Review Papers Tonight"),
        0.934,
      ).same,
    ).toBe(false);
  });

  it("two reviews for two courses (0.908)", () => {
    expect(
      judgeSameItem(task("Review Stats 302 for Midterm"), task("Review Linear Algebra for Midterm"), 0.908).same,
    ).toBe(false);
  });

  it("a class and the project nested inside it (0.919) — certainly distinct, no review", () => {
    const verdict = judgeSameItem(
      { ...project("Build Thread Scheduler from Scratch"), parent_title: "Operating Systems Course" },
      klass("Operating Systems Course"),
      0.919,
    );
    expect(verdict.same).toBe(false);
    expect(verdict.certainlyDistinct).toBe(true);
  });
});

describe("judgeSameItem — real duplicates that score LOWER", () => {
  it("a goal wrapped inside an identical goal by one dump (0.927)", () => {
    // Real: "Maintain Interview Readiness" was created UNDER "Interview Readiness".
    const verdict = judgeSameItem(
      goal("Interview Readiness"),
      { ...goal("Maintain Interview Readiness"), parent_title: "Interview Readiness" },
      0.927,
    );
    expect(verdict.same).toBe(true);
  });

  it("the same named task under the same parent (0.892)", () => {
    const parent = "Get FAANG/quant internship offer";
    expect(
      judgeSameItem(
        { ...task("Stripe Online Assessment"), parent_title: parent },
        { ...task("Stripe Online Assessment"), parent_title: parent },
        0.892,
      ).same,
    ).toBe(true);
  });
});

describe("judgeSameItem — identity is the PATH, not the title", () => {
  it("the same kind of task under two different projects is NOT a duplicate (0.899)", () => {
    // Real pair. Title-only, this looked like "one title adds a qualifier" and
    // an early version of the rule merged them — an end-to-end replay caught it.
    // They sit under "Gym App" and "Student Tracker App".
    expect(
      judgeSameItem(
        { ...task("Choose Gym App Stack and Set Up Repo"), parent_title: "Gym App" },
        { ...task("Choose Stack and Set Up Repo"), parent_title: "Student Tracker App" },
        0.899,
      ).same,
    ).toBe(false);
  });

  it("a shared parent's words must not hide a title difference (0.885, real)", () => {
    // Real pair under "Work, Study & Hockey Lifestyle". Folding the parent's
    // words into the title made these look identical — a false merge the scan caught.
    const parent = "Work, Study & Hockey Lifestyle";
    expect(
      judgeSameItem(
        { title: "Study 5 Days Per Week", node_type: "habit", parent_title: parent },
        { title: "Work 5 Days Per Week", node_type: "habit", parent_title: parent },
        0.885,
      ).same,
    ).toBe(false);
  });

  it("a goal nested inside its own twin is still a duplicate even with a grandparent", () => {
    expect(
      judgeSameItem(
        { ...goal("Interview Readiness"), parent_title: "Career" },
        { ...goal("Maintain Interview Readiness"), parent_title: "Interview Readiness" },
        0.927,
      ).same,
    ).toBe(true);
  });

  it("attaching a top-level item under a parent doesn't make it a different item", () => {
    expect(
      judgeSameItem(
        { ...task("Stripe Online Assessment"), parent_title: "Get FAANG/quant internship offer" },
        task("Stripe Online Assessment"),
        0.9,
      ).same,
    ).toBe(true);
  });
});

describe("judgeSameItem — scope-changing extras are not duplicates", () => {
  it("a numbered instance is not the generic item", () => {
    expect(judgeSameItem(task("Complete Week 4 Long Run"), task("Complete Long Run"), 0.93).same).toBe(false);
  });

  it("a weekday-specific item is not the generic item", () => {
    expect(judgeSameItem(task("Monday Team Standup Notes"), task("Team Standup Notes"), 0.93).same).toBe(false);
  });

  it("anything below the floor is never a duplicate", () => {
    expect(judgeSameItem(goal("Interview Readiness"), goal("Maintain Interview Readiness"), 0.84).same).toBe(false);
  });
});

describe("titleTokens", () => {
  it("drops stopwords and folds plurals without mangling -ss words", () => {
    expect(titleTokens("Read the Attention Papers for Class")).toEqual(["read", "attention", "paper", "class"]);
  });
});

describe("findIntraDumpDuplicates — the same item emitted twice by ONE dump", () => {
  // Unit vectors with a controlled cosine: [cos, sin] against [1, 0].
  const at = (similarity: number) => [similarity, Math.sqrt(1 - similarity * similarity)];
  const p = (local_ref: string, proposed_title: string, proposed_node_type = "goal") => ({
    local_ref,
    proposed_title,
    proposed_node_type,
  });

  it("drops the later copy of a real intra-dump duplicate and keeps the earlier", () => {
    const dropped = findIntraDumpDuplicates(
      [p("n1", "Interview Readiness"), p("n2", "Maintain Interview Readiness")],
      [[1, 0], at(0.927)],
    );
    expect(dropped.get("n2")).toBe("n1");
    expect(dropped.has("n1")).toBe(false);
  });

  it("keeps two different instances even at very high similarity", () => {
    const dropped = findIntraDumpDuplicates(
      [p("n1", "TA Shift Wednesday", "task"), p("n2", "TA Shift Thursday", "task")],
      [[1, 0], at(0.954)],
    );
    expect(dropped.size).toBe(0);
  });

  it("chains to the surviving copy when three are the same", () => {
    const dropped = findIntraDumpDuplicates(
      [p("n1", "Interview Readiness"), p("n2", "Maintain Interview Readiness"), p("n3", "Interview Readiness")],
      [[1, 0], at(0.93), [1, 0]],
    );
    expect(dropped.get("n2")).toBe("n1");
    expect(dropped.get("n3")).toBe("n1");
  });
});

describe("judgeSameItem — big tasks (node types v2)", () => {
  const bigTask = (title: string) => ({ title, node_type: "big_task" });

  it("matches an old task retyped as a big task", () => {
    expect(judgeSameItem(task("Pass ML Exam"), bigTask("Pass ML Exam"), 0.97).same).toBe(true);
  });

  it("matches an old project retyped as a big task", () => {
    expect(judgeSameItem(project("Test BrainDump"), bigTask("Test BrainDump"), 0.96).same).toBe(true);
  });

  it("still separates an area from a task with similar words", () => {
    const area = { title: "Health", node_type: "area" };
    expect(judgeSameItem(area, task("Health checkup"), 0.9).certainlyDistinct).toBe(true);
  });
});
