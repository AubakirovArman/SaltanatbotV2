interface Entry {
  attempts: number;
  startedAt: number;
  blockedUntil: number;
  lastSeenAt: number;
  windowMs: number;
}

export interface AuthRateLimitPolicy {
  windowMs: number;
  maxAttempts: number;
  blockMs: number;
}

/**
 * One allowance counted before an asynchronous authentication operation.
 * Calling rollback is idempotent and only affects the fixed-window entry that
 * originally accepted this reservation.
 */
export interface AuthRateLimitReservation {
  retryAfter?: number;
  rollback(): void;
}

/**
 * One process-wide-style store shared by all authentication buckets in a
 * router. It has a hard cardinality limit: during a high-cardinality attack,
 * an unseen key is rejected instead of evicting an active protection bucket.
 */
export class BoundedAuthRateLimitStore {
  private readonly entries = new Map<string, Entry>();

  constructor(readonly maxEntries = 4_096) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be a positive integer");
  }

  get(key: string): Entry | undefined {
    return this.entries.get(key);
  }

  canAccept(key: string, now: number): boolean {
    if (this.entries.has(key)) return true;
    if (this.entries.size < this.maxEntries) return true;
    this.prune(now);
    return this.entries.size < this.maxEntries;
  }

  set(key: string, entry: Entry, now: number): boolean {
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      this.prune(now);
      if (this.entries.size >= this.maxEntries) return false;
    }
    this.entries.set(key, entry);
    return true;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.blockedUntil <= now && entry.startedAt + entry.windowMs <= now) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Fixed-window authentication limiter. Separate limiter instances share one
 * bounded store and distinguish their entries with a stable scope prefix.
 */
export class AuthRateLimiter {
  private readonly policy: AuthRateLimitPolicy;

  constructor(
    private readonly scope: string,
    private readonly store: BoundedAuthRateLimitStore,
    policy: AuthRateLimitPolicy
  ) {
    this.policy = {
      windowMs: boundedInteger(policy.windowMs, 1, Number.MAX_SAFE_INTEGER),
      maxAttempts: boundedInteger(policy.maxAttempts, 1, Number.MAX_SAFE_INTEGER),
      blockMs: boundedInteger(policy.blockMs, 1, Number.MAX_SAFE_INTEGER)
    };
  }

  check(key: string, now = Date.now()): number | undefined {
    const entry = this.current(key, now);
    if (!entry) {
      if (!this.store.canAccept(this.scoped(key), now)) return Math.max(1, Math.ceil(this.policy.blockMs / 1_000));
      return undefined;
    }
    if (entry.blockedUntil <= now) return undefined;
    return Math.max(1, Math.ceil((entry.blockedUntil - now) / 1_000));
  }

  /** Count a completed failed attempt without clearing failures on success. */
  fail(key: string, now = Date.now()): number | undefined {
    const scopedKey = this.scoped(key);
    const current = this.current(key, now);
    const entry = current ?? {
      attempts: 0,
      startedAt: now,
      blockedUntil: 0,
      lastSeenAt: now,
      windowMs: this.policy.windowMs
    };
    entry.attempts += 1;
    entry.lastSeenAt = now;
    if (entry.attempts >= this.policy.maxAttempts) entry.blockedUntil = now + this.policy.blockMs;
    if (!this.store.set(scopedKey, entry, now)) {
      return Math.max(1, Math.ceil(this.policy.blockMs / 1_000));
    }
    return undefined;
  }

  /**
   * Atomically reserve and count an attempt before expensive work begins.
   * The returned rollback removes only this reservation, preserving earlier
   * failures and any reservations added concurrently to the same entry.
   */
  reserve(key: string, now = Date.now()): AuthRateLimitReservation {
    const retryAfter = this.check(key, now);
    if (retryAfter) return { retryAfter, rollback: () => undefined };

    const scopedKey = this.scoped(key);
    const current = this.current(key, now);
    const entry = current ?? {
      attempts: 0,
      startedAt: now,
      blockedUntil: 0,
      lastSeenAt: now,
      windowMs: this.policy.windowMs
    };
    entry.attempts += 1;
    entry.lastSeenAt = now;
    if (entry.attempts >= this.policy.maxAttempts) entry.blockedUntil = now + this.policy.blockMs;
    if (!this.store.set(scopedKey, entry, now)) {
      return { retryAfter: Math.max(1, Math.ceil(this.policy.blockMs / 1_000)), rollback: () => undefined };
    }

    let active = true;
    return {
      rollback: () => {
        if (!active) return;
        active = false;
        // A slow authentication operation may outlive its fixed window. Never
        // decrement a replacement entry created for the same key.
        if (this.store.get(scopedKey) !== entry) return;
        entry.attempts = Math.max(0, entry.attempts - 1);
        if (entry.attempts === 0) {
          this.store.delete(scopedKey);
          return;
        }
        if (entry.attempts < this.policy.maxAttempts) entry.blockedUntil = 0;
      }
    };
  }

  /** Atomically count an attempt that will never be rolled back. */
  attempt(key: string, now = Date.now()): number | undefined {
    return this.reserve(key, now).retryAfter;
  }

  success(key: string): void {
    this.store.delete(this.scoped(key));
  }

  private current(key: string, now: number): Entry | undefined {
    const scopedKey = this.scoped(key);
    const entry = this.store.get(scopedKey);
    if (!entry) return undefined;
    if (entry.blockedUntil <= now && entry.startedAt + this.policy.windowMs <= now) {
      this.store.delete(scopedKey);
      return undefined;
    }
    entry.lastSeenAt = now;
    return entry;
  }

  private scoped(key: string): string {
    return `${this.scope}:${key}`;
  }
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
