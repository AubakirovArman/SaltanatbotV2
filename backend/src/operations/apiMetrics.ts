import type { RequestHandler } from "express";

const LATENCY_BUCKET_UPPER_BOUNDS_MS = [
  10,
  25,
  50,
  100,
  250,
  500,
  1_000,
  2_000,
  5_000,
  Number.POSITIVE_INFINITY
] as const;

export interface ApiMetricsSnapshot {
  readonly requests: number;
  readonly completed: number;
  readonly disconnected: number;
  readonly inFlight: number;
  readonly statuses: Readonly<Record<string, number>>;
  readonly latencyBuckets: readonly Readonly<{
    upperBoundMs: number | "inf";
    count: number;
  }>[];
}

export class ApiMetrics {
  private requests = 0;
  private completed = 0;
  private disconnected = 0;
  private inFlight = 0;
  private readonly statuses = new Map<string, number>();
  private readonly latencyBuckets = LATENCY_BUCKET_UPPER_BOUNDS_MS.map(() => 0);

  middleware(): RequestHandler {
    return (_request, response, next) => {
      this.requests += 1;
      this.inFlight += 1;
      const startedAt = process.hrtime.bigint();
      let settled = false;
      const settle = (completed: boolean) => {
        if (settled) return;
        settled = true;
        response.off("finish", onFinish);
        response.off("close", onClose);
        this.inFlight = Math.max(0, this.inFlight - 1);
        if (completed) this.completed += 1;
        else this.disconnected += 1;
        const statusKey = `${Math.floor(response.statusCode / 100)}xx`;
        this.statuses.set(statusKey, (this.statuses.get(statusKey) ?? 0) + 1);
        const durationMs =
          Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const index = LATENCY_BUCKET_UPPER_BOUNDS_MS.findIndex(
          (upperBound) => durationMs <= upperBound
        );
        this.latencyBuckets[
          index < 0 ? this.latencyBuckets.length - 1 : index
        ] += 1;
      };
      const onFinish = () => settle(true);
      const onClose = () => settle(response.writableEnded);
      response.once("finish", onFinish);
      response.once("close", onClose);
      try {
        next();
      } catch (error) {
        settle(false);
        throw error;
      }
    };
  }

  snapshot(): ApiMetricsSnapshot {
    return {
      requests: this.requests,
      completed: this.completed,
      disconnected: this.disconnected,
      inFlight: this.inFlight,
      statuses: Object.fromEntries(
        [...this.statuses.entries()].sort(([left], [right]) =>
          left.localeCompare(right)
        )
      ),
      latencyBuckets: LATENCY_BUCKET_UPPER_BOUNDS_MS.map(
        (upperBound, index) => ({
          upperBoundMs:
            upperBound === Number.POSITIVE_INFINITY ? "inf" : upperBound,
          count: this.latencyBuckets[index] ?? 0
        })
      )
    };
  }
}
