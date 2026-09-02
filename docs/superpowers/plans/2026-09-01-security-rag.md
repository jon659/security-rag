# security-rag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployed TypeScript service that answers AI/application-security questions from the OWASP LLM Top 10, OWASP Top 10, and MITRE ATLAS, with citations, refusing when the corpus does not cover the question.

**Architecture:** Two processes over one Postgres+pgvector table. An ingest CLI chunks markdown, embeds with Cohere, and stores rows. A LangGraph pipeline (retrieve, grade, rewrite once, generate, verify, refuse) serves `POST /ask` through Hono, locally on Node and in production as a Docker image on AWS Lambda deployed by GitHub Actions.

**Tech Stack:** Node 22+ (Lambda runs 22), TypeScript strict ESM, `@langchain/langgraph`, `cohere-ai` (embed + rerank), `@anthropic-ai/sdk` (generation), `pg` + `pgvector`, `hono` + `@hono/node-server`, `zod`, `vitest`, `tsx`, Docker, GitHub Actions with AWS OIDC.

## Global Constraints

- TypeScript `strict: true`, ESM (`"type": "module"`), Node 22 or newer locally, Lambda base image `public.ecr.aws/lambda/nodejs:22`.
- Secrets only from environment: `COHERE_API_KEY`, `ANTHROPIC_API_KEY`, `DATABASE_URL`. Never committed, never logged. `.env` is gitignored.
- Unit tests make no network calls and need no database; vendor functions are injected and faked.
- Chunk target about 800 tokens (3200 characters) with 100 tokens (400 characters) overlap; embeddings are 1024 dimensions.
- Relevance threshold default 0.30; at most one query rewrite per question.
- API: `POST /ask` body `{ question }` 1 to 500 chars; 10 requests per minute per IP; errors 400/429/502/503 as specified.
- No em dashes in any README, page copy, error message, or log string. Plain punctuation only.
- Owner-written tasks (marked OWNER-WRITTEN) are typed by Jon with the assistant explaining; the code in this plan is the reference solution, not something to paste.
- Commit after every task with the message given.

---

## File Structure

```
security-rag/
  package.json  tsconfig.json  vitest.config.ts  eslint.config.js
  .gitignore  .env.example  Dockerfile  README.md
  data/corpus/manifest.json   (source list)
  data/corpus/SOURCES.md      (provenance and licenses)
  data/corpus/*.md            (fetched documents, committed)
  scripts/fetch-corpus.ts     (downloads and converts sources)
  scripts/secrets_scan.py     (copied from security-lab, run in CI)
  src/config.ts               (env loading with zod)
  src/ingest/chunk.ts         (OWNER) markdown -> chunks
  src/ingest/run.ts           (ingest CLI)
  src/vendors/cohere.ts       (embed, rerank)
  src/vendors/anthropic.ts    (rewrite, generate)
  src/store/pg.ts             (schema, insert, nearest, count)
  src/graph/types.ts          (shared types)
  src/graph/rules.ts          (OWNER) grade, verify
  src/graph/index.ts          (LangGraph pipeline builder)
  src/ask.ts                  (terminal: npm run ask "question")
  src/server/app.ts           (Hono app)
  src/server/local.ts         (node server)
  src/server/lambda.ts        (Lambda handler)
  public/index.html           (demo page)
  eval/questions.json  eval/score.ts (OWNER)  eval/run.ts
  tests/chunk.test.ts  tests/rules.test.ts  tests/graph.test.ts  tests/app.test.ts  tests/score.test.ts
  infra/setup.sh
  .github/workflows/ci.yml  .github/workflows/deploy.yml
```

---

## Phase 1: Local RAG works

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.gitignore`, `.env.example`, `README.md`, `src/config.ts`, `tests/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): Config` from `src/config.ts` with fields `cohereApiKey, anthropicApiKey, databaseUrl, relevanceThreshold, embedModel, rerankModel, generateModel`.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "security-rag",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint src eval tests scripts",
    "test": "vitest run",
    "build": "tsc",
    "fetch-corpus": "tsx scripts/fetch-corpus.ts",
    "db:init": "tsx src/store/init.ts",
    "ingest": "tsx src/ingest/run.ts",
    "ask": "tsx src/ask.ts",
    "eval": "tsx eval/run.ts",
    "dev": "tsx src/server/local.ts",
    "smoke": "tsx scripts/smoke.ts"
  }
}
```

- [ ] **Step 2: Install dependencies** (versions resolve to current at install; the SDK method names used in this plan are the v2 Cohere client and the current Anthropic and LangGraph JS APIs; if a name has drifted, `npm run typecheck` will say so and the fix is local to the vendor file)

Run:
```bash
cd "C:/Users/Jonathan Harrison/Documents/portfolio/security-rag"
npm install @langchain/langgraph @langchain/core cohere-ai @anthropic-ai/sdk pg pgvector hono @hono/node-server zod dotenv
npm install -D typescript tsx vitest @types/node @types/pg eslint @eslint/js typescript-eslint
```
Expected: `node_modules/` created, no errors.

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["src", "eval", "scripts", "tests"]
}
```

- [ ] **Step 4: Create vitest.config.ts and eslint.config.js**

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });
```

`eslint.config.js`:
```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";
export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, {
  ignores: ["dist/**", "node_modules/**"],
});
```

- [ ] **Step 5: Create .gitignore and .env.example**

`.gitignore`:
```
node_modules/
dist/
.env
*.log
```

`.env.example`:
```
COHERE_API_KEY=your-cohere-key-here
ANTHROPIC_API_KEY=your-anthropic-key-here
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require
RELEVANCE_THRESHOLD=0.30
EMBED_MODEL=embed-v4.0
RERANK_MODEL=rerank-v3.5
GENERATE_MODEL=claude-sonnet-5
```

- [ ] **Step 6: Write the failing config test** at `tests/config.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const good = {
  COHERE_API_KEY: "c", ANTHROPIC_API_KEY: "a", DATABASE_URL: "postgresql://x",
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(good);
    expect(c.relevanceThreshold).toBe(0.3);
    expect(c.embedModel).toBe("embed-v4.0");
  });
  it("rejects a missing key with a message naming it", () => {
    expect(() => loadConfig({ ...good, COHERE_API_KEY: "" })).toThrow(/COHERE_API_KEY/);
  });
  it("rejects a non-numeric threshold", () => {
    expect(() => loadConfig({ ...good, RELEVANCE_THRESHOLD: "high" })).toThrow();
  });
});
```

- [ ] **Step 7: Run it to see it fail**

Run: `npm test`
Expected: FAIL, cannot find module `../src/config.js`.

- [ ] **Step 8: Write src/config.ts**

```ts
import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  COHERE_API_KEY: z.string().min(1, "COHERE_API_KEY is required"),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  RELEVANCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.3),
  EMBED_MODEL: z.string().default("embed-v4.0"),
  RERANK_MODEL: z.string().default("rerank-v3.5"),
  GENERATE_MODEL: z.string().default("claude-sonnet-5"),
});

export type Config = {
  cohereApiKey: string;
  anthropicApiKey: string;
  databaseUrl: string;
  relevanceThreshold: number;
  embedModel: string;
  rerankModel: string;
  generateModel: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid configuration: ${names}`);
  }
  const e = parsed.data;
  return {
    cohereApiKey: e.COHERE_API_KEY,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    databaseUrl: e.DATABASE_URL,
    relevanceThreshold: e.RELEVANCE_THRESHOLD,
    embedModel: e.EMBED_MODEL,
    rerankModel: e.RERANK_MODEL,
    generateModel: e.GENERATE_MODEL,
  };
}
```

- [ ] **Step 9: Run tests, typecheck, lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: 3 tests pass; typecheck and lint clean.

- [ ] **Step 10: Create README.md stub and commit**

`README.md`:
```markdown
# security-rag

Ask an AI or application security question. Get an answer grounded in the OWASP LLM Top 10, the OWASP Top 10, and MITRE ATLAS, with citations. If the sources do not cover it, the service says so.

Status: in progress. Evaluation numbers and the demo URL land here when phases 2 and 4 complete.

## Run locally

