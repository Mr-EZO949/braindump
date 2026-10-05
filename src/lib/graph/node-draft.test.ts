import { describe, expect, it } from "vitest";

import type { CreateNodeInput, Node } from "@/types/graph";

import {
  checkNodeDraft,
  createDraftFromNode,
  defaultCreateNodeDraft,
  draftTargetDate,
  editedNodeFields,
  embeddingTextChanged,
  newNodeRow,
} from "./node-draft";

const draft = (extra: Partial<CreateNodeInput> = {}): CreateNodeInput => ({ ...defaultCreateNodeDraft, ...extra });

describe("createDraftFromNode", () => {
  it("opens a node as itself, with its fields", () => {
    const d = createDraftFromNode({
      id: "n",
      title: "Pass stats",
      node_type: "goal",
      importance: "high",
      importance_index: 80,
      manual_weight: 70,
      raw_text: null,
      summary: "s",
      body: null,
      target_date: "2026-11-01",
    } as Node);
    expect(d).toMatchObject({
      node_type: "goal",
      custom_type: "",
      title: "Pass stats",
      summary: "s",
      body: "",
      raw_text: "",
      manual_weight: 70,
      target_date: "2026-11-01",
    });
  });

  it("opens a retired type as its v2 equivalent", () => {
    const d = createDraftFromNode({ id: "n", title: "x", node_type: "concept", importance: "low" } as unknown as Node);
    expect(d.node_type).toBe("note");
    expect(d.custom_type).toBe("");
    expect(d.manual_weight).toBeNull();
    expect(d.target_date).toBe("");
  });
});

describe("checkNodeDraft", () => {
  it("needs a title, then a type", () => {
    expect(checkNodeDraft(draft({ title: "  " }))).toEqual({ ok: false, error: "Title is required." });
    expect(checkNodeDraft(draft({ title: "x", node_type: "custom", custom_type: " " }))).toEqual({
      ok: false,
      error: "Choose a node type or enter a custom type.",
    });
    expect(checkNodeDraft(draft({ title: " x ", node_type: "custom", custom_type: " Ritual " }))).toEqual({
      ok: true,
      title: "x",
      nodeType: "Ritual",
    });
  });
});

describe("draftTargetDate", () => {
  it("keeps only a YYYY-MM-DD date", () => {
    expect(draftTargetDate(draft({ target_date: " 2026-10-20 " }))).toBe("2026-10-20");
    expect(draftTargetDate(draft({ target_date: "next friday" }))).toBeNull();
    expect(draftTargetDate(draft({ target_date: "" }))).toBeNull();
  });
});

describe("newNodeRow / editedNodeFields", () => {
  const d = draft({ title: "x", summary: " s ", raw_text: " ", body: "b", importance_index: 80, target_date: "2026-10-20" });

  it("builds the inserted row with trimmed text and the type's colour", () => {
    const row = newNodeRow(d, { title: "x", nodeType: "task" }, { userId: "u", workspaceId: "w" });
    expect(row).toMatchObject({
      title: "x",
      node_type: "task",
      summary: "s",
      raw_text: null,
      body: "b",
      importance: "high",
      importance_index: 80,
      target_date: "2026-10-20",
      user_id: "u",
      workspace_id: "w",
    });
    expect(typeof row.color).toBe("string");
  });

  it("stamps a manual weight and the edit time", () => {
    let tick = 0;
    const now = () => `t${++tick}`;
    expect(editedNodeFields({ ...d, manual_weight: 40 }, { title: "x", nodeType: "task" }, now)).toMatchObject({
      manual_weight: 40,
      manual_weight_set_at: "t1",
      updated_at: "t2",
    });
    expect(editedNodeFields(d, { title: "x", nodeType: "task" }, () => "t")).toMatchObject({
      manual_weight: null,
      manual_weight_set_at: null,
      updated_at: "t",
    });
  });
});

describe("newNodeRow keeps an importance the user picked (#25)", () => {
  it("a slider value is a manual weight, so the intake's rescore keeps it", () => {
    const row = newNodeRow(draft({ title: "x", manual_weight: 90, importance_index: 90 }), { title: "x", nodeType: "task" }, { userId: "u", workspaceId: "w" }, () => "t");
    expect(row).toMatchObject({ manual_weight: 90, manual_weight_set_at: "t", importance_index: 90 });
  });

  it("no slider touch: no manual weight — the scorer sizes it", () => {
    const row = newNodeRow(draft({ title: "x" }), { title: "x", nodeType: "task" }, { userId: "u", workspaceId: "w" });
    expect(row).not.toHaveProperty("manual_weight");
    expect(row).not.toHaveProperty("manual_weight_set_at");
  });
});

describe("embeddingTextChanged", () => {
  it("case, punctuation and spacing don't count", () => {
    expect(embeddingTextChanged({ title: "Email the prof" }, { title: "email the prof." })).toBe(false);
    expect(embeddingTextChanged({ title: "Update CV", summary: null }, { title: "Update  CV", summary: "" })).toBe(false);
  });

  it("new words in the title or the summary do", () => {
    expect(embeddingTextChanged({ title: "Update CV" }, { title: "Update CV and LinkedIn" })).toBe(true);
    expect(embeddingTextChanged({ title: "Update CV", summary: null }, { title: "Update CV", summary: "for Milan" })).toBe(true);
  });
});
