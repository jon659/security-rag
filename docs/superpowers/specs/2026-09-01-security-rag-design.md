# security-rag: Design Spec

**Date:** 2026-09-01 · **Owner:** Jonathan Harrison · **Status:** approved in brainstorm, pending written review

## 1. What this is

A question-answering service for AI and application security. You ask a security question, the service looks up the relevant passages in a corpus of public security references (OWASP LLM Top 10, OWASP Top 10, MITRE ATLAS), and answers using only those passages, with citations. If the corpus does not contain the answer, it says so instead of guessing.

It exists to close four specific gaps on a job search (TypeScript, retrieval-augmented generation with a real vector database, a containerized service deployed to AWS through CI/CD, and LangGraph), and to be a live demo the owner can pull up in an interview.

## 2. Non-goals (YAGNI)

- No chat history or multi-turn conversation. One question, one answer.
- No user accounts, no auth beyond rate limiting.
- No streaming responses.
- No admin UI. Ingestion is a command-line script run locally.
- No Terraform/CDK. One-time AWS setup is a documented shell script; ongoing deploys are CI.
- No fine-tuning, no custom models.

## 3. Decisions (locked in brainstorm)

| Decision | Choice | Why |
|---|---|---|
| Purpose / corpus | Public security references: OWASP Top 10 for LLM Applications, OWASP Top 10, MITRE ATLAS | On-brand, public data, interview-demoable |
| Language | TypeScript on Node 22 (ESM) | Closes the JavaScript gap the LangChain JD names |
| Orchestration | LangGraph (`@langchain/langgraph`) | The retry loop below is the honest reason to use a graph |
| Embeddings + rerank | Cohere (`cohere-ai` SDK): current embed model (embed-v4.0 at time of writing, 1024 dims) and rerank-v3.5 | Rerank is a real quality lever; owner is applying to Cohere |
| Generation | Claude via `@anthropic-ai/sdk`, Sonnet tier | Cheap, capable, continuity with the owner's Agent SDK repo |
| Vector store | Postgres + pgvector on Neon (free tier) | The enterprise-recognized answer to "what vector database" |
| HTTP framework | Hono (has a Lambda adapter) | Tiny, typed, runs identically locally and on Lambda |
| Hosting | AWS Lambda from a Docker image, function URL | Free at demo volume; "containerized service on AWS" |
| CI/CD | GitHub Actions: test on PR, build + push to ECR + deploy on main, AWS auth via OIDC | No long-lived AWS keys in GitHub |
| Interface | `POST /ask` API plus one static demo page | Demo in a screen share; no chat UI |
| Tests | Vitest, hermetic (no network), vendors mocked | Same discipline as the owner's security-lab suite |
| Evaluation | 25-question eval set, retrieval hit@5 and citation validity, target 0.80 or better | The "evaluation framework" job descriptions ask for |

## 4. Architecture

Two separate processes share one database.

**Ingest (run locally, once per corpus change):**
`data/corpus/*.md` → chunker → Cohere embed → rows in Postgres `chunks` table.

**Serve (the deployed Lambda):**
question → LangGraph pipeline → JSON answer with citations.

### 4.1 The LangGraph pipeline

State carried through the graph:

```
question: string            the user's question
query: string               the query actually used for retrieval (starts equal to question)
chunks: RetrievedChunk[]    top results after rerank, each with a relevance score
retries: number             how many times the query has been rewritten (max 1)
relevant: boolean           the grade decision
answer: string
citations: Citation[]
refused: boolean
```

Nodes and edges:

```
retrieve  -> grade
grade     -> generate        if relevant
grade     -> rewrite         if not relevant and retries < 1
grade     -> refuse          if not relevant and retries >= 1
rewrite   -> retrieve
generate  -> verify
verify    -> END
refuse    -> END
```

- **retrieve:** embed `query` with Cohere, fetch the 20 nearest chunks from Postgres by cosine distance, send those 20 to Cohere rerank, keep the top 5 with their rerank scores.
- **grade:** `relevant = best rerank score >= THRESHOLD` (start at 0.30; the eval set tunes it). Pure function, no model call.
- **rewrite:** ask Claude for a single reformulation of the question aimed at the corpus vocabulary ("prompt injection" for "someone tricking my chatbot"). Increment `retries`.
- **generate:** ask Claude to answer strictly from the chunks and return structured JSON: `{ answer, citations: [chunkId, ...] }`. The system prompt forbids outside knowledge and requires "The provided sources do not cover this" when appropriate.
- **verify:** drop any cited chunkId that is not in `chunks` (a model cannot invent a citation). If generate cited nothing and the answer is not an explicit "not covered," mark `refused = true` with a fixed message. Pure function.
- **refuse:** return the fixed honest message: the corpus does not cover the question, plus the top retrieved titles so the user can see what was searched.

