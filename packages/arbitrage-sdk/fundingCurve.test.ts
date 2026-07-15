import { describe, expect, it, vi } from "vitest";
import { SaltanatArbitrageClient } from "./client.js";
import { parseFundingCurveResponse, parseFundingCurveUniverseResponse } from "./fundingCurve.js";
import type { FundingCurveRequest } from "./fundingCurveTypes.js";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

describe("funding-curve SDK boundary", () => {
  it("parses the server-owned universe and preserves reviewed identity provenance", () => {
    expect(parseFundingCurveUniverseResponse(universeFixture())).toMatchObject({
      engine: "funding-curve-universe-v1",
      readOnly: true,
      executable: false,
      contract: { owner: "server", adapterRegistry: "publicVenueAdapters", execution: "none" },
      economicIdentityCatalog: { schemaVersion: 1, version: "fixture-v1" },
      supportedVenues: ["gate"],
      instruments: [{ venue: "gate", economicAssetId: "crypto:bitcoin", marketType: "perpetual" }]
    });
  });

  it("rejects unsupported venues, stale identity evidence, count drift and instrument extras", () => {
    const unsupported = universeFixture();
    unsupported.instruments[0]!.venue = "binance";
    unsupported.instruments[0]!.id = "binance:perpetual:BTCUSDT";
    expect(() => parseFundingCurveUniverseResponse(unsupported)).toThrow(/not supported/);

    const expired = universeFixture();
    expired.economicIdentityCatalog.validUntil = expired.updatedAt - 1;
    expect(() => parseFundingCurveUniverseResponse(expired)).toThrow(/not valid/);

    const wrongCount = universeFixture();
    wrongCount.total = 2;
    expect(() => parseFundingCurveUniverseResponse(wrongCount)).toThrow(/counts/);

    const extra = universeFixture();
    (extra.instruments[0] as Record<string, unknown>).apiKey = "forged";
    expect(() => parseFundingCurveUniverseResponse(extra)).toThrow(/apiKey/);
  });

  it("uses the public universe GET route without credentials or a body", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof URL ? input : new URL(String(input));
      expect(url.pathname).toBe("/api/arbitrage/funding-curve/universe");
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json(universeFixture());
    });
    const client = new SaltanatArbitrageClient({ baseUrl: "https://research.invalid", fetch: fetcher });

    await expect(client.fundingCurveUniverse()).resolves.toMatchObject({
      supportedVenues: ["gate"],
      instruments: [{ venue: "gate" }]
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("parses a bounded non-executable curve and recomputes schedule and stress arithmetic", () => {
    expect(parseFundingCurveResponse(responseFixture())).toMatchObject({
      engine: "funding-curve-v1",
      readOnly: true,
      researchOnly: true,
      executable: false,
      contract: { execution: "none" },
      curves: [
        {
          venue: "gate",
          rateUnit: "decimal-per-settlement",
          scenarios: [{ id: "base", cumulativeRate: 0.0005 }]
        }
      ]
    });
  });

  it("parses calibrated cross-venue intervals and rejects forged worst-case skew", () => {
    const value = calibratedComparisonFixture();
    expect(parseFundingCurveResponse(value)).toMatchObject({
      crossVenueClock: { status: "eligible", eligible: true, comparedVenueCount: 2, calibratedVenueCount: 2, maximumPossibleSkewMs: 0 },
      curves: [{ freshness: { clockBasis: "calibrated-venue-interval", crossVenueComparable: true } }, { freshness: { clockBasis: "calibrated-venue-interval", crossVenueComparable: true } }]
    });
    value.crossVenueClock.maximumPossibleSkewMs = 1;
    expect(() => parseFundingCurveResponse(value)).toThrow(/worst-case skew/);
  });

  it("rejects execution-shaped, unit-forged and arithmetically inconsistent responses", () => {
    const mutations: Array<(value: ReturnType<typeof responseFixture>) => void> = [
      (value) => {
        value.executable = true as false;
      },
      (value) => {
        (value as Record<string, unknown>).order = { side: "buy" };
      },
      (value) => {
        value.contract.rateUnit = "annual-percent" as "decimal-per-settlement";
      },
      (value) => {
        value.curves[0]!.schedule.nextFundingTime += MINUTE;
      },
      (value) => {
        value.curves[0]!.current.estimateRateBps = 100;
      },
      (value) => {
        value.curves[0]!.settlements[1]!.rateSource = "current-estimate";
      },
      (value) => {
        value.curves[0]!.scenarios[0]!.cumulativeRate = 1;
      },
      (value) => {
        value.curves[0]!.freshness.ageMs = 0;
      },
      (value) => {
        value.curves[0]!.source.credentialed = true as false;
      },
      (value) => {
        (value.curves[0] as Record<string, unknown>).apiKey = "forged";
      },
      (value) => {
        value.rejections.push({ venue: "gate", instrumentId: "gate:perpetual:BTC_USDT", code: "stale-source", message: "duplicate", retryable: true });
      }
    ];
    for (const mutate of mutations) {
      const value = responseFixture();
      mutate(value);
      expect(() => parseFundingCurveResponse(value)).toThrow();
    }
    expect(() => parseFundingCurveResponse({ ...responseFixture(), curves: Array.from({ length: 9 }, () => ({})) })).toThrow(/at most 8/);
  });

  it("uses the public POST route without authorization and applies the strict parser", async () => {
    const request = requestFixture();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof URL ? input : new URL(String(input));
      expect(url.pathname).toBe("/api/arbitrage/funding-curve");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(JSON.parse(String(init?.body))).toEqual(request);
      return Response.json(responseFixture());
    });
    const client = new SaltanatArbitrageClient({ baseUrl: "https://research.invalid", fetch: fetcher });

    await expect(client.fundingCurve(request)).resolves.toMatchObject({ executable: false, curves: [{ venue: "gate" }] });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects a forged executable response through the client method", async () => {
    const forged = responseFixture();
    forged.executable = true as false;
    const client = new SaltanatArbitrageClient({ baseUrl: "https://research.invalid", fetch: async () => Response.json(forged) });

    await expect(client.fundingCurve(requestFixture())).rejects.toThrow(/executable/);
  });
});

