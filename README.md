# security-rag

Ask an AI or application security question. Get an answer grounded in the OWASP LLM Top 10, the OWASP Top 10, and MITRE ATLAS, with citations. If the sources do not cover it, the service says so.

Status: in progress. Evaluation numbers and the demo URL land here when phases 2 and 4 complete.

## Run locally

1. Copy `.env.example` to `.env` and fill in the keys.
2. `npm install`
3. `npm run db:init` then `npm run ingest`
4. `npm run ask "What is prompt injection?"`
