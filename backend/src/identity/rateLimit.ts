interface Entry {
  attempts: number;
  startedAt: number;
  blockedUntil: number;
}

export class AuthRateLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly windowMs = 15 * 60_000,
    private readonly maxAttempts = 10,
    private readonly blockMs = 15 * 60_000
  ) {}

  check(key: string, now = Date.now()): number | undefined {
    this.prune(now);
    const entry = this.entries.get(key);
    if (!entry || entry.blockedUntil <= now) return undefined;
    return Math.ceil((entry.blockedUntil - now) / 1000);
  }

  fail(key: string, now = Date.now()): void {
    const current = this.entries.get(key);
    const entry = !current || current.startedAt + this.windowMs <= now
      ? { attempts: 0, startedAt: now, blockedUntil: 0 }
      : current;
    entry.attempts += 1;
    if (entry.attempts >= this.maxAttempts) entry.blockedUntil = now + this.blockMs;
    this.entries.set(key, entry);
  }

  success(key: string): void {
    this.entries.delete(key);
  }

  private prune(now: number): void {
    if (this.entries.size < 2_000) return;
    for (const [key, entry] of this.entries) {
      if (entry.blockedUntil <= now && entry.startedAt + this.windowMs <= now) this.entries.delete(key);
    }
  }
}
