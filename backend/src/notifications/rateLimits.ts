import { AuthRateLimiter, BoundedAuthRateLimitStore } from "../identity/rateLimit.js";

/**
 * Send and ingress rate limits for the Telegram notification worker.
 *
 * Sends use ReadinessRateLimiter-shaped bounded token buckets (fractional
 * refill so "10 per minute" is a real sustained rate, not a fixed window):
 * one global bucket honouring Telegram's ~30 msg/s ceiling with margin, one
 * bucket per chat and one per owner. Ingress command handling reuses the
 * fixed-window AuthRateLimiter shape keyed by hashed chat id, and the web
 * binding-code endpoint gets its own per-owner limiter. Admin users get no
 * bypass anywhere.
 */

interface TokenBucket {
  tokens: number;
  updatedAt: number;
  lastSeenAt: number;
}

export interface KeyedTokenBucketOptions {
  readonly refillPerSecond: number;
  readonly burst: number;
  readonly maxBuckets: number;
}

/** Bounded keyed token bucket; peek() lets a lane defer work without spending a token. */
export class KeyedTokenBucketLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly idleTtlMs: number;

  constructor(private readonly options: KeyedTokenBucketOptions) {
    assertPositiveFinite(options.refillPerSecond, "refillPerSecond");
    assertPositiveInteger(options.burst, "burst");
    assertPositiveInteger(options.maxBuckets, "maxBuckets");
    this.idleTtlMs = Math.max(60_000, Math.ceil((options.burst / options.refillPerSecond) * 2_000));
  }

  /** True when a token is available right now, without consuming it. */
  peek(key: string, now: number): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket) return this.buckets.size < this.options.maxBuckets || this.pruned(now);
    return this.refilled(bucket, now) >= 1;
  }

  /** Consume one token; false means the caller must defer, not drop. */
  consume(key: string, now: number): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.options.maxBuckets && !this.pruned(now)) return false;
      bucket = { tokens: this.options.burst, updatedAt: now, lastSeenAt: now };
    }
    bucket.tokens = this.refilled(bucket, now);
    bucket.updatedAt = now;
    bucket.lastSeenAt = now;
    this.buckets.set(key, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private refilled(bucket: TokenBucket, now: number): number {
    const elapsedMs = Math.max(0, now - bucket.updatedAt);
    return Math.min(this.options.burst, bucket.tokens + (elapsedMs / 1_000) * this.options.refillPerSecond);
  }

  private pruned(now: number): boolean {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastSeenAt >= this.idleTtlMs) this.buckets.delete(key);
    }
    return this.buckets.size < this.options.maxBuckets;
  }
}

export interface TelegramSendRateLimits {
  /** Whole-bot ceiling: 25 messages per second. */
  readonly global: KeyedTokenBucketLimiter;
  /** Telegram's per-chat etiquette: 1 message per second per chat. */
  readonly perChat: KeyedTokenBucketLimiter;
  /** Owner fairness: 10 sends per minute per owner. */
  readonly perOwner: KeyedTokenBucketLimiter;
}

export function createTelegramSendRateLimits(): TelegramSendRateLimits {
  return {
    global: new KeyedTokenBucketLimiter({ refillPerSecond: 25, burst: 25, maxBuckets: 4 }),
    perChat: new KeyedTokenBucketLimiter({ refillPerSecond: 1, burst: 1, maxBuckets: 4_096 }),
    perOwner: new KeyedTokenBucketLimiter({ refillPerSecond: 10 / 60, burst: 10, maxBuckets: 4_096 })
  };
}

/** True when this (owner, chat) send may proceed now; consumes all three buckets. */
export function consumeSendAllowance(limits: TelegramSendRateLimits, ownerUserId: string, chatKey: string, now: number): boolean {
  if (!limits.global.peek("telegram", now) || !limits.perChat.peek(chatKey, now) || !limits.perOwner.peek(ownerUserId, now)) {
    return false;
  }
  return limits.global.consume("telegram", now) && limits.perChat.consume(chatKey, now) && limits.perOwner.consume(ownerUserId, now);
}

/** True when all three send buckets currently hold a token (no consumption). */
export function peekSendAllowance(limits: TelegramSendRateLimits, ownerUserId: string, chatKey: string, now: number): boolean {
  return limits.global.peek("telegram", now) && limits.perChat.peek(chatKey, now) && limits.perOwner.peek(ownerUserId, now);
}

export interface TelegramIngressRateLimits {
  /** Any handled command from one chat: 6 per minute. */
  readonly perChatCommands: AuthRateLimiter;
  /** Binding-code consumption attempts from one chat: 5 per 10 minutes. */
  readonly bindingAttempts: AuthRateLimiter;
}

export function createTelegramIngressRateLimits(store = new BoundedAuthRateLimitStore()): TelegramIngressRateLimits {
  return {
    perChatCommands: new AuthRateLimiter("telegram-ingress-command", store, {
      windowMs: 60_000,
      maxAttempts: 6,
      blockMs: 60_000
    }),
    bindingAttempts: new AuthRateLimiter("telegram-ingress-binding", store, {
      windowMs: 10 * 60_000,
      maxAttempts: 5,
      blockMs: 10 * 60_000
    })
  };
}

/** Per-owner limiter for POST /api/alerts/bindings/codes: 10 codes per 10 minutes. */
export function createBindingCodeRateLimiter(store = new BoundedAuthRateLimitStore()): AuthRateLimiter {
  return new AuthRateLimiter("alert-binding-code", store, {
    windowMs: 10 * 60_000,
    maxAttempts: 10,
    blockMs: 10 * 60_000
  });
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Telegram rate limit ${name} must be a positive safe integer`);
  }
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Telegram rate limit ${name} must be a positive number`);
  }
}
