# security-rag

Ask an AI or application security question. Get an answer grounded in the OWASP LLM Top 10, the OWASP Top 10, and MITRE ATLAS, with citations. If the sources don't cover it, the service says so instead of guessing.

## How it answers

1. Retrieve the top candidate chunks for the question from a pgvector index.
2. Grade the top result against a relevance threshold.
3. If it's below threshold, rewrite the question once and retry retrieval.
4. Generate an answer from the retrieved chunks, with numbered citations.
5. Verify every citation actually points at a retrieved chunk.
6. If nothing relevant was found (even after the rewrite), refuse and say what the sources do cover instead.

## Status

Not yet done:

- Live evaluation numbers are pending API credit (see Evaluation below).
- The container image builds in CI but hasn't been deployed anywhere.
- Phase 4 (AWS deploy) hasn't started.
- hit@5, as currently scored, measures first-pass retrieval only, before any rewrite step runs. A question the rewrite step rescues won't show up as a hit@5 win.

## Run locally

Requires Node 22 or newer.

1. Copy `.env.example` to `.env` and fill in the keys.
2. `npm install`
3. `npm run db:init` then `npm run ingest`
4. `npm run ask "What is prompt injection?"`
5. `npm run dev` serves the same pipeline over HTTP on port 3000, with a small demo page at `/`.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `COHERE_API_KEY` | yes | none | Used for embeddings and reranking. |
| `ANTHROPIC_API_KEY` | yes | none | Used for query rewriting and answer generation. |
| `DATABASE_URL` | yes | none | Postgres connection string; needs the `pgvector` extension. |
| `RELEVANCE_THRESHOLD` | no | `0.3` | Minimum reranked score to accept a chunk as relevant. |
| `EMBED_MODEL` | no | `embed-v4.0` | Cohere embedding model. |
| `RERANK_MODEL` | no | `rerank-v3.5` | Cohere rerank model. |
| `GENERATE_MODEL` | no | `claude-sonnet-5` | Anthropic model for rewrite and generate. |

## Scripts

| Script | Needs |
|---|---|
| `npm run typecheck` | nothing |
| `npm run lint` | nothing |
| `npm test` | nothing (no network calls, no database) |
| `npm run build` | nothing |
| `npm run fetch-corpus` | nothing (fetches the public OWASP/MITRE source pages) |
| `npm run db:init` | database |
| `npm run ingest` | database, API credit (embeddings) |
| `npm run ask` | database, API credit |
| `npm run eval` | database, API credit |
| `npm run dev` | database, API credit |

## API

### `POST /ask`

Request body: `{ "question": string }`, 1 to 500 characters.

Response body: `{ "answer": string, "refused": boolean, "rewritten": boolean, "sources": Citation[] }`.

Status codes:

- `400`: the body didn't match the contract above.
- `429`: rate limited. The limit is 10 requests per minute per client, tracked per running container instance, not globally. Behind N concurrent instances, the effective ceiling is 10 times N per minute.
- `502`: an upstream model call (Cohere or Anthropic) failed.
- `503`: the knowledge store (Postgres) is unavailable.

### `GET /health`

Returns `{ "ok": true, "chunks": number }` on success, or `{ "ok": false }` with a `503` status if the chunk count can't be read.

## Evaluation

28 hand-written questions (25 in-corpus, 3 that must be refused), scored by `npm run eval`.

| Metric | Result | Date |
|---|---|---|
| Retrieval hit@5 | pending | 2026-09-02 |
| Refusal accuracy | pending | 2026-09-02 |

`npm run eval` currently fails before scoring any question: the Anthropic account has no API credit (`BadRequestError: 400 ... "Your credit balance is too low to access the Anthropic API."`). Retrieval and the scorer are implemented and unit-tested; the numbers above will be filled in once the eval run completes against live vendors.

## Deploy shape

The `Dockerfile` is a multi-stage build on the AWS Lambda Node 22 base image (`public.ecr.aws/lambda/nodejs:22`): the first stage compiles TypeScript with dev dependencies, the second copies the compiled output and installs production dependencies only. The Lambda handler is `dist/src/server/lambda.handler`. CI builds this image on every push and pull request; a deploy workflow that pushes it to AWS is future work.

## Corpus and licenses

The code in this repository is MIT licensed (see `LICENSE`). The corpus under `data/corpus/` is third-party content used under its own terms: the OWASP Top 10 and OWASP Top 10 for LLM Applications are CC BY-SA 4.0, and MITRE ATLAS is Apache License 2.0. Full attribution and canonical source links are in [`data/corpus/SOURCES.md`](data/corpus/SOURCES.md); see `NOTICE` for the summary.