### 4.2 Components (each testable alone)

| Component | File | Does | Depends on |
|---|---|---|---|
| Chunker | `src/ingest/chunk.ts` | Splits a markdown document into chunks of about 800 tokens with 100-token overlap, splitting on headings first; records section title | nothing |
| Embedder | `src/vendors/cohere.ts` | `embed(texts[]) -> number[][]`, `rerank(query, docs[]) -> scored[]` | Cohere SDK, `COHERE_API_KEY` |
| Store | `src/store/pg.ts` | `insertChunks`, `nearest(embedding, k)`; owns the schema and HNSW index | `pg`, `pgvector`, `DATABASE_URL` |
| LLM | `src/vendors/anthropic.ts` | `rewrite(question)`, `generate(question, chunks) -> {answer, citations}` | Anthropic SDK, `ANTHROPIC_API_KEY` |
| Graph | `src/graph/index.ts` | Builds the LangGraph above from injected vendor functions | LangGraph, the four above |
| Grade + Verify | `src/graph/rules.ts` | The two pure functions | nothing |
| API | `src/server/app.ts` | Hono app: `POST /ask`, `GET /health`, `GET /` static page; zod validation; rate limit | Hono, zod, Graph |
| Lambda entry | `src/server/lambda.ts` | Wraps the Hono app for Lambda | `hono/aws-lambda` |
| Local entry | `src/server/local.ts` | Runs the Hono app on localhost:3000 | `@hono/node-server` |
| Ingest CLI | `src/ingest/run.ts` | Reads `data/corpus/`, chunks, embeds, writes to Postgres | Chunker, Embedder, Store |
| Eval CLI | `eval/run.ts` | Runs `eval/questions.json` through retrieve+rerank, reports hit@5 and citation validity | Graph pieces |

Vendor functions are injected into the graph builder so tests run with fakes and never touch the network.

### 4.3 Data model

One table:

```
chunks (
  id          serial primary key,
  doc_id      text not null,        e.g. "owasp-llm-top10-2025"
  title       text not null,        document title
  url         text not null,        canonical public URL
  section     text,                 nearest heading
  ordinal     int not null,         position within the document
  content     text not null,
  embedding   vector(1024) not null
)
create index on chunks using hnsw (embedding vector_cosine_ops);
```

Corpus provenance lives in `data/corpus/SOURCES.md`: each document's title, URL, license, and the date it was fetched. All three sources are published under licenses that permit this use; the file records them.

### 4.4 API contract

`POST /ask` body: `{ "question": string }` (1 to 500 characters).

Response 200:

```json
{
  "answer": "...",
  "refused": false,
  "rewritten": false,
  "sources": [
    { "id": 42, "title": "OWASP Top 10 for LLM Applications", "section": "LLM01: Prompt Injection", "url": "...", "snippet": "...", "score": 0.87 }
  ]
}
```

- 400 on invalid input, 429 when the per-IP limit (10 requests per minute, in memory) is exceeded, 502 when a vendor call fails after one retry, 503 when the store is unreachable.
- `GET /health` returns `{ ok: true, chunks: <count> }` and is what the deploy job checks after deploying.
- `GET /` serves `public/index.html`: a text box, a button, the answer, and the sources list. No framework.

### 4.5 Error handling

- Every vendor call: one retry with backoff on 5xx or timeout, then fail the request with 502 and a message that names the vendor, never the key.
- The graph never throws to the client; any node failure becomes a refused answer with a generic message and a structured log line.
- Logs are single-line JSON (question hash, node timings, chunk ids, refused flag). No question text in logs at INFO level.
- Ingest is idempotent per `doc_id`: it deletes that document's rows before re-inserting.

### 4.6 Secrets and configuration

Local: `.env` (gitignored) created by copying `.env.example`. Keys: `COHERE_API_KEY`, `ANTHROPIC_API_KEY`, `DATABASE_URL`, `RELEVANCE_THRESHOLD` (default 0.30), `EMBED_MODEL`, `RERANK_MODEL`, `GENERATE_MODEL`.

