export interface BrowserPerformanceAggregate {
  count: number;
  sum: number;
  min: number;
  max: number;
  average: number;
  histogram: number[];
}

export interface BrowserPerformanceLongTasks {
  supported: boolean;
  count: number;
  totalDurationMs: number;
  totalBlockingTimeMs: number;
  maxDurationMs: number;
  over100Ms: number;
}

export interface BrowserPerformanceSummary {
  schemaVersion: 1;
  startedAt: number;
  elapsedMs: number;
  droppedNames: number;
  histogramBoundaries: number[];
  metrics: Record<string, BrowserPerformanceAggregate>;
  renders: Record<string, BrowserPerformanceAggregate>;
  longTasks: BrowserPerformanceLongTasks;
}

export interface BrowserPerformanceProbeController {
  recordMetric(name: string, value?: number): void;
  recordRender(scope: string, durationMs?: number): void;
  read(): BrowserPerformanceSummary;
  reset(): void;
  stop(): void;
}

export interface BrowserPerformanceProbeOptions {
  heartbeatIntervalMs?: number;
  maxMetricNames?: number;
  maxRenderScopes?: number;
}

declare global {
  interface Window {
    __SBV2_BROWSER_PERF_PROBE__?: BrowserPerformanceProbeController;
  }
}

/** Record one bounded numeric metric when the opt-in browser probe is installed. */
export function recordBrowserMetric(name: string, value = 1): void {
  browserProbe()?.recordMetric(name, value);
}

/** Record one component/canvas render and its optional synchronous duration. */
export function recordBrowserRender(scope: string, durationMs = 0): void {
  browserProbe()?.recordRender(scope, durationMs);
}

/** Measure a synchronous render pass without changing application behavior when the probe is absent. */
export function measureBrowserRender<T>(scope: string, render: () => T): T {
  const probe = browserProbe();
  if (!probe) return render();
  const startedAt = performance.now();
  try {
    return render();
  } finally {
    probe.recordRender(scope, performance.now() - startedAt);
  }
}

export function readBrowserPerformanceSummary(): BrowserPerformanceSummary | undefined {
  return browserProbe()?.read();
}

export function resetBrowserPerformanceProbe(): void {
  browserProbe()?.reset();
}

/**
 * Install the bounded probe. The function is deliberately self-contained so
 * Playwright can serialize it into an init script before application startup.
 */
