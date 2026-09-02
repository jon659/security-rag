import { describe, it, expect } from "vitest";
import { chunkMarkdown } from "../src/ingest/chunk.js";

describe("chunkMarkdown", () => {
  it("returns nothing for empty input", () => {
    expect(chunkMarkdown("")).toEqual([]);
  });
  it("records the nearest heading as the section", () => {
    const md = "# Title\n\nIntro text.\n\n## Prompt Injection\n\nDetails here.";
    const chunks = chunkMarkdown(md);
    expect(chunks[0].section).toBe("Title");
    expect(chunks.at(-1)?.section).toBe("Prompt Injection");
  });
  it("never exceeds maxChars and overlaps consecutive windows", () => {
    const body = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} says something useful.`).join(" ");
    const chunks = chunkMarkdown(`# S\n\n${body}`, { maxChars: 300, overlapChars: 60 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(300);
    const tail = chunks[0].content.slice(-40);
    expect(chunks[1].content.includes(tail.slice(0, 20))).toBe(true);
  });
  it("numbers chunks in document order", () => {
    const chunks = chunkMarkdown("# A\n\none\n\n# B\n\ntwo");
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1]);
  });
});

describe("chunkMarkdown guards", () => {
  it("terminates when overlap is larger than the window", () => {
    const chunks = chunkMarkdown("# S\n\n" + "A".repeat(500), { maxChars: 100, overlapChars: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(100);
  });
});