1. Copy `.env.example` to `.env` and fill in the keys.
2. `npm install`
3. `npm run db:init` then `npm run ingest`
4. `npm run ask "What is prompt injection?"`
```

```bash
git add -A && git commit -m "feat: project scaffold with typed config"
```

---

### Task 2: Chunker (OWNER-WRITTEN)

Jon types this file. The assistant explains the algorithm line by line first: split on headings so a chunk never straddles two topics, then slide a window over long sections with overlap so a sentence cut at a boundary still appears whole in one chunk.

**Files:**
- Create: `src/ingest/chunk.ts`, `tests/chunk.test.ts`

**Interfaces:**
- Produces: `chunkMarkdown(markdown: string, opts?: { maxChars?: number; overlapChars?: number }): Chunk[]` where `Chunk = { section: string; ordinal: number; content: string }`.

- [ ] **Step 1: Write the failing tests** at `tests/chunk.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { chunkMarkdown } from "../src/ingest/chunk.js";

describe("chunkMarkdown", () => {
  it("returns nothing for empty input", () => {
    expect(chunkMarkdown("")).toEqual([]);
  });
  it("records the nearest heading as the section", () => {
    const md = "# Title\n\nIntro text.\n\n## Prompt Injection\n\nDetails here.";
    const chunks = chunkMarkdown(md);
    expect(chunks[0].section).toBe("Title");
    expect(chunks.at(-1)?.section).toBe("Prompt Injection");
  });
  it("never exceeds maxChars and overlaps consecutive windows", () => {
    const body = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} says something useful.`).join(" ");
    const chunks = chunkMarkdown(`# S\n\n${body}`, { maxChars: 300, overlapChars: 60 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(300);
    const tail = chunks[0].content.slice(-40);
    expect(chunks[1].content.startsWith(chunks[0].content.slice(-60).trimStart().slice(0, 10)) || chunks[1].content.includes(tail.slice(0, 20))).toBe(true);
  });
  it("numbers chunks in document order", () => {
    const chunks = chunkMarkdown("# A\n\none\n\n# B\n\ntwo");
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1]);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npm test -- chunk`
Expected: FAIL, module not found.

- [ ] **Step 3: Write src/ingest/chunk.ts** (reference solution; Jon types it)

```ts
export type Chunk = { section: string; ordinal: number; content: string };

type Opts = { maxChars?: number; overlapChars?: number };

/** Split markdown into heading-scoped sections, then window long sections with overlap. */
export function chunkMarkdown(markdown: string, opts: Opts = {}): Chunk[] {
  const maxChars = opts.maxChars ?? 3200;
  const overlap = opts.overlapChars ?? 400;
  const lines = markdown.split(/\r?\n/);

  // Pass 1: group lines under their nearest heading.
  const sections: { section: string; text: string }[] = [];
  let current = { section: "", text: "" };
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      if (current.text.trim()) sections.push(current);
      current = { section: heading[1].trim(), text: "" };
    } else {
      current.text += line + "\n";
    }
  }
  if (current.text.trim()) sections.push(current);

  // Pass 2: window each section's text with overlap.
  const out: Chunk[] = [];
  let ordinal = 0;
  for (const { section, text } of sections) {
    const body = text.trim();
    if (!body) continue;
    let start = 0;
    while (start < body.length) {
      const end = Math.min(start + maxChars, body.length);
      out.push({ section, ordinal: ordinal++, content: body.slice(start, end).trim() });
      if (end === body.length) break;
      start = end - overlap;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- chunk`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/chunk.ts tests/chunk.test.ts && git commit -m "feat: markdown chunker with heading scoping and overlap"
```

---

### Task 3: Corpus manifest, fetch script, provenance

**Files:**
- Create: `data/corpus/manifest.json`, `scripts/fetch-corpus.ts`, `data/corpus/SOURCES.md`

**Interfaces:**
- Produces: `data/corpus/<doc_id>.md` files, one per document, each starting with `# <title>`.

- [ ] **Step 1: Create data/corpus/manifest.json**

The OWASP entries are raw GitHub markdown files. The ATLAS entry is a YAML file the script converts. If a URL returns 404 at fetch time, open the repository in a browser, find the current path of that file, and correct the URL here; the file names below are the ones published at the time of writing.

```json
{
  "documents": [
    {
      "doc_id": "owasp-llm-top10-2025",
      "title": "OWASP Top 10 for LLM Applications 2025",
      "url": "https://genai.owasp.org/llm-top-10/",
      "license": "CC BY-SA 4.0",
      "kind": "markdown",
      "files": [
        "https://raw.githubusercontent.com/OWASP/www-project-top-10-for-large-language-model-applications/main/2_0_vulns/LLM01_PromptInjection.md",
        "https://raw.githubusercontent.com/OWASP/www-project-top-10-for-large-language-model-applications/main/2_0_vulns/LLM02_SensitiveInformationDisclosure.md",
        "https://raw.githubusercontent.com/OWASP/www-project-top-10-for-large-language-model-applications/main/2_0_vulns/LLM03_SupplyChain.md",
        "https://raw.githubusercontent.com/OWASP/www-project-top-10-for-large-language-model-applications/main/2_0_vulns/LLM04_DataModelPoisoning.md",
        "https://raw.githubusercontent.com/OWASP/www-project-top-10-for-large-language-model-applications/main/2_0_vulns/LLM05_ImproperOutputHandling.md",
        "https://raw.githubusercontent.com/OWASP/www-project-top-10-for-large-language-model-applications/main/2_0_vulns/LLM06_ExcessiveAgency.md",
        "https://raw.githubusercontent.com/OWASP/www-project-top-10-for-large-language-model-applications/main/2_0_vulns/LLM07_SystemPromptLeakage.md",
        "https://raw.githubusercontent.com/OWASP/www-project-top-10-for-large-language-model-applications/main/2_0_vulns/LLM08_VectorAndEmbeddingWeaknesses.md",
        "https://raw.githubusercontent.com/OWASP/www-project-top-10-for-large-language-model-applications/main/2_0_vulns/LLM09_Misinformation.md",
        "https://raw.githubusercontent.com/OWASP/www-project-top-10-for-large-language-model-applications/main/2_0_vulns/LLM10_UnboundedConsumption.md"
      ]
    },
    {
      "doc_id": "owasp-top10-2021",
      "title": "OWASP Top 10 2021",
      "url": "https://owasp.org/Top10/",
      "license": "CC BY-SA 4.0",
      "kind": "markdown",
      "files": [
        "https://raw.githubusercontent.com/OWASP/Top10/master/2021/docs/A01_2021-Broken_Access_Control.md",
        "https://raw.githubusercontent.com/OWASP/Top10/master/2021/docs/A02_2021-Cryptographic_Failures.md",
        "https://raw.githubusercontent.com/OWASP/Top10/master/2021/docs/A03_2021-Injection.md",
        "https://raw.githubusercontent.com/OWASP/Top10/master/2021/docs/A04_2021-Insecure_Design.md",
        "https://raw.githubusercontent.com/OWASP/Top10/master/2021/docs/A05_2021-Security_Misconfiguration.md",
        "https://raw.githubusercontent.com/OWASP/Top10/master/2021/docs/A06_2021-Vulnerable_and_Outdated_Components.md",
        "https://raw.githubusercontent.com/OWASP/Top10/master/2021/docs/A07_2021-Identification_and_Authentication_Failures.md",
        "https://raw.githubusercontent.com/OWASP/Top10/master/2021/docs/A08_2021-Software_and_Data_Integrity_Failures.md",
        "https://raw.githubusercontent.com/OWASP/Top10/master/2021/docs/A09_2021-Security_Logging_and_Monitoring_Failures.md",
        "https://raw.githubusercontent.com/OWASP/Top10/master/2021/docs/A10_2021-Server-Side_Request_Forgery_%28SSRF%29.md"
      ]
    },
    {
      "doc_id": "mitre-atlas",
      "title": "MITRE ATLAS Techniques",
      "url": "https://atlas.mitre.org/techniques",
      "license": "Apache 2.0 (see repository LICENSE)",
      "kind": "atlas-yaml",
      "files": [
        "https://raw.githubusercontent.com/mitre-atlas/atlas-data/main/data/techniques.yaml"
      ]
    }
  ]
}
```

- [ ] **Step 2: Install a YAML parser and write scripts/fetch-corpus.ts**

Run: `npm install yaml`

```ts
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

type Doc = { doc_id: string; title: string; url: string; license: string; kind: "markdown" | "atlas-yaml"; files: string[] };

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return res.text();
}

function atlasToMarkdown(yamlText: string, title: string): string {
  const data = parseYaml(yamlText) as unknown;
  const list: Array<Record<string, unknown>> = Array.isArray(data) ? data : ((data as { techniques?: [] }).techniques ?? []);
  const parts = [`# ${title}`, ""];
  for (const t of list) {
    const id = String(t.id ?? "");
    const name = String(t.name ?? "");
    const desc = String(t.description ?? "").trim();
    if (!name) continue;
    parts.push(`## ${id} ${name}`, "", desc, "");
  }
  return parts.join("\n");
}

async function main() {
  const manifest = JSON.parse(await readFile("data/corpus/manifest.json", "utf8")) as { documents: Doc[] };
  await mkdir("data/corpus", { recursive: true });
  for (const doc of manifest.documents) {
    let out = "";
    if (doc.kind === "markdown") {
      const bodies = [];
      for (const f of doc.files) bodies.push(await fetchText(f));
      out = `# ${doc.title}\n\n` + bodies.join("\n\n");
    } else {
      out = atlasToMarkdown(await fetchText(doc.files[0]), doc.title);
    }
    await writeFile(`data/corpus/${doc.doc_id}.md`, out, "utf8");
    console.log(`${doc.doc_id}: ${out.length} chars`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 3: Run the fetch**

Run: `npm run fetch-corpus`
Expected: three lines like `owasp-llm-top10-2025: 61234 chars`. Each file more than 20,000 characters. If any URL 404s, fix the manifest path (see the note in Step 1) and rerun.

- [ ] **Step 4: Write data/corpus/SOURCES.md**

```markdown
# Corpus sources

| doc_id | Title | Canonical URL | License | Fetched |
|---|---|---|---|---|
| owasp-llm-top10-2025 | OWASP Top 10 for LLM Applications 2025 | https://genai.owasp.org/llm-top-10/ | CC BY-SA 4.0 | 2026-09-01 |
| owasp-top10-2021 | OWASP Top 10 2021 | https://owasp.org/Top10/ | CC BY-SA 4.0 | 2026-09-01 |
| mitre-atlas | MITRE ATLAS Techniques | https://atlas.mitre.org/techniques | Apache 2.0 | 2026-09-01 |

Text is reproduced for retrieval and quotation with attribution. Refetch with `npm run fetch-corpus`.
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: corpus manifest, fetch script, and provenance"
```

---

### Task 4: Cohere adapter (embed + rerank)

**Files:**
- Create: `src/vendors/cohere.ts`, `src/graph/types.ts`

**Interfaces:**
- Produces from `src/graph/types.ts`:
  ```ts
  export type RetrievedChunk = { id: number; docId: string; title: string; url: string; section: string; content: string; score: number };
  export type Citation = { id: number; title: string; section: string; url: string; snippet: string; score: number };
  export type Vendors = {
    embedQuery(text: string): Promise<number[]>;
    embedDocuments(texts: string[]): Promise<number[][]>;
    rerank(query: string, docs: { id: number; text: string }[], topN: number): Promise<{ id: number; score: number }[]>;
    rewrite(question: string): Promise<string>;
    generate(question: string, chunks: RetrievedChunk[]): Promise<{ answer: string; citations: number[] }>;
  };
  ```
- Produces from `src/vendors/cohere.ts`: `makeCohere(cfg: Config): Pick<Vendors, "embedQuery" | "embedDocuments" | "rerank">`.

- [ ] **Step 1: Create src/graph/types.ts** with exactly the types above.

- [ ] **Step 2: Create src/vendors/cohere.ts**

```ts
import { CohereClientV2 } from "cohere-ai";
import type { Config } from "../config.js";
import type { Vendors } from "../graph/types.js";

export function makeCohere(cfg: Config): Pick<Vendors, "embedQuery" | "embedDocuments" | "rerank"> {
  const client = new CohereClientV2({ token: cfg.cohereApiKey });

  async function embed(texts: string[], inputType: "search_query" | "search_document"): Promise<number[][]> {
    const res = await client.embed({
      model: cfg.embedModel,
      texts,
      inputType,
      embeddingTypes: ["float"],
    });
    const vectors = res.embeddings?.float;
    if (!vectors || vectors.length !== texts.length) throw new Error("Cohere embed returned an unexpected shape");
    return vectors;
  }

  return {
    embedQuery: async (text) => (await embed([text], "search_query"))[0],
    embedDocuments: async (texts) => {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 96) out.push(...(await embed(texts.slice(i, i + 96), "search_document")));
      return out;
    },
    rerank: async (query, docs, topN) => {
      const res = await client.rerank({
        model: cfg.rerankModel,
        query,
        documents: docs.map((d) => d.text),
        topN,
      });
      return res.results.map((r) => ({ id: docs[r.index].id, score: r.relevanceScore }));
    },
  };
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean. If the SDK's method or field names differ (for example `embeddings.float` vs `embeddings.float_`), adjust this file only; the `Vendors` interface stays the same.

- [ ] **Step 4: Commit**

```bash
git add src/graph/types.ts src/vendors/cohere.ts && git commit -m "feat: cohere embed and rerank adapter behind Vendors interface"
```

---

### Task 5: Postgres store

**Files:**
- Create: `src/store/pg.ts`, `src/store/init.ts`

**Interfaces:**
- Produces: `makeStore(databaseUrl: string): Store` with
  ```ts
  type Store = {
    init(): Promise<void>;                                   // extension, table, index
    replaceDocument(docId: string, rows: InsertRow[]): Promise<number>;
    nearest(embedding: number[], k: number): Promise<RetrievedChunk[]>;
    count(): Promise<number>;
    close(): Promise<void>;
  };
  type InsertRow = { docId: string; title: string; url: string; section: string; ordinal: number; content: string; embedding: number[] };
  ```

- [ ] **Step 1: Create src/store/pg.ts**

```ts
import pg from "pg";
import pgvector from "pgvector/pg";
import type { RetrievedChunk } from "../graph/types.js";

export type InsertRow = { docId: string; title: string; url: string; section: string; ordinal: number; content: string; embedding: number[] };

export type Store = {
  init(): Promise<void>;
  replaceDocument(docId: string, rows: InsertRow[]): Promise<number>;
  nearest(embedding: number[], k: number): Promise<RetrievedChunk[]>;
  count(): Promise<number>;
  close(): Promise<void>;
};

export function makeStore(databaseUrl: string): Store {
  const pool = new pg.Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: true }, max: 3 });
  pool.on("connect", (client) => { void pgvector.registerTypes(client); });

  return {
    async init() {
      await pool.query("create extension if not exists vector");
      await pool.query(`create table if not exists chunks (
        id serial primary key,
        doc_id text not null,
        title text not null,
        url text not null,
        section text,
        ordinal int not null,
        content text not null,
        embedding vector(1024) not null
      )`);
      await pool.query("create index if not exists chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops)");
      await pool.query("create index if not exists chunks_doc_idx on chunks (doc_id)");
    },
    async replaceDocument(docId, rows) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("delete from chunks where doc_id = $1", [docId]);
        for (const r of rows) {
          await client.query(
            "insert into chunks (doc_id, title, url, section, ordinal, content, embedding) values ($1,$2,$3,$4,$5,$6,$7)",
            [r.docId, r.title, r.url, r.section, r.ordinal, r.content, pgvector.toSql(r.embedding)],
          );
        }
        await client.query("commit");
        return rows.length;
      } catch (e) {
        await client.query("rollback");
        throw e;
      } finally {
        client.release();
      }
    },
    async nearest(embedding, k) {
      const res = await pool.query(
        `select id, doc_id, title, url, coalesce(section, '') as section, content,
                1 - (embedding <=> $1) as score
         from chunks order by embedding <=> $1 limit $2`,
        [pgvector.toSql(embedding), k],
      );
      return res.rows.map((r) => ({
        id: r.id, docId: r.doc_id, title: r.title, url: r.url, section: r.section, content: r.content, score: Number(r.score),
      }));
    },
    async count() {
      const res = await pool.query("select count(*)::int as n from chunks");
      return res.rows[0].n as number;
    },
    async close() { await pool.end(); },
  };
}
```

- [ ] **Step 2: Create src/store/init.ts**

```ts
import { loadConfig } from "../config.js";
import { makeStore } from "./pg.js";

