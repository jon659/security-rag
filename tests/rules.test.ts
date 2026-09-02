import { describe, it, expect } from "vitest";
import { grade, verify } from "../src/graph/rules.js";
import type { RetrievedChunk } from "../src/graph/types.js";

const chunk = (id: number, score: number): RetrievedChunk => ({
  id, docId: "d", title: "T", url: "u", section: "S", content: "some content here", score,
});

describe("grade", () => {
  it("is relevant when the best score meets the threshold", () => {
    expect(grade([chunk(1, 0.3), chunk(2, 0.1)], 0.3)).toBe(true);
  });
  it("is not relevant below the threshold or with no chunks", () => {
    expect(grade([chunk(1, 0.29)], 0.3)).toBe(false);
    expect(grade([], 0.3)).toBe(false);
  });
});

describe("verify", () => {
  it("keeps only citations that point at retrieved chunks", () => {
    const r = verify([1, 99], [chunk(1, 0.5)], "Answer [1].");
    expect(r.citations.map((c) => c.id)).toEqual([1]);
    expect(r.refused).toBe(false);
  });
  it("refuses when the answer is NOT_COVERED", () => {
    const r = verify([], [chunk(1, 0.5)], "NOT_COVERED: sources cover injection only.");
    expect(r.refused).toBe(true);
    expect(r.citations).toEqual([]);
  });
  it("refuses when nothing valid is cited on a normal answer", () => {
    const r = verify([99], [chunk(1, 0.5)], "Confident text with no real source.");
    expect(r.refused).toBe(true);
  });
  it("builds a snippet no longer than 240 characters", () => {
    const long = { ...chunk(1, 0.5), content: "x".repeat(1000) };
    const r = verify([1], [long], "Answer [1].");
    expect(r.citations[0].snippet.length).toBeLessThanOrEqual(240);
  });
});
