import { loadConfig } from "./config.js";
import { makeCohere } from "./vendors/cohere.js";
import { makeAnthropic } from "./vendors/anthropic.js";
import { makeStore } from "./store/pg.js";
import { buildGraph } from "./graph/index.js";

const question = process.argv.slice(2).join(" ").trim();
if (!question) { console.error('usage: npm run ask "your question"'); process.exit(1); }

const cfg = loadConfig();
const cohere = makeCohere(cfg);
const llm = makeAnthropic(cfg);
const store = makeStore(cfg.databaseUrl);
const vendors = { ...cohere, ...llm };

const graph = buildGraph({ vendors, nearest: store.nearest, threshold: cfg.relevanceThreshold });
const { answer, rewritten, sources } = await graph.ask(question);

console.log("\n" + answer + "\n");
if (rewritten) console.log("(query was rewritten)");
for (const s of sources) {
  console.log(`[${s.id}] ${s.title} / ${s.section} (${s.score.toFixed(2)})`);
}
await store.close();