const cfg = loadConfig();
const store = makeStore(cfg.databaseUrl);
await store.init();
console.log("schema ready; chunks:", await store.count());
await store.close();
```

- [ ] **Step 3: Owner action: create the Neon project**

Sign up at https://neon.tech (Continue with GitHub is fine). Create a project named `security-rag`, region US East. Copy the connection string (it ends in `?sslmode=require`). Create `.env` by copying `.env.example` and paste it as `DATABASE_URL`. Paste the regenerated Cohere key and the Anthropic key too.

- [ ] **Step 4: Run init**

Run: `npm run db:init`
Expected: `schema ready; chunks: 0`. If the TLS handshake fails, change `ssl: { rejectUnauthorized: true }` to `ssl: true` and retry.

- [ ] **Step 5: Commit** (the `.env` file must not appear in `git status`)

```bash
git status --short   # must not list .env
git add src/store && git commit -m "feat: postgres pgvector store with schema init"
```

---

### Task 6: Ingest CLI

**Files:**
- Create: `src/ingest/run.ts`

**Interfaces:**
- Consumes: `chunkMarkdown`, `makeCohere(...).embedDocuments`, `makeStore(...).replaceDocument`.

- [ ] **Step 1: Create src/ingest/run.ts**

```ts
import { readFile } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { chunkMarkdown } from "./chunk.js";
import { makeCohere } from "../vendors/cohere.js";
import { makeStore } from "../store/pg.js";

