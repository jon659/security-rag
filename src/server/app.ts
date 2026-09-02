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
