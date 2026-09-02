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