type Doc = { doc_id: string; title: string; url: string };

const cfg = loadConfig();
const cohere = makeCohere(cfg);
const store = makeStore(cfg.databaseUrl);
const manifest = JSON.parse(await readFile("data/corpus/manifest.json", "utf8")) as { documents: Doc[] };

for (const doc of manifest.documents) {
  const md = await readFile(`data/corpus/${doc.doc_id}.md`, "utf8");
  const chunks = chunkMarkdown(md);
  const embeddings = await cohere.embedDocuments(chunks.map((c) => c.content));
  const n = await store.replaceDocument(
    doc.doc_id,
    chunks.map((c, i) => ({ docId: doc.doc_id, title: doc.title, url: doc.url, section: c.section, ordinal: c.ordinal, content: c.content, embedding: embeddings[i] })),
  );
  console.log(`${doc.doc_id}: ${n} chunks`);
}
console.log("total chunks:", await store.count());
await store.close();
```

- [ ] **Step 2: Run it**

Run: `npm run ingest`
Expected: three `doc_id: N chunks` lines and a total in the low hundreds. Rerunning gives the same total (replace, not append).

- [ ] **Step 3: Commit**

```bash
git add src/ingest/run.ts && git commit -m "feat: ingest CLI (chunk, embed, store)"
```

---

### Task 7: Anthropic adapter (rewrite + generate)

**Files:**
- Create: `src/vendors/anthropic.ts`

**Interfaces:**
- Produces: `makeAnthropic(cfg: Config): Pick<Vendors, "rewrite" | "generate">`. `generate` returns `{ answer, citations: number[] }` where citations are chunk ids the model used; when the sources do not cover the question it returns `answer` starting with `NOT_COVERED:` and empty citations.

- [ ] **Step 1: Create src/vendors/anthropic.ts**

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import type { RetrievedChunk, Vendors } from "../graph/types.js";

const GENERATE_SYSTEM = `You answer security questions using ONLY the provided sources.
Rules:
1. Use only facts present in the sources. No outside knowledge.
2. Cite sources by their numeric id in square brackets, like [12], after each claim.
3. If the sources do not contain the answer, reply with exactly: NOT_COVERED: followed by one sentence saying what the sources do cover.
4. Be concise: 3 to 8 sentences.
Return JSON only: {"answer": string, "citations": number[]} where citations lists every id you cited.`;

const REWRITE_SYSTEM = `Rewrite the user's question as a precise search query using the vocabulary of the OWASP Top 10, the OWASP Top 10 for LLM Applications, and MITRE ATLAS. Return only the rewritten query, one line, no quotes.`;

function textOf(msg: Anthropic.Messages.Message): string {
  return msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("").trim();
}

export function makeAnthropic(cfg: Config): Pick<Vendors, "rewrite" | "generate"> {
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });

  return {
    async rewrite(question) {
      const msg = await client.messages.create({
        model: cfg.generateModel, max_tokens: 100, system: REWRITE_SYSTEM,
        messages: [{ role: "user", content: question }],
      });
      return textOf(msg) || question;
    },
    async generate(question, chunks: RetrievedChunk[]) {
      const sources = chunks.map((c) => `[${c.id}] (${c.title} / ${c.section})\n${c.content}`).join("\n\n");
      const msg = await client.messages.create({
        model: cfg.generateModel, max_tokens: 700, system: GENERATE_SYSTEM,
        messages: [{ role: "user", content: `Sources:\n\n${sources}\n\nQuestion: ${question}` }],
      });
      const raw = textOf(msg);
      const jsonText = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
      try {
        const parsed = JSON.parse(jsonText) as { answer?: unknown; citations?: unknown };
        const answer = typeof parsed.answer === "string" ? parsed.answer : raw;
        const citations = Array.isArray(parsed.citations) ? parsed.citations.filter((n): n is number => Number.isInteger(n)) : [];
        return { answer, citations };
      } catch {
        return { answer: raw, citations: [] };
      }
    },
  };
}
```

- [ ] **Step 2: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/vendors/anthropic.ts && git commit -m "feat: anthropic rewrite and cited-generate adapter"
```

---

### Task 8: Terminal ask (Phase 1 checkpoint)

**Files:**
- Create: `src/ask.ts`

- [ ] **Step 1: Create src/ask.ts** (linear pipeline; the graph replaces it in Phase 2)

```ts
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
```

- [ ] **Step 2: Run the checkpoint**

Run: `npm run ask "What is prompt injection and how do I defend against it?"`
Expected: a short answer with bracketed citations, followed by lines naming OWASP LLM Top 10 / LLM01 sections. **Phase 1 success.**

- [ ] **Step 3: Commit**

```bash
git add src/ask.ts && git commit -m "feat: terminal ask (phase 1 checkpoint)"
```

---

## Phase 2: Graph and evaluation

### Task 9: Rules: grade and verify (OWNER-WRITTEN)

Jon types both functions. They are the two judgment points of the whole system: "is what we found good enough to answer from?" and "did the model only cite what it was given?"

**Files:**
- Create: `src/graph/rules.ts`, `tests/rules.test.ts`

**Interfaces:**
- Produces:
  ```ts
  grade(chunks: RetrievedChunk[], threshold: number): boolean
  verify(citations: number[], chunks: RetrievedChunk[], answer: string): { citations: Citation[]; refused: boolean }
  ```

- [ ] **Step 1: Write the failing tests** at `tests/rules.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { grade, verify } from "../src/graph/rules.js";
import type { RetrievedChunk } from "../src/graph/types.js";

const chunk = (id: number, score: number): RetrievedChunk => ({
  id, docId: "d", title: "T", url: "u", section: "S", content: "some content here", score,
});

describe("grade", () => {
  it("is relevant when the best score meets the threshold", () => {
    expect(grade([chunk(1, 0.3), chunk(2, 0.1)], 0.3)).toBe(true);
  });
  it("is not relevant below the threshold or with no chunks", () => {
    expect(grade([chunk(1, 0.29)], 0.3)).toBe(false);
    expect(grade([], 0.3)).toBe(false);
  });
});

describe("verify", () => {
  it("keeps only citations that point at retrieved chunks", () => {
    const r = verify([1, 99], [chunk(1, 0.5)], "Answer [1].");
    expect(r.citations.map((c) => c.id)).toEqual([1]);
    expect(r.refused).toBe(false);
  });
  it("refuses when the answer is NOT_COVERED", () => {
    const r = verify([], [chunk(1, 0.5)], "NOT_COVERED: sources cover injection only.");
    expect(r.refused).toBe(true);
    expect(r.citations).toEqual([]);
  });
  it("refuses when nothing valid is cited on a normal answer", () => {
    const r = verify([99], [chunk(1, 0.5)], "Confident text with no real source.");
    expect(r.refused).toBe(true);
  });
  it("builds a snippet no longer than 240 characters", () => {
    const long = { ...chunk(1, 0.5), content: "x".repeat(1000) };
    const r = verify([1], [long], "Answer [1].");
    expect(r.citations[0].snippet.length).toBeLessThanOrEqual(240);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npm test -- rules`
Expected: FAIL, module not found.

- [ ] **Step 3: Write src/graph/rules.ts** (reference solution; Jon types it)

