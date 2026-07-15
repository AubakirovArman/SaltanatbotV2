import { describe, expect, it } from "vitest";
import type { ArbitrageDepthResponse } from "../src/arbitrage/client";
import type { ArbitragePaperPosition } from "../src/arbitrage/paper";
import { appendPaperEvents, createArchiveEvents, createCloseEvent, createFundingEvent, createOpenEvent, loadPaperEvents, replayPaperEvents } from "../src/arbitrage/paperLedger";

describe("arbitrage paper event ledger", () => {
  it("replays matched entry, explicit funding and exit-depth VWAP deterministically", () => {
    const position = fixturePosition();
    let events = appendPaperEvents([], createOpenEvent(position, [], "event-open"));
    const opened = replayPaperEvents(events)[0]!;
    events = appendPaperEvents(
      events,
      createFundingEvent(
        opened,
        {
          settlementTime: 150,
          rate: 0.001,
          referencePrice: 102,
          source: "manual-confirmed"
        },
        events,
        160,
        "event-funding"
      )
    );
    const funded = replayPaperEvents(events)[0]!;
    expect(funded.fundingPnlUsd).toBeCloseTo(0.102, 12);

    events = appendPaperEvents(events, createCloseEvent(funded, fixtureExitDepth(), events, 200, "event-close"));
    const firstReplay = replayPaperEvents(events);
    const secondReplay = replayPaperEvents(JSON.parse(JSON.stringify(events)));
    expect(secondReplay).toEqual(firstReplay);
    expect(firstReplay[0]).toMatchObject({ spotExit: 101, futuresExit: 102, closedAt: 200 });
    expect(firstReplay[0]!.realizedPnlUsd).toBeCloseTo(1.702, 12);

    const archive = createArchiveEvents(firstReplay, events, 210);
    expect(replayPaperEvents(appendPaperEvents(events, ...archive))).toEqual([]);
  });

  it("fails closed on duplicated settlements, sequence gaps and tampered cash flow", () => {
    const position = fixturePosition();
    const openedEvents = appendPaperEvents([], createOpenEvent(position, [], "event-open"));
    const opened = replayPaperEvents(openedEvents)[0]!;
    const funding = createFundingEvent(
      opened,
      {
        settlementTime: 150,
        rate: 0.001,
        referencePrice: 102,
        source: "manual-confirmed"
      },
      openedEvents,
      160,
      "event-funding"
    );
    const events = appendPaperEvents(openedEvents, funding);
    expect(() =>
      createFundingEvent(
        opened,
        {
          settlementTime: 150,
          rate: 0.002,
          referencePrice: 102,
          source: "manual-confirmed"
        },
        events,
        170,
        "duplicate"
      )
    ).toThrow(/already recorded/);
    expect(() => replayPaperEvents([{ ...openedEvents[0]!, sequence: 2 }])).toThrow(/out of order/);
    expect(() => replayPaperEvents([openedEvents[0]!, { ...funding, cashFlowUsd: funding.cashFlowUsd + 1 }])).toThrow(/does not match/);
  });

  it("refuses to close against stale or unverified exit depth", () => {
    const position = fixturePosition();
    const events = appendPaperEvents([], createOpenEvent(position, [], "event-open"));
    const stale = fixtureExitDepth();
    stale.timing = {
      ...stale.timing,
      spot: { ...stale.timing.spot, ageMs: 20_000, receivedAt: 1 },
      perpetual: { ...stale.timing.perpetual, ageMs: 20_000, receivedAt: 1 },
      ageMs: 20_000,
      quality: "stale"
    };
    expect(() => createCloseEvent(position, stale, events, 200, "stale-close")).toThrow(/fresh, synchronized/);
    expect(() => createCloseEvent(position, { ...fixtureExitDepth(), precisionVerified: false, quantityStepSource: "fallback" }, events, 200, "fallback-close")).toThrow(/verified instrument/);
    expect(() => createCloseEvent({ ...position, assetId: "crypto:ethereum", economicAssetId: "crypto:ethereum" }, fixtureExitDepth(), events, 200, "wrong-route-close")).toThrow(/selected route/);
  });

  it("migrates the bounded legacy snapshot once and restores the same event ledger after restart", () => {
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      }
    } satisfies Storage;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    try {
      storage.setItem("sbv2:arbitrage-paper:v1", JSON.stringify([fixturePosition()]));
      const migrated = loadPaperEvents();
      expect(migrated).toMatchObject([{ type: "position_opened", sequence: 1, position: { id: "arb-paper-position-1" } }]);
      const persisted = JSON.parse(storage.getItem("sbv2:arbitrage-paper:v2") ?? "null");
      expect(persisted).toMatchObject({ schemaVersion: 3, events: [{ type: "position_opened", sequence: 1 }] });
      expect(loadPaperEvents()).toEqual(persisted.events);
      expect(replayPaperEvents(loadPaperEvents())).toEqual(replayPaperEvents(migrated));

      const { identityScope: _identityScope, assetId: _assetId, economicAssetId: _economicAssetId, spotInstrumentId: _spotInstrumentId, futuresInstrumentId: _futuresInstrumentId, ...legacyV2Position } = fixturePosition();
      storage.setItem("sbv2:arbitrage-paper:v2", JSON.stringify({ schemaVersion: 2, events: [{ id: "legacy-v2-open", sequence: 1, recordedAt: 100, type: "position_opened", position: legacyV2Position }] }));
      expect(loadPaperEvents()).toMatchObject([{ position: { identityScope: "cross-venue-reviewed", assetId: "crypto:bitcoin", spotInstrumentId: "binance:spot:BTCUSDT", futuresInstrumentId: "bybit:perpetual:BTCUSDT" } }]);
      expect(JSON.parse(storage.getItem("sbv2:arbitrage-paper:v2") ?? "null")).toMatchObject({ schemaVersion: 3 });
    } finally {
      if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});

function fixturePosition(): ArbitragePaperPosition {
  return {
    id: "arb-paper-position-1",
    routeId: "BTCUSDT:binance:bybit",
    identityScope: "cross-venue-reviewed",
    assetId: "crypto:bitcoin",
    economicAssetId: "crypto:bitcoin",
    spotInstrumentId: "binance:spot:BTCUSDT",
    futuresInstrumentId: "bybit:perpetual:BTCUSDT",
    symbol: "BTCUSDT",
    spotExchange: "binance",
    futuresExchange: "bybit",
    notionalUsd: 100,
    matchedQuantity: 1,
    spotQuantity: 1,
    futuresQuantity: 1,
    quantityStep: 0.001,
    precisionVerified: true,
    roundingDustQuantity: 0,
    residualDeltaQuantity: 0,
    spotEntry: 100,
    futuresEntry: 103,
    openedAt: 100,
    estimatedRoundTripCostUsd: 0.4,
    fundingPnlUsd: 0
  };
}

function fixtureExitDepth(): ArbitrageDepthResponse {
  const spot = {
    exchange: "binance" as const,
    market: "spot" as const,
    side: "sell" as const,
    requestedNotionalUsd: 100,
    filledNotionalUsd: 101,
    quantity: 1,
    averagePrice: 101,
    worstPrice: 101,
    topPrice: 101,
    slippageBps: 0,
    levelsUsed: 1,
    complete: true,
    capturedAt: 190
  };
  return {
    identityScope: "cross-venue-reviewed",
    assetId: "crypto:bitcoin",
    economicAssetId: "crypto:bitcoin",
    spotInstrumentId: "binance:spot:BTCUSDT",
    futuresInstrumentId: "bybit:perpetual:BTCUSDT",
    symbol: "BTCUSDT",
    direction: "exit",
    requestedNotionalUsd: 100,
    targetQuantity: 1,
    matchedQuantity: 1,
    quantityStep: 0.001,
    quantityStepSource: "instrument",
    precisionVerified: true,
    roundingDustQuantity: 0,
    liquidityShortfallQuantity: 0,
    residualDeltaQuantity: 0,
    spot,
    perpetual: { ...spot, exchange: "bybit", market: "perpetual", side: "buy", filledNotionalUsd: 102, averagePrice: 102, worstPrice: 102, topPrice: 102 },
    timing: {
      spot: { exchangeTs: 190, receivedAt: 190, ageMs: 0 },
      perpetual: { exchangeTs: 190, receivedAt: 190, ageMs: 0 },
      ageMs: 0,
      receiveSkewMs: 0,
      exchangeSkewMs: 0,
      legSkewMs: 0,
      exchangeTimestampsVerified: true,
      quality: "fresh"
    },
    constraints: { metadataVerified: true, minimumsSatisfied: true, verified: true, failures: [] },
    grossSpreadBps: 99.0099,
    complete: true,
    capturedAt: 190
  };
}
