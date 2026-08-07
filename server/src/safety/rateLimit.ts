/**
 * Token-bucket rate limiter, keyed by an arbitrary string (IP or session id).
 * In-memory only: a restart forgives everyone, which is acceptable for the
 * abuse classes this defends against (spam bursts, skip-hammering).
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillWindowMs: number;

  constructor(capacity: number, refillWindowMs: number) {
    this.capacity = capacity;
    this.refillWindowMs = refillWindowMs;
  }

  /** Returns true when the action is allowed and consumes a token. */
  tryConsume(key: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, lastRefill: now };

    const elapsed = now - bucket.lastRefill;
    if (elapsed > 0) {
      const refill = (elapsed / this.refillWindowMs) * this.capacity;
      bucket.tokens = Math.min(this.capacity, bucket.tokens + refill);
      bucket.lastRefill = now;
    }

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }

    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }

  forget(key: string): void {
    this.buckets.delete(key);
  }

  /** Drop buckets that have fully refilled, so the map does not grow forever. */
  sweep(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > this.refillWindowMs * 2) this.buckets.delete(key);
    }
  }
}