```ts
import type { Citation, RetrievedChunk } from "./types.js";

/** Relevant when the single best reranked chunk clears the threshold. */
export function grade(chunks: RetrievedChunk[], threshold: number): boolean {
  if (chunks.length === 0) return false;
  return Math.max(...chunks.map((c) => c.score)) >= threshold;
}

/** Keep only citations the model was actually given; refuse on NOT_COVERED or an uncited answer. */
export function verify(citations: number[], chunks: RetrievedChunk[], answer: string): { citations: Citation[]; refused: boolean } {
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
```

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- rules`
Expected: 6 tests pass.

```bash
git add src/graph/rules.ts tests/rules.test.ts && git commit -m "feat: grade and verify rules"
```

---

### Task 10: LangGraph pipeline

**Files:**
- Create: `src/graph/index.ts`, `tests/graph.test.ts`

**Interfaces:**
- Produces: `buildGraph(deps: { vendors: Vendors; nearest: Store["nearest"]; threshold: number })` returning `{ ask(question: string): Promise<AskResult> }` where
  ```ts
  type AskResult = { answer: string; refused: boolean; rewritten: boolean; sources: Citation[] };
  ```
  The `refused` message is the constant `REFUSAL_MESSAGE = "The sources I have do not cover that question. They cover the OWASP LLM Top 10, the OWASP Top 10, and MITRE ATLAS techniques."`

- [ ] **Step 1: Write the failing tests** at `tests/graph.test.ts` with fake vendors

```ts
import { describe, it, expect } from "vitest";
import { buildGraph, REFUSAL_MESSAGE } from "../src/graph/index.js";
import type { RetrievedChunk, Vendors } from "../src/graph/types.js";

const c = (id: number, score: number): RetrievedChunk => ({ id, docId: "d", title: "T", url: "u", section: "S", content: "c", score });

function fakes(opts: { scores: number[][]; generate?: Vendors["generate"] }) {
  let call = 0;
  const rewrites: string[] = [];
  const vendors: Vendors = {
    embedQuery: async () => [0.1],
    embedDocuments: async (t) => t.map(() => [0.1]),
    rerank: async (_q, docs) => {
      const s = opts.scores[Math.min(call++, opts.scores.length - 1)];
      return docs.slice(0, s.length).map((d, i) => ({ id: d.id, score: s[i] }));
    },
    rewrite: async (q) => { rewrites.push(q); return q + " rewritten"; },
    generate: opts.generate ?? (async () => ({ answer: "Answer [1].", citations: [1] })),
  };
  const nearest = async () => [c(1, 0), c(2, 0), c(3, 0)];
  return { vendors, nearest, rewrites };
}

