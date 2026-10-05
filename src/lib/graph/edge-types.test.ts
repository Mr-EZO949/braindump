import { describe, expect, it } from "vitest";
import {
  isLegacyLinkType,
  normalizeEdge,
  normalizeEdgeType,
  storedTypesFor,
} from "./edge-types";

const e = (edge_type: string, source_node_id = "a", target_node_id = "b") => ({
  id: "e",
  edge_type,
  source_node_id,
  target_node_id,
});

describe("normalizeEdgeType", () => {
  it("folds the nine stored types into four kinds", () => {
    expect(normalizeEdgeType("belongs_to")).toBe("belongs_to");
    expect(normalizeEdgeType("required_for")).toBe("required_for");
    expect(normalizeEdgeType("prerequisite_for")).toBe("required_for");
    expect(normalizeEdgeType("blocks")).toBe("required_for");
    expect(normalizeEdgeType("depends_on")).toBe("required_for");
    expect(normalizeEdgeType("supports")).toBe("supports");
    expect(normalizeEdgeType("useful_for")).toBe("supports");
    expect(normalizeEdgeType("related_to")).toBe("related_to");
    expect(normalizeEdgeType("inspired_by")).toBe("related_to");
  });

  it("reads anything unknown as related", () => {
    expect(normalizeEdgeType("whatever")).toBe("related_to");
    expect(normalizeEdgeType(null)).toBe("related_to");
  });
});

describe("normalizeEdge", () => {
  it("returns the same object for a current kind", () => {
    const edge = e("supports");
    expect(normalizeEdge(edge)).toBe(edge);
  });

  it("renames a same-direction legacy type", () => {
    expect(normalizeEdge(e("useful_for"))).toEqual(e("supports"));
    expect(normalizeEdge(e("blocks"))).toEqual(e("required_for"));
  });

  it("flips depends_on (stored from the dependent's side) and contains (from the parent's)", () => {
    // "a depends_on b" = b is needed for a.
    expect(normalizeEdge(e("depends_on"))).toEqual(e("required_for", "b", "a"));
    // "a contains b" = b belongs to a.
    expect(normalizeEdge(e("contains"))).toEqual(e("belongs_to", "b", "a"));
  });
});

describe("storedTypesFor / isLegacyLinkType", () => {
  it("lists the same-direction stored names of a kind, for DB filters", () => {
    expect(storedTypesFor("required_for").sort()).toEqual(["blocks", "prerequisite_for", "required_for"]);
    expect(storedTypesFor("supports").sort()).toEqual(["supports", "useful_for"]);
  });

  it("knows the retired lateral names", () => {
    expect(isLegacyLinkType("useful_for")).toBe(true);
    expect(isLegacyLinkType("depends_on")).toBe(true);
    expect(isLegacyLinkType("supports")).toBe(false);
    expect(isLegacyLinkType("contains")).toBe(false);
    expect(isLegacyLinkType("nonsense")).toBe(false);
  });
});
