import type { Citation, RetrievedChunk } from "./types.js";

/** Relevant when the single best reranked chunk clears the threshold. */
export function grade(chunks: RetrievedChunk[], threshold: number): boolean {
  if (chunks.length === 0) return false;
  return Math.max(...chunks.map((c) => c.score)) >= threshold;
}

/** Keep only citations the model was actually given; refuse on NOT_COVERED or an uncited answer. */
export function verify(
  citations: number[],
  chunks: RetrievedChunk[],
  answer: string,
): { citations: Citation[]; refused: boolean } {
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const valid: Citation[] = [];
  for (const id of new Set(citations)) {
    const c = byId.get(id);
    if (c) valid.push({ id: c.id, title: c.title, section: c.section, url: c.url, snippet: c.content.slice(0, 240), score: c.score });
  }
  const notCovered = answer.trim().startsWith("NOT_COVERED:");
  const refused = notCovered || valid.length === 0;
  return { citations: refused ? [] : valid, refused };
}