export function bootstrapBrowserPerformanceProbe(options: BrowserPerformanceProbeOptions = {}): void {
  const target = window;
  target.__SBV2_BROWSER_PERF_PROBE__?.stop();

  const boundaries = [1, 2, 4, 8, 16, 32, 50, 100, 250, 500, 1000];
  const maxMetricNames = Math.max(8, Math.min(256, options.maxMetricNames ?? 64));
  const maxRenderScopes = Math.max(4, Math.min(128, options.maxRenderScopes ?? 32));
  const heartbeatIntervalMs = Math.max(100, Math.min(5_000, options.heartbeatIntervalMs ?? 250));
  type MutableAggregate = Omit<BrowserPerformanceAggregate, "average">;

  const createAggregate = (): MutableAggregate => ({
    count: 0,
    sum: 0,
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
    histogram: Array.from({ length: boundaries.length + 1 }, () => 0)
  });
  const observe = (aggregate: MutableAggregate, value: number) => {
    if (!Number.isFinite(value)) return;
    aggregate.count += 1;
    aggregate.sum += value;
    aggregate.min = Math.min(aggregate.min, value);
    aggregate.max = Math.max(aggregate.max, value);
    const bucket = boundaries.findIndex((boundary) => value <= boundary);
    aggregate.histogram[bucket < 0 ? boundaries.length : bucket] += 1;
  };
  const snapshotAggregate = (aggregate: MutableAggregate): BrowserPerformanceAggregate => ({
    count: aggregate.count,
    sum: aggregate.sum,
    min: aggregate.count === 0 ? 0 : aggregate.min,
    max: aggregate.count === 0 ? 0 : aggregate.max,
    average: aggregate.count === 0 ? 0 : aggregate.sum / aggregate.count,
    histogram: [...aggregate.histogram]
  });

  let metrics: Record<string, MutableAggregate> = {};
  let renders: Record<string, MutableAggregate> = {};
  let startedAt = performance.now();
  let droppedNames = 0;
  let longTasks: BrowserPerformanceLongTasks = {
    supported: typeof PerformanceObserver === "function" && PerformanceObserver.supportedEntryTypes?.includes("longtask") === true,
    count: 0,
    totalDurationMs: 0,
    totalBlockingTimeMs: 0,
    maxDurationMs: 0,
    over100Ms: 0
  };

  const aggregateFor = (collection: Record<string, MutableAggregate>, name: string, limit: number) => {
    const normalized = name.trim().slice(0, 96);
    if (!normalized) return undefined;
    const existing = collection[normalized];
    if (existing) return existing;
    if (Object.keys(collection).length >= limit) {
      droppedNames += 1;
      return undefined;
    }
    const aggregate = createAggregate();
    collection[normalized] = aggregate;
    return aggregate;
  };

  let observer: PerformanceObserver | undefined;
  if (longTasks.supported) {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.count += 1;
        longTasks.totalDurationMs += entry.duration;
        longTasks.totalBlockingTimeMs += Math.max(0, entry.duration - 50);
        longTasks.maxDurationMs = Math.max(longTasks.maxDurationMs, entry.duration);
        if (entry.duration > 100) longTasks.over100Ms += 1;
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  }

  let expectedHeartbeatAt = performance.now() + heartbeatIntervalMs;
  const heartbeat = window.setInterval(() => {
    const now = performance.now();
    const delay = Math.max(0, now - expectedHeartbeatAt);
    expectedHeartbeatAt = now + heartbeatIntervalMs;
    const aggregate = aggregateFor(metrics, "eventLoop.delayMs", maxMetricNames);
    if (aggregate) observe(aggregate, delay);
  }, heartbeatIntervalMs);

  const controller: BrowserPerformanceProbeController = {
    recordMetric(name, value = 1) {
      const aggregate = aggregateFor(metrics, name, maxMetricNames);
      if (aggregate) observe(aggregate, value);
    },
    recordRender(scope, durationMs = 0) {
      const aggregate = aggregateFor(renders, scope, maxRenderScopes);
      if (aggregate) observe(aggregate, Math.max(0, durationMs));
    },
    read() {
      return {
        schemaVersion: 1,
        startedAt,
        elapsedMs: performance.now() - startedAt,
        droppedNames,
        histogramBoundaries: [...boundaries],
        metrics: Object.fromEntries(Object.entries(metrics).map(([name, aggregate]) => [name, snapshotAggregate(aggregate)])),
        renders: Object.fromEntries(Object.entries(renders).map(([name, aggregate]) => [name, snapshotAggregate(aggregate)])),
        longTasks: { ...longTasks }
      };
    },
    reset() {
      metrics = {};
      renders = {};
      startedAt = performance.now();
      droppedNames = 0;
      longTasks = { ...longTasks, count: 0, totalDurationMs: 0, totalBlockingTimeMs: 0, maxDurationMs: 0, over100Ms: 0 };
      expectedHeartbeatAt = performance.now() + heartbeatIntervalMs;
    },
    stop() {
      observer?.disconnect();
      window.clearInterval(heartbeat);
      if (target.__SBV2_BROWSER_PERF_PROBE__ === controller) target.__SBV2_BROWSER_PERF_PROBE__ = undefined;
    }
  };
  target.__SBV2_BROWSER_PERF_PROBE__ = controller;
}

function browserProbe(): BrowserPerformanceProbeController | undefined {
  if (typeof window === "undefined") return undefined;
  return window.__SBV2_BROWSER_PERF_PROBE__;
}
