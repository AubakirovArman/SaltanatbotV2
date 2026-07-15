import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SaltanatArbitrageClient } from "../../packages/arbitrage-sdk/client.js";
import type { FundingCurveRequest as SdkFundingCurveRequest } from "../../packages/arbitrage-sdk/fundingCurveTypes.js";
import { FundingCurveService, createFundingCurveHandler, fundingCurveResponseSchema } from "../src/arbitrage/fundingCurve/index.js";
import type { VenueClockAssessmentProvider } from "../src/arbitrage/timing/index.js";
import { PublicVenueAdapterError, type PublicFundingSchedule, type PublicVenueAdapter } from "../src/venues/publicTypes.js";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("point-in-time public funding curve", () => {
  it("projects a verified discrete schedule with explicit units, freshness and stress provenance", async () => {
    const adapter = fixtureAdapter();
    const service = new FundingCurveService(new Map([[adapter.venue, adapter]]), { now: () => NOW, governor: false });

    const result = await service.evaluate(request());

    expect(adapter.funding).toHaveBeenCalledWith("BTC_USDT", { historyLimit: 25, signal: undefined });
    expect(result).toMatchObject({
      engine: "funding-curve-v1",
      readOnly: true,
      researchOnly: true,
      executable: false,
      evaluatedAt: NOW,
      horizonEnd: NOW + 180 * MINUTE,
      contract: {
        rateUnit: "decimal-per-settlement",
        stressUnit: "basis-points-additive-per-settlement",
        scheduleRequirement: "adapter-verified-discrete-settlements",
        execution: "none"
      },
      curves: [
        {
          venue: "gate",
          instrumentId: "gate:perpetual:BTC_USDT",
          rateSignConvention: "positive-longs-pay-shorts",
          projectionSemantics: "rate-sum-only-no-notional-or-pnl",
          freshness: {
            observedAt: NOW - 500,
            ageMs: 500,
            clockBasis: "local-receipt-fallback",
            crossVenueComparable: false,
            fallbackReason: "clock-provider-unavailable"
          },
          schedule: { verified: true, interval: 60, unit: "minutes" },
          current: { estimateRate: 0.0001, estimateRateBps: 1, nextEstimateRate: 0.0002 },
          source: {
            adapter: "publicVenueAdapters",
            operation: "funding",
            public: true,
            credentialed: false,
            historyComplete: true
          }
        }
      ],
      rejections: []
    });
    expect(result.curves[0]!.settlements).toEqual([
      expect.objectContaining({ settlementAt: NOW + 30 * MINUTE, baseRate: 0.0001, rateSource: "current-estimate" }),
      expect.objectContaining({ settlementAt: NOW + 90 * MINUTE, baseRate: 0.0002, rateSource: "next-estimate" }),
      expect.objectContaining({ settlementAt: NOW + 150 * MINUTE, baseRate: 0.0002, rateSource: "latest-estimate-persistence" })
    ]);
    expect(result.curves[0]!.history).toEqual([expect.objectContaining({ settlementAt: NOW - 120 * MINUTE, effectiveRate: -0.0002, rateKind: "realized" }), expect.objectContaining({ settlementAt: NOW - 60 * MINUTE, effectiveRate: 0.0003, rateKind: "realized" })]);
    expect(result.curves[0]!.scenarios).toEqual([
      expect.objectContaining({ id: "down-1bp", bumpBps: -1, settlementCount: 3, cumulativeRate: 0.0002 }),
      expect.objectContaining({ id: "base", bumpBps: 0, settlementCount: 3, cumulativeRate: 0.0005 }),
      expect.objectContaining({ id: "up-2bp", bumpBps: 2, settlementCount: 3, cumulativeRate: 0.0011 })
    ]);
    expect(fundingCurveResponseSchema.safeParse(result).success).toBe(true);
    expect(result).not.toHaveProperty("order");
  });

  it.each([
    [
      "unverified-schedule",
      (schedule: PublicFundingSchedule) => {
        schedule.scheduleVerified = false;
      }
    ],
    [
      "unsupported-schedule",
      (schedule: PublicFundingSchedule) => {
        schedule.nextFundingTime += MINUTE;
      }
    ],
    [
      "stale-source",
      (schedule: PublicFundingSchedule) => {
        schedule.exchangeTs = NOW - 61_000;
        schedule.receivedAt = NOW - 61_000;
      }
    ],
    [
      "future-source-time",
      (schedule: PublicFundingSchedule) => {
        schedule.exchangeTs = NOW + 3_000;
        schedule.receivedAt = NOW + 3_000;
      }
    ],
    [
      "identity-mismatch",
      (schedule: PublicFundingSchedule) => {
        schedule.instrumentId = "ETH_USDT";
      }
    ]
  ])("fails closed with %s instead of emitting a tradable curve", async (code, mutate) => {
    const adapter = fixtureAdapter();
    const schedule = fundingFixture();
    mutate(schedule);
    adapter.funding = vi.fn(async () => schedule);
    const service = new FundingCurveService(new Map([[adapter.venue, adapter]]), { now: () => NOW, governor: false });

    const result = await service.evaluate(request());

    expect(result.curves).toEqual([]);
    expect(result.rejections).toEqual([expect.objectContaining({ code, retryable: code === "stale-source" })]);
    expect(result.executable).toBe(false);
  });

  it("keeps partial success bounded and reports typed upstream failures per selection", async () => {
    const gate = fixtureAdapter();
    const unavailable = fixtureAdapter("okx");
    unavailable.funding = vi.fn(async () => {
      throw new PublicVenueAdapterError("okx", "rate-limit", "public quota reached", 429);
    });
    const service = new FundingCurveService(
      new Map([
        [gate.venue, gate],
        [unavailable.venue, unavailable]
      ]),
      { now: () => NOW, governor: false }
    );
    const value = request();
    value.selections.push({ venue: "okx", instrumentId: "okx:perpetual:BTC-USDT-SWAP", marketType: "perpetual", rateUnit: "decimal-per-settlement" });

    const result = await service.evaluate(value);

    expect(result.curves).toHaveLength(1);
    expect(result.rejections).toEqual([expect.objectContaining({ venue: "okx", code: "upstream-unavailable", retryable: true })]);
  });

  it("preserves bounded network and timestamp provenance from normalized public adapters", async () => {
    const adapter = fixtureAdapter("hyperliquid");
    adapter.funding = vi.fn(async () => {
      const schedule = fundingFixture();
      return Object.assign(schedule, {
        venue: "hyperliquid",
        instrumentId: "BTC",
        history: schedule.history.map((point) => ({ ...point, instrumentId: "BTC" })),
        network: "mainnet" as const,
        currentEstimateSource: "predictedFundings:HlPerp",
        timestampSource: "local-receive" as const
      });
    });
    const service = new FundingCurveService(new Map([[adapter.venue, adapter]]), { now: () => NOW, governor: false });
    const value = request();
    value.selections[0] = {
      venue: "hyperliquid",
      instrumentId: "hyperliquid:mainnet:perpetual:BTC",
      marketType: "perpetual",
      rateUnit: "decimal-per-settlement"
    };

    await expect(service.evaluate(value)).resolves.toMatchObject({
      curves: [{ source: { network: "mainnet", currentEstimateSource: "predictedFundings:HlPerp", timestampSource: "local-receive" } }],
      rejections: []
    });
  });

  it("permits cross-venue curve comparison only with compatible calibrated intervals", async () => {
    const gate = fixtureAdapter();
    const okx = fixtureAdapter("okx");
    okx.funding = vi.fn(async () => fundingFixtureFor("okx", "BTC-USDT-SWAP"));
    const value = request();
    value.selections.push({ venue: "okx", instrumentId: "okx:perpetual:BTC-USDT-SWAP", marketType: "perpetual", rateUnit: "decimal-per-settlement" });
    value.maxCrossVenueClockSkewMs = 100;

    const calibrated = new FundingCurveService(
      new Map([
        [gate.venue, gate],
        [okx.venue, okx]
      ]),
      { now: () => NOW, governor: false, clockCalibration: fundingClock() }
    );
    await expect(calibrated.evaluate(value)).resolves.toMatchObject({
      curves: [{ freshness: { clockBasis: "calibrated-venue-interval", crossVenueComparable: true } }, { freshness: { clockBasis: "calibrated-venue-interval", crossVenueComparable: true } }],
      crossVenueClock: { status: "eligible", eligible: true, comparedVenueCount: 2, calibratedVenueCount: 2, maximumPossibleSkewMs: 0 }
    });

    const expired = new FundingCurveService(
      new Map([
        [gate.venue, gate],
        [okx.venue, okx]
      ]),
      { now: () => NOW, governor: false, clockCalibration: fundingClock("expired") }
    );
    await expect(expired.evaluate(value)).resolves.toMatchObject({
      curves: [{ freshness: { clockBasis: "local-receipt-fallback", fallbackReason: "clock-not-calibrated" } }, { freshness: { clockBasis: "local-receipt-fallback", fallbackReason: "clock-not-calibrated" } }],
      crossVenueClock: { status: "blocked", eligible: false, reason: "clock-not-calibrated", comparedVenueCount: 2, calibratedVenueCount: 0 }
    });

    const skewed = new FundingCurveService(
      new Map([
        [gate.venue, gate],
        [okx.venue, okx]
      ]),
      { now: () => NOW, governor: false, clockCalibration: fundingClock("skewed") }
    );
    await expect(skewed.evaluate(value)).resolves.toMatchObject({
      crossVenueClock: { status: "blocked", eligible: false, reason: "skew-exceeded", comparedVenueCount: 2, calibratedVenueCount: 2, maximumPossibleSkewMs: 500 }
    });
  });

  it("rejects oversized projections and malformed public history before output", async () => {
    const adapter = fixtureAdapter();
    const schedule = fundingFixture();
    schedule.intervalMinutes = 1;
    schedule.nextFundingTime = schedule.fundingTime + MINUTE;
    adapter.funding = vi.fn(async () => schedule);
    const service = new FundingCurveService(new Map([[adapter.venue, adapter]]), { now: () => NOW, governor: false });
    const value = request();
    value.horizon.value = 600;

    await expect(service.evaluate(value)).resolves.toMatchObject({
      curves: [],
      rejections: [{ code: "projection-too-large" }]
    });

    schedule.intervalMinutes = 60;
    schedule.nextFundingTime = schedule.fundingTime + 60 * MINUTE;
    schedule.history = Array.from({ length: 26 }, (_, index) => ({
      instrumentId: "BTC_USDT",
      fundingTime: NOW - (index + 1) * MINUTE,
      fundingRate: 0
    }));
    value.horizon.value = 60;
    await expect(service.evaluate(value)).resolves.toMatchObject({
      curves: [],
      rejections: [{ code: "invalid-source" }]
    });
  });

  it("aborts the active public adapter when the HTTP client disconnects", async () => {
    const adapter = fixtureAdapter();
    let resolveAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    adapter.funding = vi.fn(
      (_instrumentId, options) =>
        new Promise((_resolve, reject) => {
          const cancel = () => {
            resolveAbort();
            reject(new PublicVenueAdapterError("gate", "cancelled", "request cancelled"));
          };
          if (options?.signal?.aborted) cancel();
          else options?.signal?.addEventListener("abort", cancel, { once: true });
        })
    );
    const service = new FundingCurveService(new Map([[adapter.venue, adapter]]), { now: () => NOW, governor: false });
    const controller = new AbortController();
    const pending = post(request(), service, controller.signal);
    await vi.waitFor(() => expect(adapter.funding).toHaveBeenCalledOnce());

    controller.abort();
    await pending.catch(() => undefined);

    await expect(aborted).resolves.toBeUndefined();
    expect(adapter.funding).toHaveBeenCalledWith("BTC_USDT", expect.objectContaining({ signal: expect.objectContaining({ aborted: true }) }));
  });

  it("rejects credentials, unknown units, duplicates and oversized arrays at the HTTP boundary", async () => {
    const adapter = fixtureAdapter();
    const service = new FundingCurveService(new Map([["gate", adapter]]), { now: () => NOW, governor: false });
    const cases: unknown[] = [
      { ...request(), apiKey: "must-not-be-accepted" },
      { ...request(), horizon: { value: 60, unit: "hours" } },
      { ...request(), stressScenarios: [{ id: "bad", bumpBps: 1, unit: "percent" }] },
      { ...request(), selections: Array.from({ length: 9 }, () => request().selections[0]) },
      { ...request(), selections: [request().selections[0], request().selections[0]] }
    ];

    for (const value of cases) {
      const response = await post(value, service);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ readOnly: true, researchOnly: true, executable: false });
    }
    expect(adapter.funding).not.toHaveBeenCalled();
  });

  it("round-trips the mounted HTTP contract through the generated SDK", async () => {
    const adapter = fixtureAdapter();
    const service = new FundingCurveService(new Map([[adapter.venue, adapter]]), { now: () => NOW, governor: false });
    const app = express();
    app.use(express.json());
    app.post("/api/arbitrage/funding-curve", createFundingCurveHandler(service));
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    const client = new SaltanatArbitrageClient({ baseUrl: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}` });

    await expect(client.fundingCurve(request() as SdkFundingCurveRequest)).resolves.toMatchObject({
      engine: "funding-curve-v1",
      executable: false,
      curves: [{ venue: "gate", settlements: expect.arrayContaining([expect.objectContaining({ rateSource: "current-estimate" })]) }]
    });
  });
});

function request() {
  return {
    selections: [
      {
        venue: "gate",
        instrumentId: "gate:perpetual:BTC_USDT",
        marketType: "perpetual" as const,
        rateUnit: "decimal-per-settlement" as const
      }
    ],
    horizon: { value: 180, unit: "minutes" as const },
    historyLimit: 25,
    maxAgeMs: 60_000,
    maxFutureSkewMs: 2_000,
    maxCrossVenueClockSkewMs: 2_000,
    stressScenarios: [
      { id: "down-1bp", bumpBps: -1, unit: "basis-points-additive-per-settlement" as const },
      { id: "base", bumpBps: 0, unit: "basis-points-additive-per-settlement" as const },
      { id: "up-2bp", bumpBps: 2, unit: "basis-points-additive-per-settlement" as const }
    ]
  };
}

function fundingFixture(): PublicFundingSchedule {
  return {
    venue: "gate",
    instrumentId: "BTC_USDT",
    currentEstimateRate: 0.0001,
    nextEstimateRate: 0.0002,
    minimumRate: -0.0005,
    maximumRate: 0.0005,
    fundingTime: NOW + 30 * MINUTE,
    nextFundingTime: NOW + 90 * MINUTE,
    intervalMinutes: 60,
    scheduleVerified: true,
    formulaType: "fixture-discrete",
    method: "fixture-current-and-next",
    exchangeTs: NOW - 1_000,
    receivedAt: NOW - 500,
    history: [
      { instrumentId: "BTC_USDT", fundingTime: NOW - 60 * MINUTE, fundingRate: 0.0004, realizedRate: 0.0003 },
      { instrumentId: "BTC_USDT", fundingTime: NOW - 120 * MINUTE, fundingRate: -0.0001, realizedRate: -0.0002 }
    ],
    sourceErrors: []
  };
}

function fundingFixtureFor(venue: string, instrumentId: string): PublicFundingSchedule {
  const value = fundingFixture();
  return {
    ...value,
    venue,
    instrumentId,
    history: value.history.map((point) => ({ ...point, instrumentId }))
  };
}

function fundingClock(mode: "calibrated" | "expired" | "skewed" = "calibrated"): VenueClockAssessmentProvider {
  return {
    assessTimestamp(sourceId, exchangeTimestamp, evaluatedAt) {
      if (mode === "expired") {
        return { sourceId, exchangeTimestamp, evaluatedAt, clockStatus: "expired", eligible: false, quality: "degraded", reason: "clock-not-calibrated" };
      }
      const shift = mode === "skewed" && sourceId === "okx:public" ? 500 : 0;
      const localEventAt = exchangeTimestamp - shift;
      const ageMs = evaluatedAt - localEventAt;
      return {
        sourceId,
        exchangeTimestamp,
        evaluatedAt,
        clockStatus: "calibrated",
        eligible: true,
        quality: "verified",
        ageLowerMs: ageMs,
        ageUpperMs: ageMs,
        localEventEarliestAt: localEventAt,
        localEventLatestAt: localEventAt
      };
    },
    assessSkew() {
      throw new Error("Funding curve uses single-observation clock assessments before bounded response comparison");
    }
  };
}

function fixtureAdapter(venue = "gate"): PublicVenueAdapter {
  return {
    venue,
    capabilities: () => ({
      venue,
      publicData: true,
      spot: true,
      margin: false,
      perpetual: true,
      datedFuture: false,
      option: false,
      nativeSpread: false,
      topBook: true,
      depth: true,
      publicTrades: false,
      funding: true,
      borrow: false,
      depositWithdrawal: false,
      privateExecution: false,
      demoEnvironment: true
    }),
    instruments: vi.fn(),
    tickers: vi.fn(),
    ticker: vi.fn(),
    depth: vi.fn(),
    funding: vi.fn(async () => ({ ...fundingFixture(), venue }))
  };
}

async function post(body: unknown, service: FundingCurveService, signal?: AbortSignal) {
  const app = express();
  app.use(express.json());
  app.post("/funding-curve", createFundingCurveHandler(service));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  return fetch(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/funding-curve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
}
