export type RateLimitRule = {
  windowMs: number;
  maxRequests: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
};

type Bucket = {
  timestamps: number[];
  lastSeenAt: number;
};

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  decide(key: string, rule: RateLimitRule, nowMs = Date.now()): RateLimitDecision {
    const bucket = this.buckets.get(key) ?? { timestamps: [], lastSeenAt: nowMs };
    const lowerBound = nowMs - rule.windowMs;
    const active = bucket.timestamps.filter((timestamp) => timestamp > lowerBound);
    bucket.lastSeenAt = nowMs;

    if (active.length >= rule.maxRequests) {
      bucket.timestamps = active;
      this.buckets.set(key, bucket);
      const oldestActive = active[0] ?? nowMs;
      const retryAfterSeconds = Math.max(Math.ceil((oldestActive + rule.windowMs - nowMs) / 1000), 1);
      return {
        allowed: false,
        retryAfterSeconds,
        remaining: 0
      };
    }

    active.push(nowMs);
    bucket.timestamps = active;
    this.buckets.set(key, bucket);

    this.compact(nowMs, rule.windowMs);

    return {
      allowed: true,
      retryAfterSeconds: 0,
      remaining: Math.max(rule.maxRequests - active.length, 0)
    };
  }

  private compact(nowMs: number, maxWindowMs: number): void {
    const staleAfterMs = Math.max(maxWindowMs * 3, 60_000);

    for (const [key, bucket] of this.buckets.entries()) {
      if (nowMs - bucket.lastSeenAt > staleAfterMs) {
        this.buckets.delete(key);
      }
    }
  }
}