describe("graph", () => {
  it("answers with sources when retrieval is relevant", async () => {
    const f = fakes({ scores: [[0.9, 0.5]] });
    const r = await buildGraph({ vendors: f.vendors, nearest: f.nearest, threshold: 0.3 }).ask("q");
    expect(r.refused).toBe(false);
    expect(r.rewritten).toBe(false);
    expect(r.sources.map((s) => s.id)).toEqual([1]);
  });
  it("rewrites exactly once, then answers if the retry is relevant", async () => {
    const f = fakes({ scores: [[0.1], [0.8]] });
    const r = await buildGraph({ vendors: f.vendors, nearest: f.nearest, threshold: 0.3 }).ask("q");
    expect(f.rewrites).toEqual(["q"]);
    expect(r.rewritten).toBe(true);
    expect(r.refused).toBe(false);
  });
  it("refuses after one failed rewrite", async () => {
    const f = fakes({ scores: [[0.1], [0.1]] });
    const r = await buildGraph({ vendors: f.vendors, nearest: f.nearest, threshold: 0.3 }).ask("q");
    expect(f.rewrites.length).toBe(1);
    expect(r.refused).toBe(true);
    expect(r.answer).toBe(REFUSAL_MESSAGE);
  });
  it("refuses when the model cites nothing it was given", async () => {
    const f = fakes({ scores: [[0.9]], generate: async () => ({ answer: "made up", citations: [42] }) });
    const r = await buildGraph({ vendors: f.vendors, nearest: f.nearest, threshold: 0.3 }).ask("q");
    expect(r.refused).toBe(true);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npm test -- graph`
Expected: FAIL, module not found.

- [ ] **Step 3: Write src/graph/index.ts**

```ts
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
```

Note: the spec's separate `verify` node is folded into `generate` here because both are pure post-processing of one model call; the behavior (drop invented citations, refuse on none) is identical and tested.

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- graph`
Expected: 4 tests pass.

```bash
git add src/graph/index.ts tests/graph.test.ts && git commit -m "feat: langgraph pipeline with single rewrite retry and refusal"
```

---

### Task 11: Evaluation set and runner (scorer OWNER-WRITTEN)

**Files:**
- Create: `eval/questions.json`, `eval/score.ts`, `eval/run.ts`, `tests/score.test.ts`

**Interfaces:**
- `eval/score.ts` produces `scoreOne(q: EvalQuestion, result: { refused: boolean; sources: { id: number; title: string; section: string }[] }, retrieved: RetrievedChunk[]): { hit: boolean; refusalCorrect: boolean }` and `summarize(rows: {hit:boolean; refusalCorrect:boolean}[]): { hitAt5: number; refusalAccuracy: number }`.
- `EvalQuestion = { question: string; expected_doc_id: string | null; expected_section_keyword: string | null; expect_refusal: boolean }`.

- [ ] **Step 1: Create eval/questions.json** (28 entries)

```json
[
  {"question": "What is prompt injection?", "expected_doc_id": "owasp-llm-top10-2025", "expected_section_keyword": "Prompt Injection", "expect_refusal": false},
  {"question": "How do direct and indirect prompt injection differ?", "expected_doc_id": "owasp-llm-top10-2025", "expected_section_keyword": "Prompt Injection", "expect_refusal": false},
  {"question": "How can an LLM application leak sensitive information?", "expected_doc_id": "owasp-llm-top10-2025", "expected_section_keyword": "Sensitive Information", "expect_refusal": false},
  {"question": "What supply chain risks apply to LLM applications?", "expected_doc_id": "owasp-llm-top10-2025", "expected_section_keyword": "Supply Chain", "expect_refusal": false},
  {"question": "What is data poisoning in the context of language models?", "expected_doc_id": "owasp-llm-top10-2025", "expected_section_keyword": "Poisoning", "expect_refusal": false},
  {"question": "Why is improper output handling dangerous for LLM apps?", "expected_doc_id": "owasp-llm-top10-2025", "expected_section_keyword": "Output Handling", "expect_refusal": false},
  {"question": "What does excessive agency mean for an AI agent?", "expected_doc_id": "owasp-llm-top10-2025", "expected_section_keyword": "Excessive Agency", "expect_refusal": false},
  {"question": "What is system prompt leakage?", "expected_doc_id": "owasp-llm-top10-2025", "expected_section_keyword": "System Prompt", "expect_refusal": false},
  {"question": "What weaknesses affect vector databases and embeddings in RAG systems?", "expected_doc_id": "owasp-llm-top10-2025", "expected_section_keyword": "Embedding", "expect_refusal": false},
  {"question": "How can LLM misinformation harm users?", "expected_doc_id": "owasp-llm-top10-2025", "expected_section_keyword": "Misinformation", "expect_refusal": false},
  {"question": "What is unbounded consumption and how is it mitigated?", "expected_doc_id": "owasp-llm-top10-2025", "expected_section_keyword": "Unbounded Consumption", "expect_refusal": false},
  {"question": "What is broken access control?", "expected_doc_id": "owasp-top10-2021", "expected_section_keyword": "Access Control", "expect_refusal": false},
  {"question": "What are cryptographic failures in web applications?", "expected_doc_id": "owasp-top10-2021", "expected_section_keyword": "Cryptographic", "expect_refusal": false},
  {"question": "How do injection attacks like SQL injection work?", "expected_doc_id": "owasp-top10-2021", "expected_section_keyword": "Injection", "expect_refusal": false},
  {"question": "What is insecure design?", "expected_doc_id": "owasp-top10-2021", "expected_section_keyword": "Insecure Design", "expect_refusal": false},
  {"question": "What counts as a security misconfiguration?", "expected_doc_id": "owasp-top10-2021", "expected_section_keyword": "Misconfiguration", "expect_refusal": false},
  {"question": "Why are vulnerable and outdated components a risk?", "expected_doc_id": "owasp-top10-2021", "expected_section_keyword": "Outdated Components", "expect_refusal": false},
  {"question": "What are identification and authentication failures?", "expected_doc_id": "owasp-top10-2021", "expected_section_keyword": "Authentication", "expect_refusal": false},
  {"question": "What is a software and data integrity failure?", "expected_doc_id": "owasp-top10-2021", "expected_section_keyword": "Integrity", "expect_refusal": false},
  {"question": "Why do logging and monitoring failures matter?", "expected_doc_id": "owasp-top10-2021", "expected_section_keyword": "Logging", "expect_refusal": false},
  {"question": "What is server-side request forgery?", "expected_doc_id": "owasp-top10-2021", "expected_section_keyword": "Request Forgery", "expect_refusal": false},
  {"question": "How do attackers craft adversarial data against machine learning models?", "expected_doc_id": "mitre-atlas", "expected_section_keyword": "Adversarial", "expect_refusal": false},
  {"question": "What does poisoning training data look like as an adversary technique?", "expected_doc_id": "mitre-atlas", "expected_section_keyword": "Poison", "expect_refusal": false},
  {"question": "How might an adversary exfiltrate or steal a machine learning model?", "expected_doc_id": "mitre-atlas", "expected_section_keyword": "Exfiltrat", "expect_refusal": false},
  {"question": "How do adversaries discover an ML model's ontology or family?", "expected_doc_id": "mitre-atlas", "expected_section_keyword": "Discover", "expect_refusal": false},
  {"question": "What is the capital of France?", "expected_doc_id": null, "expected_section_keyword": null, "expect_refusal": true},
  {"question": "How do I change a flat tire on a Honda Civic?", "expected_doc_id": null, "expected_section_keyword": null, "expect_refusal": true},
  {"question": "Write me a poem about autumn.", "expected_doc_id": null, "expected_section_keyword": null, "expect_refusal": true}
]
```

- [ ] **Step 2: Write the failing scorer tests** at `tests/score.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { scoreOne, summarize } from "../eval/score.js";

const retrieved = [
  { id: 1, docId: "owasp-top10-2021", title: "T", url: "u", section: "A03 Injection", content: "", score: 0.9 },
  { id: 2, docId: "mitre-atlas", title: "T", url: "u", section: "AML.T0043 Craft Adversarial Data", content: "", score: 0.4 },
];

describe("scoreOne", () => {
  it("hits when a retrieved chunk matches doc and section keyword", () => {
    const r = scoreOne({ question: "q", expected_doc_id: "owasp-top10-2021", expected_section_keyword: "Injection", expect_refusal: false }, { refused: false, sources: [] }, retrieved);
    expect(r.hit).toBe(true);
    expect(r.refusalCorrect).toBe(true);
  });
  it("misses when the keyword is not in any retrieved section", () => {
    const r = scoreOne({ question: "q", expected_doc_id: "owasp-top10-2021", expected_section_keyword: "Cryptographic", expect_refusal: false }, { refused: false, sources: [] }, retrieved);
    expect(r.hit).toBe(false);
  });
  it("scores refusal correctness against expect_refusal", () => {
    const q = { question: "q", expected_doc_id: null, expected_section_keyword: null, expect_refusal: true };
    expect(scoreOne(q, { refused: true, sources: [] }, retrieved).refusalCorrect).toBe(true);
    expect(scoreOne(q, { refused: false, sources: [] }, retrieved).refusalCorrect).toBe(false);
  });
});

describe("summarize", () => {
  it("averages hit rate over in-corpus rows only and refusal over all rows", () => {
    const s = summarize([
      { hit: true, refusalCorrect: true, inCorpus: true },
      { hit: false, refusalCorrect: true, inCorpus: true },
      { hit: false, refusalCorrect: false, inCorpus: false },
    ]);
    expect(s.hitAt5).toBeCloseTo(0.5);
    expect(s.refusalAccuracy).toBeCloseTo(2 / 3);
  });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `npm test -- score`
Expected: FAIL, module not found.

- [ ] **Step 4: Write eval/score.ts** (reference solution; Jon types it)

```ts
import type { RetrievedChunk } from "../src/graph/types.js";

export type EvalQuestion = { question: string; expected_doc_id: string | null; expected_section_keyword: string | null; expect_refusal: boolean };
export type Row = { hit: boolean; refusalCorrect: boolean; inCorpus: boolean };

export function scoreOne(q: EvalQuestion, result: { refused: boolean }, retrieved: RetrievedChunk[]): Row {
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
```

- [ ] **Step 5: Run scorer tests**

Run: `npm test -- score`
Expected: 4 tests pass.

- [ ] **Step 6: Write eval/run.ts** (real vendors, real database; exposes the retrieved chunks by running retrieval directly, then the full graph for refusal)

```ts
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
```

- [ ] **Step 7: Run the evaluation**

Run: `npm run eval`
Expected: 28 lines and a summary. Target hit@5 at or above 80% and refusal accuracy 100%. If hit@5 is below 80%: first try `maxChars: 2000` in the ingest call to `chunkMarkdown` and re-ingest; then try rerank top 8; then adjust `RELEVANCE_THRESHOLD` if refusals are wrong. Record what you changed and the numbers.

- [ ] **Step 8: Put the numbers in README.md** under a new `## Evaluation` heading

```markdown
## Evaluation

28 hand-written questions (25 in-corpus, 3 that must be refused), scored by `npm run eval`.

| Metric | Result | Date |
|---|---|---|
| Retrieval hit@5 | NN% | 2026-09-0X |
| Refusal accuracy | NN% | 2026-09-0X |
```

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat: evaluation set, scorer, and runner with recorded results"
```

---

## Phase 3: API, tests, container

### Task 12: Hono app

**Files:**
- Create: `src/server/app.ts`, `tests/app.test.ts`

**Interfaces:**
- Produces: `makeApp(deps: { ask(q: string): Promise<AskResult>; count(): Promise<number>; html: string; now?: () => number }): Hono`.

- [ ] **Step 1: Write the failing tests** at `tests/app.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { makeApp } from "../src/server/app.js";

const ok = { answer: "A [1].", refused: false, rewritten: false, sources: [] };
function app(overrides: Partial<Parameters<typeof makeApp>[0]> = {}) {
  return makeApp({ ask: async () => ok, count: async () => 5, html: "<h1>demo</h1>", ...overrides });
}
const post = (a: ReturnType<typeof app>, body: unknown, ip = "1.1.1.1") =>
  a.request("/ask", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": ip } });

describe("app", () => {
  it("serves the demo page and health", async () => {
    expect(await (await app().request("/")).text()).toContain("demo");
    expect(await (await app().request("/health")).json()).toEqual({ ok: true, chunks: 5 });
  });
  it("answers a valid question", async () => {
    const res = await post(app(), { question: "What is prompt injection?" });
    expect(res.status).toBe(200);
    expect((await res.json()).answer).toBe("A [1].");
  });
  it("rejects empty, too long, and non-string questions with 400", async () => {
    expect((await post(app(), { question: "" })).status).toBe(400);
    expect((await post(app(), { question: "x".repeat(501) })).status).toBe(400);
    expect((await post(app(), { question: 7 })).status).toBe(400);
  });
  it("rate limits the 11th request per minute per IP", async () => {
    const a = app();
    for (let i = 0; i < 10; i++) expect((await post(a, { question: "q" })).status).toBe(200);
    expect((await post(a, { question: "q" })).status).toBe(429);
    expect((await post(a, { question: "q" }, "2.2.2.2")).status).toBe(200);
  });
  it("returns 502 when the pipeline throws a vendor error", async () => {
    const a = app({ ask: async () => { throw new Error("vendor: cohere timeout"); } });
    expect((await post(a, { question: "q" })).status).toBe(502);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npm test -- app`
Expected: FAIL, module not found.

- [ ] **Step 3: Write src/server/app.ts**

```ts
import { Hono } from "hono";
import { z } from "zod";
import type { AskResult } from "../graph/index.js";

const Body = z.object({ question: z.string().min(1).max(500) });
const LIMIT = 10;
const WINDOW_MS = 60_000;

export function makeApp(deps: { ask(q: string): Promise<AskResult>; count(): Promise<number>; html: string; now?: () => number }) {
  const now = deps.now ?? (() => Date.now());
  const hits = new Map<string, number[]>();
  const app = new Hono();

  app.get("/", (c) => c.html(deps.html));
  app.get("/health", async (c) => c.json({ ok: true, chunks: await deps.count() }));

  app.post("/ask", async (c) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() || "unknown";
    const t = now();
    const recent = (hits.get(ip) ?? []).filter((x) => t - x < WINDOW_MS);
    if (recent.length >= LIMIT) return c.json({ error: "Rate limit: 10 questions per minute." }, 429);
    hits.set(ip, [...recent, t]);

    const parsed = Body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Body must be { question: string } with 1 to 500 characters." }, 400);

    try {
      const result = await deps.ask(parsed.data.question);
      return c.json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      console.log(JSON.stringify({ level: "error", event: "ask_failed", message: msg.slice(0, 200) }));
      if (/database|connect|ECONN/i.test(msg)) return c.json({ error: "The knowledge store is unavailable right now." }, 503);
      return c.json({ error: "An upstream model service failed. Please try again." }, 502);
    }
  });

  return app;
}
```

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- app`
Expected: 5 tests pass. (Rate-limit test issues 11 requests quickly; all inside one window.)

```bash
git add src/server/app.ts tests/app.test.ts && git commit -m "feat: hono api with validation, rate limit, and error mapping"
```

---

### Task 13: Demo page and local server

**Files:**
- Create: `public/index.html`, `src/server/local.ts`, `src/server/wire.ts`

**Interfaces:**
- `src/server/wire.ts` produces `wire(): { app: Hono; close(): Promise<void> }` building real vendors, store, graph, and the app; used by local and Lambda entries.

- [ ] **Step 1: Create public/index.html**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>security-rag</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 760px; margin: 40px auto; padding: 0 16px; color: #1a1a1a; }
  h1 { font-size: 22px; } textarea { width: 100%; height: 80px; font: inherit; padding: 8px; }
  button { padding: 8px 16px; font: inherit; cursor: pointer; } #answer { white-space: pre-wrap; margin-top: 16px; }
  .src { border-left: 3px solid #999; padding: 6px 10px; margin: 8px 0; font-size: 14px; } .muted { color: #666; }
</style>
</head>
<body>
<h1>security-rag</h1>
<p class="muted">Answers grounded in the OWASP LLM Top 10, the OWASP Top 10, and MITRE ATLAS. Cites its sources or says it cannot.</p>
<textarea id="q" placeholder="What is prompt injection and how do I defend against it?"></textarea>
<p><button id="go">Ask</button></p>
<div id="answer"></div>
<div id="sources"></div>
<script>
  const q = document.getElementById("q"), go = document.getElementById("go");
  const answer = document.getElementById("answer"), sources = document.getElementById("sources");
  go.onclick = async () => {
    answer.textContent = "Thinking..."; sources.innerHTML = "";
    const res = await fetch("/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: q.value }) });
    const data = await res.json();
    if (!res.ok) { answer.textContent = data.error || "Request failed."; return; }
    answer.textContent = data.answer + (data.rewritten ? "\n\n(The question was rewritten once to match the sources.)" : "");
    for (const s of data.sources) {
      const d = document.createElement("div"); d.className = "src";
      d.innerHTML = `<strong>[${s.id}]</strong> <a href="${s.url}" target="_blank" rel="noopener">${s.title}</a>: ${s.section} <span class="muted">(${s.score.toFixed(2)})</span><br>${s.snippet}`;
      sources.appendChild(d);
    }
  };
</script>
</body>
</html>
```

- [ ] **Step 2: Create src/server/wire.ts**

```ts
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
```

- [ ] **Step 3: Create src/server/local.ts**

```ts
import { serve } from "@hono/node-server";
import { wire } from "./wire.js";

const { app } = wire();
serve({ fetch: app.fetch, port: 3000 }, () => console.log("security-rag on http://localhost:3000"));
```

- [ ] **Step 4: Run it and try the page**

Run: `npm run dev`
Then open http://localhost:3000, ask "What is excessive agency?", expect an answer with sources. Try "What is the capital of France?" and expect the refusal message. Stop with Ctrl+C.

- [ ] **Step 5: Commit**

```bash
git add public src/server && git commit -m "feat: demo page and local server"
```

---

### Task 14: Lambda entry and Dockerfile (Dockerfile OWNER-WRITTEN)

**Files:**
- Create: `src/server/lambda.ts`, `Dockerfile`, `.dockerignore`

- [ ] **Step 1: Create src/server/lambda.ts**

```ts
import { handle } from "hono/aws-lambda";
import { wire } from "./wire.js";

const { app } = wire();
export const handler = handle(app);
```

- [ ] **Step 2: Build once to confirm the output path**

Run: `npm run build && ls dist/src/server`
Expected: `lambda.js` present (the handler path below depends on it).

- [ ] **Step 3: Write Dockerfile** (reference solution; Jon types it; the assistant explains multi-stage builds: build with the full toolchain, ship only the runtime)

```dockerfile
# Stage 1: compile TypeScript with dev dependencies
FROM public.ecr.aws/lambda/nodejs:22 AS build
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY eval ./eval
COPY scripts ./scripts
COPY tests ./tests
RUN npm run build

# Stage 2: runtime image with production dependencies only
FROM public.ecr.aws/lambda/nodejs:22
WORKDIR ${LAMBDA_TASK_ROOT}
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /build/dist ./dist
COPY public ./public
CMD ["dist/src/server/lambda.handler"]
```

`.dockerignore`:
```
node_modules
dist
.env
.git
data/corpus/*.md
```

- [ ] **Step 4: Build and run locally with the Lambda runtime emulator**

Run:
```bash
docker build -t security-rag .
docker run --rm -p 9000:8080 --env-file .env security-rag
```
In a second terminal, call the emulator with a function-URL-shaped event:
```bash
curl -s -X POST "http://localhost:9000/2015-03-31/functions/function/invocations" -d "{\"version\":\"2.0\",\"routeKey\":\"$default\",\"rawPath\":\"/health\",\"rawQueryString\":\"\",\"headers\":{},\"requestContext\":{\"http\":{\"method\":\"GET\",\"path\":\"/health\",\"sourceIp\":\"127.0.0.1\"}},\"isBase64Encoded\":false}"
```
Expected: a JSON envelope whose body contains `{"ok":true,"chunks":N}`. **Phase 3 success.** Stop the container with Ctrl+C.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore src/server/lambda.ts && git commit -m "feat: lambda handler and multi-stage container"
```

---

### Task 15: CI and secrets scan

**Files:**
- Create: `.github/workflows/ci.yml`, `scripts/secrets_scan.py` (copy from `../security-lab/tools/secrets_scan.py`, keep its header comment, add one line crediting the origin repo)

- [ ] **Step 1: Copy the scanner and run it locally**

Run:
```bash
cp "../security-lab/tools/secrets_scan.py" scripts/secrets_scan.py
python scripts/secrets_scan.py .
```
Expected: no findings (the `.env` file is excluded by its own rules or by being gitignored; if it flags `.env`, add `.env` to the scanner's ignore list in the copied script).

- [ ] **Step 2: Create .github/workflows/ci.yml**

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: python scripts/secrets_scan.py .
```

- [ ] **Step 3: Create the GitHub repository and push**

Owner action: create an empty public repo `jon659/security-rag` on GitHub (no README, no license, no gitignore). Then:
```bash
git remote add origin https://github.com/jon659/security-rag.git
git push -u origin main
```
Expected: the `ci` workflow runs green on GitHub within a few minutes.

- [ ] **Step 4: Commit the workflow** (if not already included in the push)

```bash
git add .github scripts/secrets_scan.py && git commit -m "ci: typecheck, lint, test, secrets scan" && git push
```

---

## Phase 4: Cloud

### Task 16: One-time AWS setup script

**Files:**
- Create: `infra/setup.sh`, `infra/README.md`

Owner prerequisites: an AWS account (https://aws.amazon.com/free), then an IAM user with AdministratorAccess for daily use, MFA on both, and the AWS CLI installed and configured (`aws configure`). Never use the root user for the CLI.

- [ ] **Step 1: Create infra/setup.sh** (run once from a terminal that has the AWS CLI configured; idempotent where the CLI allows)

```bash
#!/usr/bin/env bash
# One-time AWS setup for security-rag. Run: bash infra/setup.sh
set -euo pipefail
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REPO="security-rag"
FUNC="security-rag"
GH_REPO="jon659/security-rag"

echo "account=$ACCOUNT region=$REGION"

# 1. ECR repository for the image
aws ecr describe-repositories --repository-names "$REPO" --region "$REGION" >/dev/null 2>&1 || \
  aws ecr create-repository --repository-name "$REPO" --region "$REGION" >/dev/null
echo "ecr ok"

# 2. Lambda execution role
cat > /tmp/lambda-trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF
aws iam get-role --role-name "$FUNC-exec" >/dev/null 2>&1 || \
  aws iam create-role --role-name "$FUNC-exec" --assume-role-policy-document file:///tmp/lambda-trust.json >/dev/null
aws iam attach-role-policy --role-name "$FUNC-exec" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
echo "exec role ok"

# 3. Placeholder image so the function can be created (deploy.yml replaces it)
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
docker build -t "$REPO" .
docker tag "$REPO:latest" "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$REPO:latest"
docker push "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$REPO:latest"

# 4. Lambda function from the image, with environment from .env
ENVJSON=$(node -e 'const e=require("dotenv").config({path:".env"}).parsed;console.log(JSON.stringify({Variables:e}))')
if ! aws lambda get-function --function-name "$FUNC" --region "$REGION" >/dev/null 2>&1; then
  sleep 10
  aws lambda create-function --function-name "$FUNC" --package-type Image \
    --code ImageUri="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$REPO:latest" \
    --role "arn:aws:iam::$ACCOUNT:role/$FUNC-exec" --timeout 60 --memory-size 1024 \
    --environment "$ENVJSON" --region "$REGION" >/dev/null
  aws lambda wait function-active --function-name "$FUNC" --region "$REGION"
fi
aws lambda create-function-url-config --function-name "$FUNC" --auth-type NONE --region "$REGION" >/dev/null 2>&1 || true
aws lambda add-permission --function-name "$FUNC" --statement-id url-public --action lambda:InvokeFunctionUrl \
  --principal "*" --function-url-auth-type NONE --region "$REGION" >/dev/null 2>&1 || true
URL=$(aws lambda get-function-url-config --function-name "$FUNC" --region "$REGION" --query FunctionUrl --output text)
echo "function url: $URL"

# 5. GitHub OIDC provider and deploy role
aws iam list-open-id-connect-providers --query "OpenIDConnectProviderList[?contains(Arn,'token.actions.githubusercontent.com')]" --output text | grep -q githubusercontent || \
  aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com >/dev/null
cat > /tmp/deploy-trust.json <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Federated":"arn:aws:iam::$ACCOUNT:oidc-provider/token.actions.githubusercontent.com"},
 "Action":"sts:AssumeRoleWithWebIdentity","Condition":{"StringEquals":{"token.actions.githubusercontent.com:aud":"sts.amazonaws.com"},
 "StringLike":{"token.actions.githubusercontent.com:sub":"repo:$GH_REPO:ref:refs/heads/main"}}}]}
EOF
cat > /tmp/deploy-policy.json <<EOF
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["ecr:GetAuthorizationToken"],"Resource":"*"},
 {"Effect":"Allow","Action":["ecr:BatchCheckLayerAvailability","ecr:CompleteLayerUpload","ecr:InitiateLayerUpload","ecr:PutImage","ecr:UploadLayerPart","ecr:BatchGetImage","ecr:GetDownloadUrlForLayer"],"Resource":"arn:aws:ecr:$REGION:$ACCOUNT:repository/$REPO"},
 {"Effect":"Allow","Action":["lambda:UpdateFunctionCode","lambda:GetFunction"],"Resource":"arn:aws:lambda:$REGION:$ACCOUNT:function:$FUNC"}]}
EOF
aws iam get-role --role-name "$FUNC-deploy" >/dev/null 2>&1 || \
  aws iam create-role --role-name "$FUNC-deploy" --assume-role-policy-document file:///tmp/deploy-trust.json >/dev/null
aws iam put-role-policy --role-name "$FUNC-deploy" --policy-name deploy --policy-document file:///tmp/deploy-policy.json
echo "deploy role: arn:aws:iam::$ACCOUNT:role/$FUNC-deploy"

echo
echo "Set these GitHub repository variables (Settings > Secrets and variables > Actions > Variables):"
echo "  AWS_ACCOUNT_ID=$ACCOUNT"
echo "  AWS_REGION=$REGION"
echo "  FUNCTION_URL=$URL"
```

- [ ] **Step 2: Create infra/README.md**

```markdown
# Infra

One-time setup: `bash infra/setup.sh` from a shell with the AWS CLI configured as an IAM user (not root) and Docker running. It creates the ECR repository, the Lambda execution role, the function with a public function URL, the GitHub OIDC provider, and a deploy role trusted only by pushes to `main` of `jon659/security-rag`. It prints three values to set as GitHub repository variables. Secrets never leave `.env` and the Lambda environment.

Ongoing deploys are `.github/workflows/deploy.yml` on every push to `main`.
```

- [ ] **Step 3: Run the setup (owner, once)**

Run: `bash infra/setup.sh`
Expected: ends with `function url: https://....lambda-url.us-east-1.on.aws/` and the three variables. Set them in GitHub. Then `curl <URL>/health` returns `{"ok":true,"chunks":N}`.

- [ ] **Step 4: Commit**

```bash
git add infra && git commit -m "infra: one-time AWS setup script and docs" && git push
```

---

### Task 17: Deploy workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: deploy
on:
  workflow_run:
    workflows: [ci]
    types: [completed]
    branches: [main]
permissions:
  id-token: write
  contents: read
jobs:
  deploy:
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    runs-on: ubuntu-latest
    env:
      REGION: ${{ vars.AWS_REGION }}
      ACCOUNT: ${{ vars.AWS_ACCOUNT_ID }}
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::${{ vars.AWS_ACCOUNT_ID }}:role/security-rag-deploy
          aws-region: ${{ vars.AWS_REGION }}
      - uses: aws-actions/amazon-ecr-login@v2
      - name: Build and push
        run: |
          IMAGE=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/security-rag:${{ github.sha }}
          docker build -t "$IMAGE" .
          docker push "$IMAGE"
          echo "IMAGE=$IMAGE" >> "$GITHUB_ENV"
      - name: Update function
        run: |
          aws lambda update-function-code --function-name security-rag --image-uri "$IMAGE" --region "$REGION" >/dev/null
          aws lambda wait function-updated --function-name security-rag --region "$REGION"
      - name: Health check
        run: |
          curl -fsS "${{ vars.FUNCTION_URL }}health" | grep -q '"ok":true'
```

- [ ] **Step 2: Push and watch**

```bash
git add .github/workflows/deploy.yml && git commit -m "ci: deploy to lambda on green main" && git push
```
Expected: `ci` runs green, then `deploy` runs green, and the function URL answers from a phone browser. **Phase 4 success.**

- [ ] **Step 3: Finish the README**

Add under the title: the demo URL, an architecture paragraph (the graph in words), the evaluation table from Task 11, and a "How it was built" section naming the stack. Then:
```bash
git add README.md && git commit -m "docs: demo url, architecture, results" && git push
```

---

### Task 18: Put it on the resume (career-ops)

- [ ] **Step 1:** In the career-ops project, run the `add` flow for a project entry: name "security-rag", one sentence with the stack, the eval numbers, and the demo URL; confirm the wording; it lands in `cv.md` Projects.
- [ ] **Step 2:** Regenerate the tailored resumes (the regen script) and re-run the fact gate; the new bullet must trace to cv.md.
- [ ] **Step 3:** Send the Cohere application with the updated resume; the packet in `career-ops/interview-prep/cohere-fde.md` gets a new bullet in its letter: "Last week I shipped a retrieval system on Cohere embeddings and rerank with a LangGraph retry loop; retrieval hit@5 NN% on a hand-written eval set."

---

## Self-review notes

- Spec coverage: every section 3 decision has a task; the verify node is folded into generate (Task 10 note) with identical tested behavior; rate limiting, error mapping, health check, demo page, eval, CI, OIDC deploy, and provenance are all present.
- Type consistency: `Vendors`, `RetrievedChunk`, `Citation`, `AskResult`, `Store`, `InsertRow`, `EvalQuestion`, `Row` are defined once and used by name everywhere.
- Known drift risks: Cohere and LangGraph JS API names may have moved since this plan was written; each is isolated to one file and caught by `npm run typecheck`.
