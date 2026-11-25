export class TokenBucketRateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly buckets = new Map<string, { tokens: number; updatedAtMs: number }>();

  constructor(capacity = 40, refillPerSec = 10) {
    this.capacity = capacity;
    this.refillPerMs = refillPerSec / 1000;
  }

  allow(key: string, cost = 1): boolean {
    const now = Date.now();
    const existing = this.buckets.get(key);
    if (!existing) {
      this.buckets.set(key, { tokens: Math.max(0, this.capacity - cost), updatedAtMs: now });
      return true;
    }
    const elapsed = Math.max(0, now - existing.updatedAtMs);
    const replenished = Math.min(this.capacity, existing.tokens + elapsed * this.refillPerMs);
    if (replenished < cost) {
      existing.tokens = replenished;
      existing.updatedAtMs = now;
      return false;
    }
    existing.tokens = replenished - cost;
    existing.updatedAtMs = now;
    if (this.buckets.size > 512) {
      for (const [k, b] of this.buckets) {
        if (now - b.updatedAtMs > 120_000) this.buckets.delete(k);
      }
    }
    return true;
  }
}

export class IdempotencyLedger {
  private readonly seen = new Map<string, { actionId: string; createdAtMs: number }>();
  private readonly ttlMs: number;

  constructor(ttlMs = 10 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  getExisting(key: string): string | null {
    const now = Date.now();
    const hit = this.seen.get(key);
    if (!hit) return null;
    if (now - hit.createdAtMs > this.ttlMs) {
      this.seen.delete(key);
      return null;
    }
    return hit.actionId;
  }

  record(key: string, actionId: string): void {
    const now = Date.now();
    this.seen.set(key, { actionId, createdAtMs: now });
    if (this.seen.size > 512) {
      for (const [k, v] of this.seen) {
        if (now - v.createdAtMs > this.ttlMs) this.seen.delete(k);
      }
    }
  }
}

export async function withTimeoutAndFallback<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  fallback: () => T | Promise<T>
): Promise<{ value: T; usedFallback: boolean; reason?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    const value = await work(controller.signal);
    return { value, usedFallback: false };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const value = await fallback();
    return { value, usedFallback: true, reason };
  } finally {
    clearTimeout(timer);
  }
}
