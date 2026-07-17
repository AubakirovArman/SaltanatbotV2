import { readFileSync } from "node:fs";
import type { Candle, PriceThresholdAlertDefinitionV1 } from "@saltanatbotv2/contracts";
import { describe, expect, it, vi } from "vitest";
import { createPriceAlertEvaluatorScheduler, INITIAL_PRICE_ALERT_CANDLE_LIMIT, MAX_PRICE_ALERT_SWEEP, MAX_PUBLIC_ALERT_READS_PER_PROVIDER_PER_SWEEP, MAX_PUBLIC_ALERT_SCOPE_CONCURRENCY, type PriceAlertPublicReader, type PriceAlertSchedulerRepository } from "../src/alerts/evaluatorScheduler.js";
import type { ClaimedPriceAlertRule } from "../src/alerts/repositoryTypes.js";

const SCOPE = "market:binance:spot:last:BTCUSDT:1m";

describe("price alert evaluator scheduler", () => {
  it("recovers expired leases before its first claim", async () => {
    const recovery = deferred<void>();
    const repository = repositoryDouble([]);
    repository.recoverExpiredLeases = vi.fn(async () => {
      await recovery.promise;
      return { recovered: 2 };
    });
    const scheduler = createPriceAlertEvaluatorScheduler(repository, readyReader(), { workerId: "alert-worker", intervalMs: 60_000 });

    const starting = scheduler.start();
    await flush();
    expect(repository.claimDuePriceAlert).not.toHaveBeenCalled();

    recovery.resolve();
    await starting;
    await scheduler.drain();
    scheduler.quiesce();

    expect(repository.recoverExpiredLeases).toHaveBeenCalledTimes(2);
    expect(repository.claimDuePriceAlert).toHaveBeenCalled();
  });

  it("is single-flight and drains the current public read after quiescing", async () => {
    const gate = deferred<Awaited<ReturnType<PriceAlertPublicReader["read"]>>>();
    const repository = repositoryDouble([claim(1)]);
    const reader: PriceAlertPublicReader = { read: vi.fn(() => gate.promise) };
    const scheduler = createPriceAlertEvaluatorScheduler(repository, reader, { workerId: "alert-worker", intervalMs: 60_000, publicScopeConcurrency: 1 });

    await scheduler.start();
    await until(() => vi.mocked(reader.read).mock.calls.length === 1);
    const first = scheduler.trigger();
    const replay = scheduler.trigger();
    expect(first).toBe(replay);

    scheduler.quiesce();
    let drained = false;
    const draining = scheduler.drain().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);

    gate.resolve(readyResult([candle(180_000, 100)]));
    await draining;
    await expect(first).resolves.toMatchObject({ claimed: 1, applied: 1 });
    await expect(scheduler.trigger()).resolves.toEqual(emptySweep());
  });

  it("caps a sweep at 500 claims and coalesces an equal scope/cursor read", async () => {
    const claims = Array.from({ length: 600 }, (_, index) => claim(index + 1));
    const repository = repositoryDouble(claims);
    let activeReads = 0;
    let maximumActiveReads = 0;
    const reader: PriceAlertPublicReader = {
      read: vi.fn(async () => {
        activeReads += 1;
        maximumActiveReads = Math.max(maximumActiveReads, activeReads);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        activeReads -= 1;
        return readyResult([candle(180_000, 100)]);
      })
    };
    const scheduler = createPriceAlertEvaluatorScheduler(repository, reader, {
      workerId: "alert-worker",
      intervalMs: 60_000,
      sweepLimit: 9_999,
      publicScopeConcurrency: 99
    });

    await scheduler.start();
    const result = await scheduler.trigger();
    scheduler.quiesce();
    await scheduler.drain();

    expect(result.claimAttempts).toBe(MAX_PRICE_ALERT_SWEEP);
    expect(result.claimed).toBe(MAX_PRICE_ALERT_SWEEP);
    expect(repository.completePriceEvaluation).toHaveBeenCalledTimes(MAX_PRICE_ALERT_SWEEP);
    expect(maximumActiveReads).toBe(1);
    expect(result).toMatchObject({ publicReads: 1, coalescedReads: MAX_PRICE_ALERT_SWEEP - 1, admissionDeferred: 0 });
  });

  it("caps unique reads at four concurrent and eight per provider in one sweep", async () => {
    const claims = Array.from({ length: 20 }, (_, index) => uniqueScopeClaim(index + 1));
    const repository = repositoryDouble(claims);
    let activeReads = 0;
    let maximumActiveReads = 0;
    const reader: PriceAlertPublicReader = {
      read: vi.fn(async (definition) => {
        activeReads += 1;
        maximumActiveReads = Math.max(maximumActiveReads, activeReads);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        activeReads -= 1;
        return readyResult([candle(180_000, 100)], `market:binance:spot:last:${definition.symbol}:1m`);
      })
    };
    const scheduler = createPriceAlertEvaluatorScheduler(repository, reader, {
      workerId: "alert-worker",
      intervalMs: 60_000,
      sweepLimit: 100,
      publicScopeConcurrency: 99
    });

    await scheduler.start();
    const result = await scheduler.trigger();
    scheduler.quiesce();
    await scheduler.drain();

    expect(result.publicReads).toBe(MAX_PUBLIC_ALERT_READS_PER_PROVIDER_PER_SWEEP);
    expect(result).toMatchObject({ claimed: 20, applied: 8, deferred: 12, admissionDeferred: 12, lostClaims: 0 });
    expect(maximumActiveReads).toBe(MAX_PUBLIC_ALERT_SCOPE_CONCURRENCY);
    expect(repository.deferPriceEvaluation).toHaveBeenCalledWith(expect.objectContaining({ retryAfterSeconds: 1 }));
  });

  it("continues past a saturated provider so another provider cannot be starved", async () => {
    const claims = [...Array.from({ length: 9 }, (_, index) => uniqueScopeClaim(index + 1)), uniqueScopeClaim(10, "bybit")];
    const repository = repositoryDouble(claims);
    const reader: PriceAlertPublicReader = {
      read: vi.fn(async (definition) => readyResult([candle(180_000, 100)], `market:${definition.exchange}:spot:last:${definition.symbol}:1m`))
    };
    const scheduler = createPriceAlertEvaluatorScheduler(repository, reader, {
      workerId: "alert-worker",
      intervalMs: 60_000,
      sweepLimit: 10,
      publicScopeConcurrency: 4
    });

    await scheduler.start();
    const result = await scheduler.trigger();
    scheduler.quiesce();
    await scheduler.drain();

    const exchanges = vi.mocked(reader.read).mock.calls.map(([readDefinition]) => readDefinition.exchange);
    expect(exchanges.filter((exchange) => exchange === "binance")).toHaveLength(8);
    expect(exchanges.filter((exchange) => exchange === "bybit")).toHaveLength(1);
    expect(result).toMatchObject({ claimAttempts: 10, claimed: 10, publicReads: 9, applied: 9, deferred: 1, admissionDeferred: 1, lostClaims: 0 });
    expect(result.applied + result.deferred + result.backedOff + result.lostClaims).toBe(result.claimed);
    expect(repository.deferPriceEvaluation).toHaveBeenCalledOnce();
  });

  it("continues the durable cursor and counts an idempotent completion as terminal", async () => {
    const continued = claim(1, {
      state: { status: "armed", armedAt: 1, initialized: true, eligible: false, lastEvaluatedBarTime: 120_000 }
    });
    const repository = repositoryDouble([continued]);
    repository.completePriceEvaluation = vi.fn(async () => ({ outcome: "duplicate" }));
    const reader = readyReader([candle(180_000, 101)]);
    const scheduler = createPriceAlertEvaluatorScheduler(repository, reader, { workerId: "alert-worker", intervalMs: 60_000, publicScopeConcurrency: 1 });

    await scheduler.start();
    const result = await scheduler.trigger();
    scheduler.quiesce();
    await scheduler.drain();

    expect(reader.read).toHaveBeenCalledWith(continued.definition, { limit: 1, afterBarTime: 120_000 });
    expect(result).toMatchObject({ claimed: 1, duplicates: 1, triggered: 0, backedOff: 0 });
    expect(repository.failPriceEvaluation).not.toHaveBeenCalled();
  });

  it("drains an outage backlog one exact cursor bar per durable completion", async () => {
    const continued = claim(1, {
      stateRevision: 9,
      state: { status: "armed", armedAt: 1, initialized: true, eligible: false, lastEvaluatedBarTime: 60_000 }
    });
    const repository = repositoryDouble([continued]);
    const scheduler = createPriceAlertEvaluatorScheduler(repository, readyReader([candle(120_000, 100), candle(180_000, 100)]), {
      workerId: "alert-worker",
      intervalMs: 60_000,
      publicScopeConcurrency: 1
    });

    await scheduler.start();
    await scheduler.trigger();
    scheduler.quiesce();
    await scheduler.drain();

    expect(repository.completePriceEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedStateRevision: 9,
        observation: expect.objectContaining({ candleOpenTime: 120_000 }),
        nextState: expect.objectContaining({ lastEvaluatedBarTime: 120_000 })
      })
    );
    expect(vi.mocked(repository.completePriceEvaluation).mock.calls[0]?.[0].observation.candleOpenTime).toBe(120_000);
  });

  it("reads the exact durable armed-at bar after an arbitrarily long restart outage", async () => {
    const initial = claim(1, {
      state: { status: "armed", armedAt: 60_001, initialized: false, eligible: false }
    });
    const repository = repositoryDouble([initial]);
    const reader: PriceAlertPublicReader = {
      read: vi.fn(async (_definition, options) => {
        expect(options).toEqual({ limit: INITIAL_PRICE_ALERT_CANDLE_LIMIT, startAtBarTime: 60_000 });
        return { status: "ready", scopeKey: SCOPE, observedAt: 9_000_000, exchange: "binance", candles: [candle(60_000, 100)] };
      })
    };
    const scheduler = createPriceAlertEvaluatorScheduler(repository, reader, {
      workerId: "alert-worker",
      intervalMs: 60_000,
      publicScopeConcurrency: 1
    });

    await scheduler.start();
    const result = await scheduler.trigger();
    scheduler.quiesce();
    await scheduler.drain();

    expect(result).toMatchObject({ applied: 1, publicReads: 1, backedOff: 0 });
    expect(repository.completePriceEvaluation).toHaveBeenCalledWith(expect.objectContaining({ observation: expect.objectContaining({ candleOpenTime: 60_000 }) }));
  });

  it("aligns an uninitialized weekly alert to the exchange Monday bar", async () => {
    const monday = 4 * 86_400_000;
    const weeklyScope = "market:binance:spot:last:BTCUSDT:1w";
    const weekly = claim(1, {
      definition: { ...definition(), timeframe: "1w" },
      stateKey: weeklyScope,
      state: { status: "armed", armedAt: monday + 12_345, initialized: false, eligible: false }
    });
    const repository = repositoryDouble([weekly]);
    const reader: PriceAlertPublicReader = {
      read: vi.fn(async (_definition, options) => {
        expect(options).toEqual({ limit: 1, startAtBarTime: monday });
        return { status: "ready", scopeKey: weeklyScope, observedAt: monday + 3 * 604_800_000, exchange: "binance", candles: [candle(monday, 100)] };
      })
    };
    const scheduler = createPriceAlertEvaluatorScheduler(repository, reader, {
      workerId: "alert-worker",
      intervalMs: 60_000,
      publicScopeConcurrency: 1
    });

    await scheduler.start();
    await scheduler.trigger();
    scheduler.quiesce();
    await scheduler.drain();
    expect(repository.completePriceEvaluation).toHaveBeenCalledWith(expect.objectContaining({ observation: expect.objectContaining({ candleOpenTime: monday }) }));
  });

  it("coalesces only an identical scope and durable cursor", async () => {
    const sameCursor = { status: "armed" as const, armedAt: 1, initialized: true, eligible: false, lastEvaluatedBarTime: 120_000 };
    const repository = repositoryDouble([claim(1, { state: sameCursor }), claim(2, { state: sameCursor })]);
    const reader = readyReader([candle(180_000, 100)]);
    const scheduler = createPriceAlertEvaluatorScheduler(repository, reader, {
      workerId: "alert-worker",
      intervalMs: 60_000,
      publicScopeConcurrency: 2
    });

    await scheduler.start();
    const result = await scheduler.trigger();
    scheduler.quiesce();
    await scheduler.drain();

    expect(reader.read).toHaveBeenCalledOnce();
    expect(repository.completePriceEvaluation).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ publicReads: 1, coalescedReads: 1, applied: 2 });
  });

  it("fails unavailable public evidence closed through repository backoff", async () => {
    const repository = repositoryDouble([claim(1)]);
    const reader: PriceAlertPublicReader = {
      read: vi.fn(async () => ({ status: "unavailable", reason: "upstream-unavailable", scopeKey: SCOPE, observedAt: 240_000 }))
    };
    const scheduler = createPriceAlertEvaluatorScheduler(repository, reader, { workerId: "alert-worker", intervalMs: 60_000, publicScopeConcurrency: 1 });

    await scheduler.start();
    const result = await scheduler.trigger();
    scheduler.quiesce();
    await scheduler.drain();

    expect(result).toMatchObject({ claimed: 1, applied: 0, backedOff: 1 });
    expect(repository.failPriceEvaluation).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "public_upstream_unavailable", stateKey: SCOPE }));
    expect(repository.completePriceEvaluation).not.toHaveBeenCalled();
  });

  it("defers a healthy cursor with no newly closed bar without recording a failure", async () => {
    const current = claim(1, {
      state: { status: "armed", armedAt: 1, initialized: true, eligible: false, lastEvaluatedBarTime: 120_000 }
    });
    const repository = repositoryDouble([current]);
    const reader: PriceAlertPublicReader = {
      read: vi.fn(async () => ({ status: "unavailable", reason: "no-new-closed-candle", scopeKey: SCOPE, observedAt: 239_999 }))
    };
    const scheduler = createPriceAlertEvaluatorScheduler(repository, reader, { workerId: "alert-worker", intervalMs: 60_000, publicScopeConcurrency: 1 });

    await scheduler.start();
    const result = await scheduler.trigger();
    scheduler.quiesce();
    await scheduler.drain();

    expect(result).toMatchObject({ claimed: 1, deferred: 1, backedOff: 0, lostClaims: 0 });
    expect(repository.deferPriceEvaluation).toHaveBeenCalledWith({
      ownerUserId: current.ownerUserId,
      ruleId: current.id,
      expectedRevision: 1,
      authorizationRevision: 1,
      workerId: "alert-worker",
      leaseToken: current.leaseToken,
      leaseGeneration: 1,
      retryAfterSeconds: 1
    });
    expect(repository.failPriceEvaluation).not.toHaveBeenCalled();
  });

  it("defers an uninitialized rule while its exact armed-at bar is still forming", async () => {
    const repository = repositoryDouble([claim(1)]);
    const reader: PriceAlertPublicReader = {
      read: vi.fn(async () => ({ status: "unavailable", reason: "no-new-closed-candle", scopeKey: SCOPE, observedAt: 200_000 }))
    };
    const scheduler = createPriceAlertEvaluatorScheduler(repository, reader, {
      workerId: "alert-worker",
      intervalMs: 60_000,
      publicScopeConcurrency: 1
    });

    await scheduler.start();
    const result = await scheduler.trigger();
    scheduler.quiesce();
    await scheduler.drain();

    expect(result).toMatchObject({ deferred: 1, backedOff: 0 });
    expect(repository.deferPriceEvaluation).toHaveBeenCalledWith(expect.objectContaining({ retryAfterSeconds: 40 }));
    expect(repository.failPriceEvaluation).not.toHaveBeenCalled();
  });

  it("defers a four-hour initial bar until its exact expected close", async () => {
    const interval = 4 * 60 * 60 * 1_000;
    const observedAt = interval - 10 * 60 * 1_000;
    const current = claim(1, {
      definition: { ...definition(), timeframe: "4h" },
      stateKey: "market:binance:spot:last:BTCUSDT:4h",
      state: { status: "armed", armedAt: observedAt, initialized: false, eligible: false }
    });
    const repository = repositoryDouble([current]);
    const reader: PriceAlertPublicReader = {
      read: vi.fn(async () => ({ status: "unavailable", reason: "no-new-closed-candle", scopeKey: current.stateKey, observedAt }))
    };
    const scheduler = createPriceAlertEvaluatorScheduler(repository, reader, { workerId: "alert-worker", intervalMs: 60_000, publicScopeConcurrency: 1 });

    await scheduler.start();
    await scheduler.trigger();
    scheduler.quiesce();
    await scheduler.drain();

    expect(repository.deferPriceEvaluation).toHaveBeenCalledWith(expect.objectContaining({ retryAfterSeconds: 600 }));
  });

  it("rechecks shortly when a provider has not published a candle after its expected close", async () => {
    const current = claim(1);
    const repository = repositoryDouble([current]);
    const reader: PriceAlertPublicReader = {
      read: vi.fn(async () => ({ status: "unavailable", reason: "no-new-closed-candle", scopeKey: current.stateKey, observedAt: 240_001 }))
    };
    const scheduler = createPriceAlertEvaluatorScheduler(repository, reader, { workerId: "alert-worker", intervalMs: 60_000, publicScopeConcurrency: 1 });

    await scheduler.start();
    await scheduler.trigger();
    scheduler.quiesce();
    await scheduler.drain();

    expect(repository.deferPriceEvaluation).toHaveBeenCalledWith(expect.objectContaining({ retryAfterSeconds: 30 }));
  });

  it("caps a weekly close-aligned defer at one day", async () => {
    const monday = 4 * 86_400_000;
    const current = claim(1, {
      definition: { ...definition(), timeframe: "1w" },
      stateKey: "market:binance:spot:last:BTCUSDT:1w",
      state: { status: "armed", armedAt: monday + 1_000, initialized: false, eligible: false }
    });
    const repository = repositoryDouble([current]);
    const reader: PriceAlertPublicReader = {
      read: vi.fn(async () => ({ status: "unavailable", reason: "no-new-closed-candle", scopeKey: current.stateKey, observedAt: monday + 60 * 60 * 1_000 }))
    };
    const scheduler = createPriceAlertEvaluatorScheduler(repository, reader, { workerId: "alert-worker", intervalMs: 60_000, publicScopeConcurrency: 1 });

    await scheduler.start();
    await scheduler.trigger();
    scheduler.quiesce();
    await scheduler.drain();

    expect(repository.deferPriceEvaluation).toHaveBeenCalledWith(expect.objectContaining({ retryAfterSeconds: 86_400 }));
  });

  it("backs off an unexpectedly empty provider page instead of treating it as no-new", async () => {
    const repository = repositoryDouble([
      claim(1, {
        state: { status: "armed", armedAt: 1, initialized: true, eligible: false, lastEvaluatedBarTime: 0 }
      })
    ]);
    const reader: PriceAlertPublicReader = {
      read: vi.fn(async () => ({ status: "unavailable", reason: "empty-candle-window", scopeKey: SCOPE, observedAt: 600_000 }))
    };
    const scheduler = createPriceAlertEvaluatorScheduler(repository, reader, { workerId: "alert-worker", intervalMs: 60_000, publicScopeConcurrency: 1 });

    await scheduler.start();
    const result = await scheduler.trigger();
    scheduler.quiesce();
    await scheduler.drain();

    expect(result).toMatchObject({ claimed: 1, deferred: 0, backedOff: 1 });
    expect(repository.failPriceEvaluation).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "public_empty_candle_window" }));
    expect(repository.deferPriceEvaluation).not.toHaveBeenCalled();
  });

  it("recovers expired leases at every sweep and skips claims if recovery fails", async () => {
    const repository = repositoryDouble([claim(1)]);
    vi.mocked(repository.recoverExpiredLeases).mockResolvedValueOnce({ recovered: 0 }).mockRejectedValueOnce(new Error("database unavailable"));
    const onError = vi.fn();
    const scheduler = createPriceAlertEvaluatorScheduler(repository, readyReader(), { workerId: "alert-worker", intervalMs: 60_000, onError });

    await scheduler.start();
    const result = await scheduler.trigger();
    scheduler.quiesce();
    await scheduler.drain();

    expect(result).toEqual(emptySweep());
    expect(repository.claimDuePriceAlert).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { phase: "sweep-recovery" });
  });

  it("has no private, trading, SQLite, synthetic or delivery dependency", () => {
    const source = readFileSync(new URL("../src/alerts/evaluatorScheduler.ts", import.meta.url), "utf8");

    for (const forbidden of ["ProviderRouter", "candleStore", "SyntheticProvider", "trading/", "telegram", "apiKey", "apiSecret", "notification_deliveries"]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("is hosted by the existing research worker and participates in its drain", () => {
    const source = readFileSync(new URL("../src/workers/researchWorker.ts", import.meta.url), "utf8");

    expect(source).toContain("createDefaultPriceAlertEvaluatorScheduler");
    expect(source).toContain("await priceAlertScheduler.start()");
    expect(source).toContain("priceAlertScheduler.quiesce()");
    expect(source).toContain("priceAlertScheduler.drain()");
  });
});

function repositoryDouble(claims: ClaimedPriceAlertRule[]): PriceAlertSchedulerRepository & Record<string, ReturnType<typeof vi.fn>> {
  const queue = [...claims];
  return {
    recoverExpiredLeases: vi.fn(async () => ({ recovered: 0 })),
    claimDuePriceAlert: vi.fn(async () => queue.shift()),
    completePriceEvaluation: vi.fn(async () => ({ outcome: "applied" })),
    deferPriceEvaluation: vi.fn(async () => true),
    failPriceEvaluation: vi.fn(async () => true)
  };
}

function readyReader(candles: Candle[] = [candle(180_000, 100)]): PriceAlertPublicReader & { read: ReturnType<typeof vi.fn> } {
  return { read: vi.fn(async () => readyResult(candles)) };
}

function readyResult(candles: Candle[], scopeKey = SCOPE): Awaited<ReturnType<PriceAlertPublicReader["read"]>> {
  return { status: "ready", scopeKey, observedAt: 240_000, exchange: "binance", candles };
}

function claim(index: number, override: Partial<ClaimedPriceAlertRule> = {}): ClaimedPriceAlertRule {
  const id = `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
  return {
    id,
    ownerUserId: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
    clientId: `client-${index}`,
    status: "active",
    currentRevision: 1,
    authorizationRevision: 1,
    evaluationIntervalSeconds: 60,
    nextEvaluationAt: "2026-07-17T00:00:00.000Z",
    evaluationFailureCount: 0,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    definitionHash: "a".repeat(64),
    definition: definition(),
    workerId: "alert-worker",
    leaseToken: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
    leaseGeneration: 1,
    leaseExpiresAt: "2026-07-17T00:01:00.000Z",
    stateKey: SCOPE,
    stateRevision: 0,
    state: { status: "armed", armedAt: 180_000, initialized: false, eligible: false },
    ...override
  };
}

function definition(): PriceThresholdAlertDefinitionV1 {
  return {
    schemaVersion: "alert-rule-v1",
    kind: "price-threshold",
    name: "BTC threshold",
    enabled: true,
    cooldownSeconds: 0,
    deliveryChannels: ["in-app"],
    researchOnly: true,
    executionPermission: false,
    exchange: "binance",
    marketType: "spot",
    priceType: "last",
    symbol: "BTCUSDT",
    timeframe: "1m",
    direction: "above",
    threshold: "101",
    crossing: "inclusive",
    repeat: "once-until-rearmed"
  };
}

function uniqueScopeClaim(index: number, exchange: "binance" | "bybit" = "binance"): ClaimedPriceAlertRule {
  const symbol = `ASSET${index}USDT`;
  return claim(index, {
    definition: { ...definition(), exchange, symbol },
    stateKey: `market:${exchange}:spot:last:${symbol}:1m`
  });
}

function candle(time: number, close: number): Candle {
  return { time, open: close, high: close + 1, low: close - 1, close, volume: 10, final: true, source: "scheduler-test" };
}

function emptySweep() {
  return {
    claimAttempts: 0,
    claimed: 0,
    applied: 0,
    duplicates: 0,
    triggered: 0,
    deferred: 0,
    backedOff: 0,
    lostClaims: 0,
    publicReads: 0,
    coalescedReads: 0,
    admissionDeferred: 0
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}
