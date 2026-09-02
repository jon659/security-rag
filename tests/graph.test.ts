import { describe, it, expect } from "vitest";
import { buildGraph, REFUSAL_MESSAGE } from "../src/graph/index.js";
import type { RetrievedChunk, Vendors } from "../src/graph/types.js";

const c = (id: number, score: number): RetrievedChunk => ({ id, docId: "d", title: "T", url: "u", section: "S", content: "c", score });

function fakes(opts: { scores: number[][]; generate?: Vendors["generate"] }) {
  let call = 0;
  const rewrites: string[] = [];
  const vendors: Vendors = {
    embedQuery: async () => [0.1],
    embedDocuments: async (t) => t.map(() => [0.1]),
    rerank: async (_q, docs) => {
      const s = opts.scores[Math.min(call++, opts.scores.length - 1)];
      return docs.slice(0, s.length).map((d, i) => ({ id: d.id, score: s[i] }));
    },
    rewrite: async (q) => { rewrites.push(q); return q + " rewritten"; },
    generate: opts.generate ?? (async () => ({ answer: "Answer [1].", citations: [1] })),
  };
  const nearest = async () => [c(1, 0), c(2, 0), c(3, 0)];
  return { vendors, nearest, rewrites };
}

describe("graph", () => {
  it("answers with sources when retrieval is relevant", async () => {
    const f = fakes({ scores: [[0.9, 0.5]] });
    const r = await buildGraph({ vendors: f.vendors, nearest: f.nearest, threshold: 0.3 }).ask("q");
    expect(r.refused).toBe(false);
    expect(r.rewritten).toBe(false);
    expect(r.sources.map((s) => s.id)).toEqual([1]);
  });
  it("rewrites exactly once, then answers if the retry is relevant", async () => {
    const f = fakes({ scores: [[0.1], [0.8]] });
    const r = await buildGraph({ vendors: f.vendors, nearest: f.nearest, threshold: 0.3 }).ask("q");
    expect(f.rewrites).toEqual(["q"]);
    expect(r.rewritten).toBe(true);
    expect(r.refused).toBe(false);
  });
  it("refuses after one failed rewrite", async () => {
    const f = fakes({ scores: [[0.1], [0.1]] });
    const r = await buildGraph({ vendors: f.vendors, nearest: f.nearest, threshold: 0.3 }).ask("q");
    expect(f.rewrites.length).toBe(1);
    expect(r.refused).toBe(true);
    expect(r.answer).toBe(REFUSAL_MESSAGE);
  });
  it("refuses when the model cites nothing it was given", async () => {
    const f = fakes({ scores: [[0.9]], generate: async () => ({ answer: "made up", citations: [42] }) });
    const r = await buildGraph({ vendors: f.vendors, nearest: f.nearest, threshold: 0.3 }).ask("q");
    expect(r.refused).toBe(true);
  });
});