CI: the same three secrets stored as GitHub Actions secrets. AWS access through an OIDC-federated IAM role scoped to this repository; no AWS access keys anywhere. Lambda reads its secrets from its environment configuration, set once by the setup script.

The repo ships the owner's own secrets scanner (from security-lab) as a pre-commit check.

## 5. Evaluation

`eval/questions.json`: 28 entries, each `{ question, expected_doc_id, expected_section_keyword, expect_refusal }`, written by hand: 25 in-corpus questions spread across the three documents, plus 3 deliberately out-of-corpus questions that must be refused.

`npm run eval` reports:

- retrieval hit@5: fraction of questions where a chunk from the expected document and section is in the top 5 after rerank
- refusal accuracy: the 3 out-of-corpus questions are refused, the 25 in-corpus ones are not
- citation validity: every citation in every answer points at a retrieved chunk (should be 100% by construction)

Target: hit@5 at or above 0.80 and refusal accuracy 28/28. The number and the date go in the README. Tuning levers, in order: chunk size, rerank top-k, threshold.

## 6. Testing

Vitest, no network, no database in unit tests:

- chunker: deterministic splits, heading capture, overlap, empty input
- rules: grade threshold boundaries; verify drops unknown citations and flags empty citation sets
- API: validation (empty, too long, wrong type), rate limit, response shape, with the graph replaced by a fake
- graph wiring: with fake vendors, the retry loop runs exactly once and the refuse path triggers

One integration smoke test (`npm run smoke`) hits the real vendors and database; it is run manually and in the deploy job against the deployed URL, not in unit CI.

## 7. Deployment and CI

`.github/workflows/ci.yml`: on pull request and push, install, typecheck, lint, test.

`.github/workflows/deploy.yml`: on push to main after CI passes: assume the OIDC role, build the Docker image (`public.ecr.aws/lambda/nodejs:22` base), push to ECR, update the Lambda function code, wait for the update, call `GET /health` on the function URL and fail the job if it is not ok.

`infra/setup.sh` (run once by the owner, documented step by step): create the ECR repository, the Lambda execution role, the Lambda function with a function URL (auth NONE, since the app rate-limits), the GitHub OIDC identity provider, and the deploy role trusted only by `repo:jon659/security-rag:ref:refs/heads/main`. Prints the values to paste into GitHub repository variables.

## 8. Repo layout

```
security-rag/
  README.md                results table, architecture diagram, how to run, demo URL
  .env.example
  .gitignore               .env, node_modules, dist
  package.json             scripts: dev, build, test, lint, typecheck, ingest, eval, smoke
  tsconfig.json
  Dockerfile
  data/corpus/             the three source documents as markdown + SOURCES.md
  eval/questions.json  eval/run.ts
  infra/setup.sh
  public/index.html
  src/ingest/  src/vendors/  src/store/  src/graph/  src/server/
  tests/
  .github/workflows/ci.yml  deploy.yml
  docs/superpowers/specs/   this file
```

## 9. Build phases and success criteria

1. **Local RAG works.** Ingest runs, `chunks` has rows, a terminal script answers "what is prompt injection" with a correct citation. Success: one cited answer from the terminal.
2. **Graph and eval.** LangGraph pipeline with the retry loop; eval script reports numbers. Success: hit@5 >= 0.80, refusals 3/3.
3. **API, tests, container.** Hono API and demo page; unit tests green; Docker image runs locally and answers. Success: `docker run` on the laptop serves a cited answer.
4. **Cloud.** AWS setup script run once; CI deploys on push; function URL answers from the public internet. Success: the URL in the README works from a phone.

After phase 4: add the project to cv.md through the career-ops `add` flow, regenerate the tailored resumes, and send the Cohere application.

## 10. Authorship plan (who writes what)

The owner writes, with guidance, the pieces an interviewer will ask him to explain: the chunker, the two pure rule functions (grade, verify), the eval scorer, and the Dockerfile. The assistant scaffolds structure, vendor adapters, the LangGraph wiring, the server plumbing, and CI, walking through each file as it lands. Every file the owner did not write gets read aloud once before it is committed.

## 11. Accounts and prerequisites (owner actions)

Cohere API key (regenerated, never pasted into chat), Anthropic API key, Neon project (copy the connection string), AWS account (root email plus card; then an IAM admin user for daily use, MFA on both), Node 22, Docker Desktop, GitHub CLI optional.
