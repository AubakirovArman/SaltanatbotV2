export interface IdentityCleanupTarget {
  cleanup(limit?: number): Promise<unknown>;
}

export interface IdentityCleanupScheduler {
  start(): void;
  quiesce(): void;
  drain(): Promise<void>;
  trigger(): void;
}

export interface IdentityCleanupSchedulerOptions {
  intervalMs?: number;
  limit?: number;
  onError?: (error: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 15 * 60_000;
const DEFAULT_LIMIT = 1_000;

export function createIdentityCleanupScheduler(target: IdentityCleanupTarget | undefined, options: IdentityCleanupSchedulerOptions = {}): IdentityCleanupScheduler {
  const intervalMs = boundedInteger(options.intervalMs, DEFAULT_INTERVAL_MS, 1_000, 24 * 60 * 60_000);
  const limit = boundedInteger(options.limit, DEFAULT_LIMIT, 1, 10_000);
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.error(`Identity cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  let accepting = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;

  const trigger = () => {
    if (!target || !accepting || inFlight) return;
    inFlight = target
      .cleanup(limit)
      .then(() => undefined)
      .catch(onError)
      .finally(() => {
        inFlight = undefined;
      });
  };

  return {
    start() {
      if (!target || accepting) return;
      accepting = true;
      trigger();
      timer = setInterval(trigger, intervalMs);
      timer.unref?.();
    },
    quiesce() {
      accepting = false;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    async drain() {
      await inFlight;
    },
    trigger
  };
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value!)));
}
