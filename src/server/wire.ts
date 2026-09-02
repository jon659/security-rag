import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig } from "../config.js";
import { makeCohere } from "../vendors/cohere.js";
import { makeAnthropic } from "../vendors/anthropic.js";
import { makeStore } from "../store/pg.js";
import { buildGraph } from "../graph/index.js";
import { makeApp } from "./app.js";

// Resolves a file under public/ regardless of whether we're running from source
// (tsx, rootDir ".") or from the compiled output (tsc, outDir "dist"):
//   - cwd-relative "public/<name>" covers Lambda (task root is cwd) and local runs
//     started from the repo root (e.g. `tsx src/server/local.ts`).
//   - "../../public/<name>" relative to this file covers tsx running this file in
//     place at src/server/wire.ts.
//   - "../../../public/<name>" relative to this file covers the compiled file at
//     dist/src/server/wire.js (one extra directory level under dist/).
export function resolvePublicFile(name: string): string {
  const candidates = [
    path.resolve(process.cwd(), "public", name),
    fileURLToPath(new URL(`../../public/${name}`, import.meta.url)),
    fileURLToPath(new URL(`../../../public/${name}`, import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`public file not found: ${name}`);
}

export function wire() {
  const cfg = loadConfig();
  const store = makeStore(cfg.databaseUrl);
  const vendors = { ...makeCohere(cfg), ...makeAnthropic(cfg) };
  const graph = buildGraph({ vendors, nearest: store.nearest, threshold: cfg.relevanceThreshold });
  const html = readFileSync(resolvePublicFile("index.html"), "utf8");
  const app = makeApp({ ask: graph.ask, count: store.count, html });
  return { app, close: () => store.close() };
}
