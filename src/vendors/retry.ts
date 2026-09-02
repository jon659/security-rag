/** True when a vendor SDK error is an HTTP 429 (rate limited). */
export function isRateLimited(err: unknown): boolean {
  const e = err as { statusCode?: unknown; status?: unknown };
  return e?.statusCode === 429 || e?.status === 429;
}

export type RetryOptions = {
  attempts?: number;
  /** Base delay in ms; attempt n waits base * n (linear backoff). */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, delayMs: number) => void;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs `fn`, retrying only on 429 responses. Cohere trial keys allow 10 calls a
 * minute, so a burst of retrieval calls trips the limit in normal use; waiting
 * and retrying is the correct response, anything else is rethrown untouched.
 */
export async function withRetry429<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 6;
  const base = opts.baseDelayMs ?? 12_000;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimited(err) || attempt >= attempts) throw err;
      const delay = base * attempt;
      opts.onRetry?.(attempt, delay);
      await sleep(delay);
    }
  }
}
