import type { NextFunction, Request, Response } from "express";

interface Bucket {
  tokens: number;
  updatedAt: number;
  lastSeenAt: number;
}

const buckets = new Map<string, Bucket>();
const refillPerSecond = boundedEnv("API_RATE_REFILL_PER_SECOND", 20, 1, 1_000);
const burst = boundedEnv("API_RATE_BURST", 240, 10, 10_000);
const maxBuckets = boundedEnv("API_RATE_MAX_BUCKETS", 4_096, 256, 100_000);

/** Per-account token bucket. It protects API responsiveness, not billing. */
export function apiRateLimit(request: Request, response: Response, next: NextFunction): void {
  const userId = response.locals.authUserId;
  const key = typeof userId === "string" ? `user:${userId}` : `ip:${request.ip}`;
  const now = Date.now();
  let current = buckets.get(key);
  if (!current) {
    if (buckets.size >= maxBuckets) prune(now);
    if (buckets.size >= maxBuckets) {
      response.setHeader("Retry-After", "60");
      response.status(429).json({ error: "API request limit exceeded. Try again shortly.", code: "rate_limited" });
      return;
    }
    current = { tokens: burst, updatedAt: now, lastSeenAt: now };
  }
  current.tokens = Math.min(burst, current.tokens + ((now - current.updatedAt) / 1_000) * refillPerSecond);
  current.updatedAt = now;
  current.lastSeenAt = now;
  const cost = ["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase()) ? 1 : 4;
  if (current.tokens < cost) {
    buckets.set(key, current);
    response.setHeader("Retry-After", String(Math.max(1, Math.ceil((cost - current.tokens) / refillPerSecond))));
    response.status(429).json({ error: "API request limit exceeded. Try again shortly.", code: "rate_limited" });
    return;
  }
  current.tokens -= cost;
  buckets.set(key, current);
  next();
}

function prune(now: number): void {
  for (const [key, bucket] of buckets) if (now - bucket.lastSeenAt > 30 * 60_000) buckets.delete(key);
}

function boundedEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}