function requestFixture(): FundingCurveRequest {
  return {
    selections: [{ venue: "gate", instrumentId: "gate:perpetual:BTC_USDT", marketType: "perpetual", rateUnit: "decimal-per-settlement" }],
    horizon: { value: 180, unit: "minutes" },
    historyLimit: 25,
    maxAgeMs: 60_000,
    maxFutureSkewMs: 2_000,
    maxCrossVenueClockSkewMs: 2_000,
    stressScenarios: [{ id: "base", bumpBps: 0, unit: "basis-points-additive-per-settlement" }]
  };
}

function universeFixture() {
  return {
    engine: "funding-curve-universe-v1" as const,
    readOnly: true as const,
    researchOnly: true as const,
    executable: false as const,
    updatedAt: NOW,
    stale: false,
    contract: {
      owner: "server" as const,
      adapterRegistry: "publicVenueAdapters" as const,
      instruments: "fresh-verified-trading-perpetuals" as const,
      execution: "none" as const
    },
    economicIdentityCatalog: {
      schemaVersion: 1 as const,
      source: "reviewed fixture",
      version: "fixture-v1",
      asOf: NOW - 60_000,
      validUntil: NOW + 60_000
    },
    supportedVenues: ["gate"],
    total: 1,
    truncated: false,
    instruments: [
      {
        id: "gate:perpetual:BTC_USDT",
        assetId: "BTC",
        economicAssetId: "crypto:bitcoin",
        venue: "gate",
        venueSymbol: "BTC_USDT",
        baseAsset: "BTC",
        quoteAsset: "USDT",
        settleAsset: "USDT",
        marketType: "perpetual" as const,
        contractDirection: "linear" as const,
        contractMultiplier: 1,
        quantityUnit: "base" as const,
        tickSize: 0.1,
        quantityStep: 0.001,
        minimumQuantity: 0.001,
        minimumNotional: 1,
        status: "trading" as const,
        fundingIntervalMinutes: 480
      }
    ],
    sourceErrors: [] as string[]
  };
}

