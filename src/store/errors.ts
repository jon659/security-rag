// A store failure is reported to callers as a StoreError so the HTTP layer can
// tell "the knowledge store is down" (503) apart from every other failure
// (502) by checking the error's type, never by pattern-matching its message.
// Kept in its own module (rather than pg.ts) so importing it does not pull the
// real "pg"/"pgvector" packages into code -- like the Hono app -- that only
// needs to catch the type, not construct a live store.
export class StoreError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StoreError";
  }
}
