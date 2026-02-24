export type RetryPolicyConfig = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export type RetryResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; error: Error; attempts: number };

export function calculateBackoffMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number
): number {
  const delay = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(delay, maxDelayMs);
}

export async function runWithRetry<T>(
  operation: () => Promise<T>,
  config: RetryPolicyConfig,
  sleep: (ms: number) => Promise<void> = defaultSleep
): Promise<RetryResult<T>> {
  let attempt = 0;

  while (attempt < config.maxAttempts) {
    attempt += 1;

    try {
      const value = await operation();
      return { ok: true, value, attempts: attempt };
    } catch (error) {
      const finalAttempt = attempt >= config.maxAttempts;
      if (finalAttempt) {
        return {
          ok: false,
          error: error instanceof Error ? error : new Error(String(error)),
          attempts: attempt
        };
      }

      const backoffMs = calculateBackoffMs(attempt, config.baseDelayMs, config.maxDelayMs);
      await sleep(backoffMs);
    }
  }

  return {
    ok: false,
    error: new Error("retry policy exhausted unexpectedly"),
    attempts: attempt
  };
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
