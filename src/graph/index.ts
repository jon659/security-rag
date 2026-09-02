import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { Store } from "../store/pg.js";
import type { Citation, RetrievedChunk, Vendors } from "./types.js";
import { grade, verify } from "./rules.js";

export const REFUSAL_MESSAGE =
  "The sources I have do not cover that question. They cover the OWASP LLM Top 10, the OWASP Top 10, and MITRE ATLAS techniques.";

export type AskResult = { answer: string; refused: boolean; rewritten: boolean; sources: Citation[] };

const State = Annotation.Root({
  question: Annotation<string>,
  query: Annotation<string>,
  chunks: Annotation<RetrievedChunk[]>,
  retries: Annotation<number>,
  relevant: Annotation<boolean>,
  answer: Annotation<string>,
  citations: Annotation<Citation[]>,
  refused: Annotation<boolean>,
});
type S = typeof State.State;

export function buildGraph(deps: { vendors: Vendors; nearest: Store["nearest"]; threshold: number }) {
  const { vendors, nearest, threshold } = deps;

  const retrieve = async (s: S): Promise<Partial<S>> => {
    const qv = await vendors.embedQuery(s.query);
    const candidates = await nearest(qv, 20);
    if (candidates.length === 0) return { chunks: [] };
    const ranked = await vendors.rerank(s.query, candidates.map((c) => ({ id: c.id, text: c.content })), 5);
    const chunks = ranked
      .map((r) => { const c = candidates.find((x) => x.id === r.id); return c ? { ...c, score: r.score } : null; })
      .filter((c): c is RetrievedChunk => c !== null);
    return { chunks };
  };

  const gradeNode = async (s: S): Promise<Partial<S>> => ({ relevant: grade(s.chunks, threshold) });

  const rewrite = async (s: S): Promise<Partial<S>> => ({ query: await vendors.rewrite(s.question), retries: s.retries + 1 });

  const generate = async (s: S): Promise<Partial<S>> => {
    const { answer, citations } = await vendors.generate(s.question, s.chunks);
    const v = verify(citations, s.chunks, answer);
    return { answer: v.refused ? REFUSAL_MESSAGE : answer, citations: v.citations, refused: v.refused };
  };

  const refuse = async (): Promise<Partial<S>> => ({ answer: REFUSAL_MESSAGE, citations: [], refused: true });

  const afterGrade = (s: S): "generate" | "rewrite" | "refuse" => {
    if (s.relevant) return "generate";
    return s.retries < 1 ? "rewrite" : "refuse";
  };

  const graph = new StateGraph(State)
    .addNode("retrieve", retrieve)
    .addNode("grade", gradeNode)
    .addNode("rewrite", rewrite)
    .addNode("generate", generate)
    .addNode("refuse", refuse)
    .addEdge(START, "retrieve")
    .addEdge("retrieve", "grade")
    .addConditionalEdges("grade", afterGrade)
    .addEdge("rewrite", "retrieve")
    .addEdge("generate", END)
    .addEdge("refuse", END)
    .compile();

  return {
    async ask(question: string): Promise<AskResult> {
      const out = await graph.invoke({ question, query: question, chunks: [], retries: 0, relevant: false, answer: "", citations: [], refused: false });
      return { answer: out.answer, refused: out.refused, rewritten: out.retries > 0, sources: out.citations };
    },
  };
}
