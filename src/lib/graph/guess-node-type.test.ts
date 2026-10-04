import { describe, expect, it } from "vitest";

import { guessNodeType } from "./guess-node-type";

describe("guessNodeType", () => {
  it.each([
    ["", "task"],
    ["Email the professor", "task"],
    ["Call mom", "task"],
    ["Update CV", "task"],
    ["Solve 5 practice problems", "task"],
    ["fix login bug", "task"],
    ["Book stats class", "task"],
  ])("plain work stays a task: %s", (title, type) => {
    expect(guessNodeType(title)).toBe(type);
  });

  it.each([
    ["Pass the stats final by Dec 3", "goal"],
    ["Pass Machine Learning", "goal"],
    ["Land an internship in Milan", "goal"],
    ["Get an internship by November", "goal"],
    ["1450+ on the SAT", "goal"],
  ])("a result you'll know you reached is a goal: %s", (title, type) => {
    expect(guessNodeType(title)).toBe(type);
  });

  it.each([
    ["Meditate 10 min every morning", "habit"],
    ["Gym 3x a week", "habit"],
    ["Gym 3×/week", "habit"],
    ["Daily stretching", "habit"],
    ["Read twice a week", "habit"],
    ["Run every tuesday", "habit"],
  ])("a cadence is a habit: %s", (title, type) => {
    expect(guessNodeType(title)).toBe(type);
  });

  it.each([
    ["Learn Italian", "big_task"],
    ["Build the auth system", "big_task"],
    ["Write the thesis", "big_task"],
    ["Launch the beta", "project"],
  ])("several sittings → big task (launch → project): %s", (title, type) => {
    expect(guessNodeType(title)).toBe(type);
  });

  it.each([
    ["Maybe resell clothes", "idea"],
    ["What if the app logged routes", "idea"],
    ["Remember that the lab moved", "note"],
    ["Note: TA office is B12", "note"],
    ["Noah Kim is my TA", "note"],
  ])("thinking types: %s", (title, type) => {
    expect(guessNodeType(title)).toBe(type);
  });

  it.each([
    ["Health", "area"],
    ["Life admin", "area"],
    ["Linear Algebra class", "class"],
    ["Deep Learning course", "class"],
    ["Italian crash course", "task"],
  ])("structure: %s", (title, type) => {
    expect(guessNodeType(title)).toBe(type);
  });
});
