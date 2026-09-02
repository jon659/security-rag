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
