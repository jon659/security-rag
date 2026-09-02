import { describe, it, expect } from "vitest";
import { makeApp, createRateLimiter } from "../src/server/app.js";
import { StoreError } from "../src/store/errors.js";

const ok = { answer: "A [1].", refused: false, rewritten: false, sources: [] };
function app(overrides: Partial<Parameters<typeof makeApp>[0]> = {}) {
  return makeApp({ ask: async () => ok, count: async () => 5, html: "<h1>demo</h1>", ...overrides });
}
const post = (a: ReturnType<typeof app>, body: unknown, ip = "1.1.1.1", env?: unknown) =>
  a.request(
    "/ask",
    { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": ip } },
    env,
  );
const lambdaEnv = (sourceIp: string) => ({ event: { requestContext: { http: { sourceIp } } } });

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
  it("resets the rate limit window once it expires", async () => {
    let t = 0;
    const a = app({ now: () => t });
    for (let i = 0; i < 10; i++) expect((await post(a, { question: "q" })).status).toBe(200);
    expect((await post(a, { question: "q" })).status).toBe(429);
    t += 60_000;
    expect((await post(a, { question: "q" })).status).toBe(200);
  });
  it("does not let a forged x-forwarded-for reset the counter behind Lambda (constant sourceIp)", async () => {
    const a = app();
    const env = lambdaEnv("9.9.9.9");
    for (let i = 0; i < 10; i++) {
      expect((await post(a, { question: "q" }, `1.1.1.${i}`, env)).status).toBe(200);
    }
    // A brand new forged x-forwarded-for value on every request; only the
    // platform-attested sourceIp is constant, so this must still be limited.
    expect((await post(a, { question: "q" }, "1.1.1.99", env)).status).toBe(429);
    // A different real client (different sourceIp) is unaffected.
    expect((await post(a, { question: "q" }, "1.1.1.99", lambdaEnv("8.8.8.8"))).status).toBe(200);
  });
  it("uses the last x-forwarded-for hop outside Lambda, so a forged first hop shares the counter", async () => {
    const a = app();
    for (let i = 0; i < 10; i++) {
      expect((await post(a, { question: "q" }, `9.9.9.${i}, 2.2.2.2`)).status).toBe(200);
    }
    expect((await post(a, { question: "q" }, "1.1.1.1, 2.2.2.2")).status).toBe(429);
  });
  it("returns 502 when the pipeline throws a vendor error", async () => {
    const a = app({ ask: async () => { throw new Error("vendor: cohere timeout"); } });
    expect((await post(a, { question: "q" })).status).toBe(502);
  });
  it("returns 503 when the pipeline throws a StoreError", async () => {
    const a = app({ ask: async () => { throw new StoreError("store operation failed: nearest"); } });
    expect((await post(a, { question: "q" })).status).toBe(503);
  });
  it("returns 503 and no message text when /health's count() fails", async () => {
    const a = app({ count: async () => { throw new Error("connection string leaked here would be bad"); } });
    const res = await a.request("/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });
});

describe("createRateLimiter", () => {
  it("drops every counter once distinct keys exceed twice the sweep threshold inside one window", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, sweepThreshold: 5 });
    for (let i = 0; i < 11; i++) limiter.hit(`k${i}`, 0);
    expect(limiter.size()).toBeLessThanOrEqual(5 * 2);
  });
  it("allows up to the limit then blocks the next hit in the window", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000 });
    expect(limiter.hit("a", 0)).toBe(true);
    expect(limiter.hit("a", 1)).toBe(true);
    expect(limiter.hit("a", 2)).toBe(false);
  });
  it("evicts stale keys once the tracker grows past the sweep threshold", () => {
    const limiter = createRateLimiter({ limit: 10, windowMs: 1000, sweepThreshold: 3 });
    // Four distinct keys hit once each at t=0; all age out by t=5000.
    for (const key of ["a", "b", "c", "d"]) limiter.hit(key, 0);
    expect(limiter.size()).toBe(4);
    // A new hit well past the window pushes size (5) over the threshold (3),
    // triggering the sweep; every key with no recent activity is dropped,
    // leaving only the key that was just hit.
    limiter.hit("e", 5000);
    expect(limiter.size()).toBe(1);
  });
});
