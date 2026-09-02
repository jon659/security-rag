import { readFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { makeCohere } from "../vendors/cohere.js";
import { makeAnthropic } from "../vendors/anthropic.js";
import { makeStore } from "../store/pg.js";
import { buildGraph } from "../graph/index.js";
import { makeApp } from "./app.js";

export function wire() {
  const cfg = loadConfig();
  const store = makeStore(cfg.databaseUrl);
  const vendors = { ...makeCohere(cfg), ...makeAnthropic(cfg) };
  const graph = buildGraph({ vendors, nearest: store.nearest, threshold: cfg.relevanceThreshold });
  const html = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
  const app = makeApp({ ask: graph.ask, count: store.count, html });
  return { app, close: () => store.close() };
}