function responseFixture() {
  return {
    engine: "funding-curve-v1" as const,
    readOnly: true as const,
    researchOnly: true as const,
    executable: false as const,
    evaluatedAt: NOW,
    horizonEnd: NOW + 180 * MINUTE,
    contract: {
      source: "credential-free-public-venue-adapters" as const,
      rateUnit: "decimal-per-settlement" as const,
      stressUnit: "basis-points-additive-per-settlement" as const,
      scheduleRequirement: "adapter-verified-discrete-settlements" as const,
      projection: "point-in-time-estimate-persistence" as const,
      pnl: "not-computed-without-explicit-notional-and-price-path" as const,
      execution: "none" as const
    },
    crossVenueClock: {
      status: "not-applicable" as const,
      eligible: false as const,
      reason: "fewer-than-two-successful-venues" as const,
      comparedVenueCount: 1,
      calibratedVenueCount: 0,
      maxSkewMs: 2_000
    },
    curves: [
      {
        venue: "gate",
        instrumentId: "gate:perpetual:BTC_USDT",
        marketType: "perpetual" as const,
        rateUnit: "decimal-per-settlement" as const,
        rateSignConvention: "positive-longs-pay-shorts" as const,
        projectionSemantics: "rate-sum-only-no-notional-or-pnl" as const,
        freshness: {
          status: "fresh" as const,
          clockBasis: "local-receipt-fallback" as const,
          crossVenueComparable: false as const,
          observedAt: NOW - 500,
          ageMs: 500,
          maxAgeMs: 60_000,
          fallbackReason: "clock-provider-unavailable" as const
        },
        schedule: {
          verified: true as const,
          interval: 60,
          unit: "minutes" as const,
          fundingTime: NOW + 30 * MINUTE,
          nextFundingTime: NOW + 90 * MINUTE
        },
        current: {
          settlementAt: NOW + 30 * MINUTE,
          estimateRate: 0.0001,
          estimateRateBps: 1,
          rateUnit: "decimal-per-settlement" as const,
          nextEstimateRate: 0.0002,
          nextEstimateRateBps: 2,
          minimumRate: -0.0005,
          maximumRate: 0.0005
        },
        history: [],
        settlements: [
          { settlementAt: NOW + 30 * MINUTE, baseRate: 0.0001, baseRateBps: 1, rateUnit: "decimal-per-settlement" as const, rateSource: "current-estimate" as const },
          { settlementAt: NOW + 90 * MINUTE, baseRate: 0.0002, baseRateBps: 2, rateUnit: "decimal-per-settlement" as const, rateSource: "next-estimate" as const },
          { settlementAt: NOW + 150 * MINUTE, baseRate: 0.0002, baseRateBps: 2, rateUnit: "decimal-per-settlement" as const, rateSource: "latest-estimate-persistence" as const }
        ],
        scenarios: [
          {
            id: "base",
            bumpBps: 0,
            unit: "basis-points-additive-per-settlement" as const,
            settlementCount: 3,
            cumulativeRate: 0.0005,
            averageRatePerSettlement: 0.0005 / 3,
            outsidePublishedMinimumCount: 0,
            outsidePublishedMaximumCount: 0
          }
        ],
        source: {
          adapter: "publicVenueAdapters" as const,
          operation: "funding" as const,
          public: true as const,
          credentialed: false as const,
          exchangeTs: NOW - 1_000,
          receivedAt: NOW - 500,
          formulaType: "fixture-discrete",
          method: "fixture-current-and-next",
          network: "mainnet" as const,
          currentEstimateSource: "fixture-current",
          timestampSource: "exchange" as const,
          historyComplete: true,
          sourceErrors: [] as string[],
          sourceErrorsTruncated: false
        }
      }
    ],
    rejections: [] as Array<{ venue: string; instrumentId: string; code: "stale-source"; message: string; retryable: boolean }>
  };
}

function calibratedComparisonFixture() {
  const value = responseFixture();
  const gate = value.curves[0]!;
  gate.freshness = calibratedFundingFreshness("gate", gate.source.exchangeTs) as typeof gate.freshness;
  const okx = structuredClone(gate);
  okx.venue = "okx";
  okx.instrumentId = "okx:perpetual:BTC-USDT-SWAP";
  okx.freshness = calibratedFundingFreshness("okx", okx.source.exchangeTs) as typeof okx.freshness;
  value.curves.push(okx);
  value.crossVenueClock = {
    status: "eligible",
    eligible: true,
    clockBasis: "calibrated-venue-interval",
    comparedVenueCount: 2,
    calibratedVenueCount: 2,
    maxSkewMs: 2_000,
    maximumPossibleSkewMs: 0
  } as unknown as typeof value.crossVenueClock;
  return value as unknown as ReturnType<typeof responseFixture> & {
    crossVenueClock: {
      status: "eligible";
      eligible: true;
      clockBasis: "calibrated-venue-interval";
      comparedVenueCount: number;
      calibratedVenueCount: number;
      maxSkewMs: number;
      maximumPossibleSkewMs: number;
    };
  };
}

function calibratedFundingFreshness(venue: string, exchangeTs: number) {
  const ageMs = NOW - exchangeTs;
  return {
    status: "fresh" as const,
    clockBasis: "calibrated-venue-interval" as const,
    crossVenueComparable: true as const,
    observedAt: exchangeTs,
    ageMs,
    maxAgeMs: 60_000,
    ageLowerMs: ageMs,
    ageUpperMs: ageMs,
    clockLeg: { sourceId: `${venue}:public`, exchangeTs, clockStatus: "calibrated" as const, ageLowerMs: ageMs, ageUpperMs: ageMs, localEventEarliestAt: exchangeTs, localEventLatestAt: exchangeTs }
  };
}
