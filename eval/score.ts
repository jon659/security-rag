import type { RetrievedChunk } from "../src/graph/types.js";

export type EvalQuestion = { question: string; expected_doc_id: string | null; expected_section_keyword: string | null; expect_refusal: boolean };
export type Row = { hit: boolean; refusalCorrect: boolean; inCorpus: boolean };

export function scoreOne(
  q: EvalQuestion,
  result: { refused: boolean; sources: { id: number; title: string; section: string }[] },
  retrieved: RetrievedChunk[],
): Row {
  const inCorpus = !q.expect_refusal;
  const kw = (q.expected_section_keyword ?? "").toLowerCase();
  const hit = inCorpus && retrieved.some((c) => c.docId === q.expected_doc_id && c.section.toLowerCase().includes(kw));
  const refusalCorrect = result.refused === q.expect_refusal;
  return { hit, refusalCorrect, inCorpus };
}

export function summarize(rows: Row[]): { hitAt5: number; refusalAccuracy: number } {
  const inCorpus = rows.filter((r) => r.inCorpus);
  const hitAt5 = inCorpus.length ? inCorpus.filter((r) => r.hit).length / inCorpus.length : 0;
  const refusalAccuracy = rows.length ? rows.filter((r) => r.refusalCorrect).length / rows.length : 0;
  return { hitAt5, refusalAccuracy };
}
