export type RetrievedChunk = { id: number; docId: string; title: string; url: string; section: string; content: string; score: number };
export type Citation = { id: number; title: string; section: string; url: string; snippet: string; score: number };
export type Vendors = {
  embedQuery(text: string): Promise<number[]>;
  embedDocuments(texts: string[]): Promise<number[][]>;
  rerank(query: string, docs: { id: number; text: string }[], topN: number): Promise<{ id: number; score: number }[]>;
  rewrite(question: string): Promise<string>;
  generate(question: string, chunks: RetrievedChunk[]): Promise<{ answer: string; citations: number[] }>;
};
