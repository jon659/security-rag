import { describe, it, expect } from "vitest";
import { scoreOne, summarize } from "../eval/score.js";

const retrieved = [
  { id: 1, docId: "owasp-top10-2021", title: "T", url: "u", section: "A03 Injection", content: "", score: 0.9 },
  { id: 2, docId: "mitre-atlas", title: "T", url: "u", section: "AML.T0043 Craft Adversarial Data", content: "", score: 0.4 },
];

describe("scoreOne", () => {
  it("hits when a retrieved chunk matches doc and section keyword", () => {
    const r = scoreOne({ question: "q", expected_doc_id: "owasp-top10-2021", expected_section_keyword: "Injection", expect_refusal: false }, { refused: false, sources: [] }, retrieved);
    expect(r.hit).toBe(true);
    expect(r.refusalCorrect).toBe(true);
  });
  it("misses when the keyword is not in any retrieved section", () => {
    const r = scoreOne({ question: "q", expected_doc_id: "owasp-top10-2021", expected_section_keyword: "Cryptographic", expect_refusal: false }, { refused: false, sources: [] }, retrieved);
    expect(r.hit).toBe(false);
  });
  it("scores refusal correctness against expect_refusal", () => {
    const q = { question: "q", expected_doc_id: null, expected_section_keyword: null, expect_refusal: true };
    expect(scoreOne(q, { refused: true, sources: [] }, retrieved).refusalCorrect).toBe(true);
    expect(scoreOne(q, { refused: false, sources: [] }, retrieved).refusalCorrect).toBe(false);
  });
});

describe("summarize", () => {
  it("averages hit rate over in-corpus rows only and refusal over all rows", () => {
    const s = summarize([
      { hit: true, refusalCorrect: true, inCorpus: true },
      { hit: false, refusalCorrect: true, inCorpus: true },
      { hit: false, refusalCorrect: false, inCorpus: false },
    ]);
    expect(s.hitAt5).toBeCloseTo(0.5);
    expect(s.refusalAccuracy).toBeCloseTo(2 / 3);
  });
});
