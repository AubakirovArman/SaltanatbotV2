import type { Request, RequestHandler } from "express";

interface ReadinessBucket {
  tokens: number;
  updatedAt: number;
  lastSeenAt: number;
}

export interface ReadinessRateLimitOptions {
  readonly refillPerSecond: number;
  readonly burst: number;
  readonly maxBuckets: number;
  readonly now?: () => number;
}

export interface ReadinessRateLimitSnapshot {
  readonly refillPerSecond: number;
  readonly burst: number;
  readonly maxBuckets: number;
  readonly buckets: number;
  readonly allowed: number;
  readonly rejected: number;
}

export const DEFAULT_READINESS_RATE_LIMIT_OPTIONS = Object.freeze({
  refillPerSecond: 2,
  burst: 10,
  maxBuckets: 4_096
}) satisfies ReadinessRateLimitOptions;

/**
 * A dedicated bounded per-IP token bucket for the unauthenticated readiness
 * probe. It is intentionally separate from authenticated/API buckets so a
 * public probe flood cannot consume an operator's auth/control allowance.
 */
export class ReadinessRateLimiter {
  private readonly buckets = new Map<string, ReadinessBucket>();
  private readonly now: () => number;
  private readonly idleTtlMs: number;
  private allowed = 0;
  private rejected = 0;

  constructor(private readonly options: ReadinessRateLimitOptions) {
    assertPositiveInteger(options.refillPerSecond, "refillPerSecond");
    assertPositiveInteger(options.burst, "burst");
    assertPositiveInteger(options.maxBuckets, "maxBuckets");
    this.now = options.now ?? Date.now;
    this.idleTtlMs = Math.max(60_000, Math.ceil((options.burst / options.refillPerSecond) * 2_000));
  }

  middleware(): RequestHandler {
    return (request, response, next) => {
      const retryAfter = this.consume(requestIp(request), this.now());
      if (retryAfter === undefined) {
        next();
        return;
      }
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Retry-After", String(retryAfter));
      response.status(429).json({
        error: "Readiness request limit exceeded. Try again shortly.",
        code: "readiness_rate_limited",
        retryable: true
      });
    };
  }

  snapshot(): ReadinessRateLimitSnapshot {
    return {
      refillPerSecond: this.options.refillPerSecond,
      burst: this.options.burst,
      maxBuckets: this.options.maxBuckets,
      buckets: this.buckets.size,
      allowed: this.allowed,
      rejected: this.rejected
    };
  }

  private consume(key: string, now: number): number | undefined {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.options.maxBuckets) this.prune(now);
      if (this.buckets.size >= this.options.maxBuckets) {
        this.rejected += 1;
        return this.secondsUntilCapacity(now);
      }
      bucket = {
        tokens: this.options.burst,
        updatedAt: now,
        lastSeenAt: now
      };
    }

    const elapsedMs = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(this.options.burst, bucket.tokens + (elapsedMs / 1_000) * this.options.refillPerSecond);
    bucket.updatedAt = now;
    bucket.lastSeenAt = now;
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      this.rejected += 1;
      return Math.max(1, Math.ceil((1 - bucket.tokens) / this.options.refillPerSecond));
    }

    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    this.allowed += 1;
    return undefined;
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastSeenAt >= this.idleTtlMs) {
        this.buckets.delete(key);
      }
    }
  }

  private secondsUntilCapacity(now: number): number {
    let earliestExpiry = Number.POSITIVE_INFINITY;
    for (const bucket of this.buckets.values()) {
      earliestExpiry = Math.min(
        earliestExpiry,
        bucket.lastSeenAt + this.idleTtlMs
      );
    }
    if (!Number.isFinite(earliestExpiry)) {
      return Math.max(1, Math.ceil(this.idleTtlMs / 1_000));
    }
    return Math.max(1, Math.ceil((earliestExpiry - now) / 1_000));
  }
}

export function createReadinessRateLimit(options: ReadinessRateLimitOptions = DEFAULT_READINESS_RATE_LIMIT_OPTIONS): RequestHandler {
  return new ReadinessRateLimiter(options).middleware();
}

function requestIp(request: Request): string {
  return request.ip || request.socket.remoteAddress || "unknown";
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Readiness rate limit ${name} must be a positive safe integer`);
  }
}
