import { describe, it, expect } from "vitest";
import { withRetry429, isRateLimited } from "../src/vendors/retry.js";

const limited = () => Object.assign(new Error("Too Many Requests"), { statusCode: 429 });

describe("withRetry429", () => {
  it("retries on 429 with linear backoff and then succeeds", async () => {
    let calls = 0;
    const waits: number[] = [];
    const out = await withRetry429(
      async () => {
        calls++;
        if (calls < 3) throw limited();
        return "ok";
      },
      { baseDelayMs: 10, sleep: async (ms) => { waits.push(ms); } },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(3);
    expect(waits).toEqual([10, 20]);
  });
  it("gives up after the configured attempts", async () => {
    let calls = 0;
    await expect(
      withRetry429(async () => { calls++; throw limited(); }, { attempts: 3, baseDelayMs: 1, sleep: async () => {} }),
    ).rejects.toThrow("Too Many Requests");
    expect(calls).toBe(3);
  });
  it("does not retry other errors", async () => {
    let calls = 0;
    await expect(
      withRetry429(async () => { calls++; throw new Error("boom"); }, { sleep: async () => {} }),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });
  it("recognizes both statusCode and status shapes", () => {
    expect(isRateLimited({ statusCode: 429 })).toBe(true);
    expect(isRateLimited({ status: 429 })).toBe(true);
    expect(isRateLimited({ status: 500 })).toBe(false);
    expect(isRateLimited(undefined)).toBe(false);
  });
});
