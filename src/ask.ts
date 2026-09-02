import { loadConfig } from "./config.js";
import { makeCohere } from "./vendors/cohere.js";
import { makeAnthropic } from "./vendors/anthropic.js";
import { makeStore } from "./store/pg.js";

const question = process.argv.slice(2).join(" ").trim();
if (!question) { console.error('usage: npm run ask "your question"'); process.exit(1); }

const cfg = loadConfig();
const cohere = makeCohere(cfg);
const llm = makeAnthropic(cfg);
const store = makeStore(cfg.databaseUrl);

const qv = await cohere.embedQuery(question);
const candidates = await store.nearest(qv, 20);
const ranked = await cohere.rerank(question, candidates.map((c) => ({ id: c.id, text: c.content })), 5);
const top = ranked.map((r) => ({ ...candidates.find((c) => c.id === r.id)!, score: r.score }));
const { answer, citations } = await llm.generate(question, top);

console.log("\n" + answer + "\n");
for (const id of citations) {
  const c = top.find((t) => t.id === id);
  if (c) console.log(`[${id}] ${c.title} / ${c.section} (${c.score.toFixed(2)})`);
}
await store.close();
