import { Hono } from "hono";
import { z } from "zod";
import type { AskResult } from "../graph/index.js";
import { StoreError } from "../store/errors.js";

const Body = z.object({ question: z.string().min(1).max(500) });
const LIMIT = 10;
const WINDOW_MS = 60_000;
// Above this many distinct keys, sweep out anything whose newest hit has
// already aged out of the window, so a burst of one-off keys (e.g. many
// distinct spoofed x-forwarded-for values in a non-Lambda deployment) cannot
// grow the map without bound.
const SWEEP_THRESHOLD = 1000;

// Hono's AWS Lambda adapter (hono/aws-lambda) calls `app.fetch(req, { event,
// requestContext, lambdaContext })`, so this is the shape of `c.env` behind a
// Lambda function URL / API Gateway HTTP API. `requestContext.http.sourceIp`
// is populated by AWS itself from the TCP connection, not from any header a
// client can set -- unlike x-forwarded-for, which AWS only *appends* to, so a
// client-supplied first value in that header is attacker-controlled.
type LambdaEnv = { event?: { requestContext?: { http?: { sourceIp?: string } } } };

function clientIp(c: { env: unknown; req: { header(name: string): string | undefined } }): string {
  const sourceIp = (c.env as LambdaEnv | undefined)?.event?.requestContext?.http?.sourceIp;
  if (sourceIp) return sourceIp;
  // Not running behind the Lambda adapter (e.g. local dev, or a future
  // deployment target). Fall back to the LAST hop of x-forwarded-for: each
  // proxy in the chain appends the address it saw, so the last entry is the
  // one nearest to us and hardest for the original client to forge.
  const last = c.req.header("x-forwarded-for")?.split(",").pop()?.trim();
  return last || "unknown";
}

// Isolated from makeApp/Hono so it can be unit-tested directly (including its
// eviction behavior) without going through HTTP or exposing a debug route.
export function createRateLimiter(opts: { limit?: number; windowMs?: number; sweepThreshold?: number } = {}) {
  const limit = opts.limit ?? LIMIT;
  const windowMs = opts.windowMs ?? WINDOW_MS;
  const sweepThreshold = opts.sweepThreshold ?? SWEEP_THRESHOLD;
  const hits = new Map<string, number[]>();

  return {
    /** Current number of distinct keys tracked (for tests only). */
    size(): number {
      return hits.size;
    },
    /** Records a hit for `key` at time `t`; returns false if it is over the limit. */
    hit(key: string, t: number): boolean {
      const recent = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
      if (recent.length === 0) hits.delete(key);
      if (recent.length >= limit) return false;
      hits.set(key, [...recent, t]);

      if (hits.size > sweepThreshold) {
        for (const [k, timestamps] of hits) {
          const newest = timestamps[timestamps.length - 1];
          if (newest === undefined || t - newest >= windowMs) hits.delete(k);
        }
      }
      return true;
    },
  };
}

export function makeApp(deps: { ask(q: string): Promise<AskResult>; count(): Promise<number>; html: string; now?: () => number }) {
  const now = deps.now ?? (() => Date.now());
  const limiter = createRateLimiter();
  const app = new Hono();

  app.get("/", (c) => c.html(deps.html));
  app.get("/health", async (c) => {
    try {
      return c.json({ ok: true, chunks: await deps.count() });
    } catch (e) {
      console.log(JSON.stringify({ level: "error", event: "health_failed", name: e instanceof Error ? e.constructor.name : "Unknown" }));
      return c.json({ ok: false }, 503);
    }
  });

  app.post("/ask", async (c) => {
    const ip = clientIp(c);
    const t = now();
    if (!limiter.hit(ip, t)) return c.json({ error: "Rate limit: 10 questions per minute." }, 429);

    const parsed = Body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Body must be { question: string } with 1 to 500 characters." }, 400);

    try {
      const result = await deps.ask(parsed.data.question);
      return c.json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      console.log(JSON.stringify({ level: "error", event: "ask_failed", message: msg.slice(0, 200) }));
      if (e instanceof StoreError) return c.json({ error: "The knowledge store is unavailable right now." }, 503);
      return c.json({ error: "An upstream model service failed. Please try again." }, 502);
    }
  });

  return app;
}
