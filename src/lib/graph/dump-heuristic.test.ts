import { describe, expect, it } from "vitest";

import { looksLikeStructuralEdit } from "./dump-heuristic";

describe("looksLikeStructuralEdit (Sonnet routing)", () => {
  it.each([
    "split the thesis into research and writing",
    "can you merge the luxury larp account node with mundane fantazy?",
    "move the brainstorm task under pass ML exam",
    "the brainstorm ideas for ml should belong to pass ml exam",
    "add a task under the ML exam project",
    "break it down into steps",
    "restructure my university stuff",
    "plan my day from 8 to 12",
    "replan my afternoon",
    "add a project Snapchat for productivity with tasks build, test, market",
    "add these:\n- call mom\n- pay rent\n- email prof",
  ])("routes structural/planning turns to Sonnet: %s", (msg) => {
    expect(looksLikeStructuralEdit(msg)).toBe(true);
  });

  it.each([
    "i have cleaned my room today",
    "yeah add it as task and mark it done",
    "mark the gym as done",
    "move the call with Abdo to Friday",
    "reschedule the gym to 6pm",
    "rename it to Pass ML Exam",
    "delete the skincare node",
    "set the deadline to October 15",
    "add buy groceries",
    "what's next?",
    "how should i structure my thesis?",
  ])("keeps simple edits and questions on Haiku: %s", (msg) => {
    expect(looksLikeStructuralEdit(msg)).toBe(false);
  });
});
