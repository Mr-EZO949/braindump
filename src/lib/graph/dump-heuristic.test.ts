import { describe, expect, it } from "vitest";

import { looksLikeBreakdownAsk, looksLikeRestructure } from "./dump-heuristic";

describe("looksLikeBreakdownAsk (the one Sonnet chat turn)", () => {
  it.each([
    "break it down into steps",
    "can you break the thesis down?",
    "break the ML exam into phases",
    "give me a roadmap for learning italian",
    "subtasks for the portfolio site please",
    "add the steps for the internship search",
    "make me a step-by-step plan for the thesis",
  ])("a generated breakdown: %s", (msg) => {
    expect(looksLikeBreakdownAsk(msg)).toBe(true);
  });

  it.each([
    // restructures and captures — the builder's job, on Haiku + build_graph
    "split the thesis into research and writing",
    "move the brainstorm task under pass ML exam",
    "braindump should be added as a separate project called braindump and the test and market it are tasks in the project",
    "add a project Snapchat for productivity with tasks build, test, market",
    "add these:\n- call mom\n- pay rent\n- email prof",
    // planning is a tool (plan_day), not a reason for Sonnet
    "plan my day from 8 to 12",
    // simple edits, reports, questions
    "mark the gym as done",
    "rename it to Pass ML Exam",
    "add buy groceries",
    "i had a great leg day today at the gym",
    "what's next?",
    "how should i structure my thesis?",
    "how do i learn linear algebra fast?",
  ])("not a breakdown: %s", (msg) => {
    expect(looksLikeBreakdownAsk(msg)).toBe(false);
  });
});

describe("looksLikeRestructure (hint + retrieval, never a route)", () => {
  it.each([
    "split the thesis into research and writing",
    "the brainstorm ideas for ml should belong to pass ml exam",
    "restructure my university stuff",
    "can you reorganize the money projects?",
    "yes, reparent it",
    "I think italian crash course shouldn't belong to get internship, it's more personal development",
    "braindump should be added as a separate project called braindump and the test and market it are tasks in the project",
    "want me to convert the existing 'Test & Market BrainDump' big_task into a new parent project 'BrainDump'?",
    "did the gym today. also braindump should be its own project with testing and marketing in it",
  ])("reorganizes existing nodes: %s", (msg) => {
    expect(looksLikeRestructure(msg)).toBe(true);
  });

  it.each([
    "i have cleaned my room today",
    "yeah add it as task and mark it done",
    "mark the gym as done",
    "move the call with Abdo to Friday",
    "move the brainstorm task under pass ML exam",
    "can you merge the luxury larp account node with mundane fantazy?",
    "rename it to Pass ML Exam",
    "delete the skincare node",
    "set the deadline to October 15",
    "add buy groceries",
    "add a task under the ML exam project",
    "break it down into steps",
    "i should go to the gym more",
    "what's next?",
    "how should i structure my thesis?",
  ])("leaves alone: %s", (msg) => {
    expect(looksLikeRestructure(msg)).toBe(false);
  });
});
