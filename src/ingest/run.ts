import { readFile } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { chunkMarkdown } from "./chunk.js";
import { makeCohere } from "../vendors/cohere.js";
import { makeStore } from "../store/pg.js";

type Doc = { doc_id: string; title: string; url: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  const status = (err as { status?: unknown }).status;
  return statusCode === 429 || status === 429;
}

async function embedDocumentsWithRetry(
  cohere: ReturnType<typeof makeCohere>,
  texts: string[],
): Promise<number[][]> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await cohere.embedDocuments(texts);
    } catch (err) {
      if (!isRateLimitError(err) || attempt === maxAttempts) throw err;
      console.warn(`Cohere rate limit hit (attempt ${attempt}/${maxAttempts}), waiting 10s before retry`);
      await sleep(10_000);
    }
  }
  throw new Error("unreachable");
}

const cfg = loadConfig();
const cohere = makeCohere(cfg);
const store = makeStore(cfg.databaseUrl);
const manifest = JSON.parse(await readFile("data/corpus/manifest.json", "utf8")) as { documents: Doc[] };

for (const doc of manifest.documents) {
  const md = await readFile(`data/corpus/${doc.doc_id}.md`, "utf8");
  const chunks = chunkMarkdown(md);
  const embeddings = await embedDocumentsWithRetry(cohere, chunks.map((c) => c.content));
  const n = await store.replaceDocument(
    doc.doc_id,
    chunks.map((c, i) => ({ docId: doc.doc_id, title: doc.title, url: doc.url, section: c.section, ordinal: c.ordinal, content: c.content, embedding: embeddings[i] })),
  );
  console.log(`${doc.doc_id}: ${n} chunks`);
}
console.log("total chunks:", await store.count());
await store.close();
