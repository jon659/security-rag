# security-rag

Ask an AI or application security question. Get an answer grounded in the OWASP LLM Top 10, the OWASP Top 10, and MITRE ATLAS, with citations. If the sources do not cover it, the service says so.

Status: in progress. Evaluation numbers and the demo URL land here when phases 2 and 4 complete.

## Run locally

1. Copy `.env.example` to `.env` and fill in the keys.
2. `npm install`
3. `npm run db:init` then `npm run ingest`
4. `npm run ask "What is prompt injection?"`

## Evaluation

28 hand-written questions (25 in-corpus, 3 that must be refused), scored by `npm run eval`.

| Metric | Result | Date |
|---|---|---|
| Retrieval hit@5 | pending | 2026-09-02 |
| Refusal accuracy | pending | 2026-09-02 |

`npm run eval` currently fails before scoring any question: the Anthropic account has no API credit (`BadRequestError: 400 ... "Your credit balance is too low to access the Anthropic API."`). Retrieval and the scorer are implemented and unit-tested; the numbers above will be filled in once the eval run completes against live vendors.
