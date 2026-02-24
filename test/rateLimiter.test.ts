import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "../src/services/rateLimiter.js";

describe("InMemoryRateLimiter", () => {
  it("allows requests up to the limit then blocks until window passes", () => {
    const limiter = new InMemoryRateLimiter();
    const key = "messages:127.0.0.1";
    const rule = { windowMs: 1_000, maxRequests: 2 };

    const first = limiter.decide(key, rule, 1_000);
    const second = limiter.decide(key, rule, 1_500);
    const third = limiter.decide(key, rule, 1_700);
    const fourth = limiter.decide(key, rule, 2_100);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(fourth.allowed).toBe(true);
  });
});
