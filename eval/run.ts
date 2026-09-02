import { readFile } from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { makeCohere } from "../src/vendors/cohere.js";
import { makeAnthropic } from "../src/vendors/anthropic.js";
import { makeStore } from "../src/store/pg.js";
import { buildGraph } from "../src/graph/index.js";
import { scoreOne, summarize, type EvalQuestion, type Row } from "./score.js";

const cfg = loadConfig();
const cohere = makeCohere(cfg);
const llm = makeAnthropic(cfg);
const store = makeStore(cfg.databaseUrl);
const vendors = { ...cohere, ...llm };
const graph = buildGraph({ vendors, nearest: store.nearest, threshold: cfg.relevanceThreshold });
const questions = JSON.parse(await readFile("eval/questions.json", "utf8")) as EvalQuestion[];

const rows: Row[] = [];
for (const q of questions) {
  const qv = await cohere.embedQuery(q.question);
  const candidates = await store.nearest(qv, 20);
  const ranked = await cohere.rerank(q.question, candidates.map((c) => ({ id: c.id, text: c.content })), 5);
  const retrieved = ranked.map((r) => ({ ...candidates.find((c) => c.id === r.id)!, score: r.score }));
  const result = await graph.ask(q.question);
  const row = scoreOne(q, result, retrieved);
  rows.push(row);
  console.log(`${row.hit || q.expect_refusal ? "ok " : "MISS"} ${row.refusalCorrect ? "   " : "REF"} ${q.question}`);
}
const s = summarize(rows);
console.log(`\nhit@5: ${(s.hitAt5 * 100).toFixed(0)}%   refusal accuracy: ${(s.refusalAccuracy * 100).toFixed(0)}%   (${new Date().toISOString().slice(0, 10)})`);
await store.close();
