import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  createReplayManifest,
  eventDigest,
  replayDataset,
  runHistoricalBasisBacktest,
  type JsonValue,
  type ReplayDataset,
  type ReplayEvent,
  type ReplayManifestV1,
  type ReplayManifestV2,
  type ReplayManifestV3,
  type ReplayManifestV4
} from "../src/arbitrage/replay/index.js";
import { DuePositionIndex } from "../src/arbitrage/replay/duePositionIndex.js";

const SOURCE_DIGEST = `sha256:${"a".repeat(64)}` as const;

describe("deterministic arbitrage dataset replay", () => {
  it("reproduces the exact state digest and snapshots", () => {
    const events = baseEvents();
    const dataset = makeDataset(events);
    const reducer = (state: JsonValue, event: ReplayEvent) => {
      const current = state as { count: number; last: number };
      return { count: current.count + 1, last: event.exchangeTs };
    };
    const first = replayDataset(dataset, { count: 0, last: 0 }, reducer, { snapshotEvery: 2 });
    const second = replayDataset(dataset, { count: 0, last: 0 }, reducer, { snapshotEvery: 2 });

    expect(first.finalState).toEqual({ count: events.length, last: events.at(-1)?.exchangeTs });
    expect(first.firstEventAt).toBe(events[0]?.receivedAt);
    expect(first.lastEventAt).toBe(events.at(-1)?.receivedAt);
    expect(first.snapshots.at(-1)?.logicalTime).toBe(events.at(-1)?.receivedAt);
    expect(first.finalStateDigest).toBe(second.finalStateDigest);
    expect(first.snapshots).toEqual(second.snapshots);
    expect(dataset.manifest.schemaVersion).toBe(4);
    expect(first.identityVerified).toBe(true);
    expect(first.verifiedPointInTime).toBe(true);
    expect(dataset.manifest.economicAssetIds).toEqual(["crypto:bitcoin"]);
    expect(dataset.manifest.instrumentConstraintEpochs).toEqual([
      { instrumentId: "binance:spot:BTCUSDT", eventIndex: 0, eventType: "instrument-listed", constraintVersion: 1, quantityStep: 0.1, minimumQuantity: 0.1, minimumNotional: 1 },
      { instrumentId: "bybit:perpetual:BTCUSDT", eventIndex: 1, eventType: "instrument-listed", constraintVersion: 1, quantityStep: 1, minimumQuantity: 1, minimumNotional: 1 }
    ]);
  });

  it("fails on digest mutation, non-canonical order and point-in-time violations", () => {
    const events = baseEvents();
    const dataset = makeDataset(events);
    dataset.events[2] = { ...dataset.events[2]!, exchangeTs: 1_500 };
    expect(() => replayDataset(dataset, {}, (state) => state)).toThrow(/digest mismatch/);

    const outOfOrder = baseEvents();
    [outOfOrder[2], outOfOrder[3]] = [outOfOrder[3]!, outOfOrder[2]!];
    const orderedManifest = createReplayManifest(manifestInput(), outOfOrder);
    expect(() => replayDataset({ manifest: orderedManifest, events: outOfOrder }, {}, (state) => state)).toThrow(/canonical order/);

    const inactive = baseEvents().filter((event) => event.eventType !== "instrument-listed");
    expect(() => replayDataset(makeDataset(inactive), {}, (state) => state)).toThrow(/inactive instrument/);

    const unknownType = [{ ...baseEvents()[0]!, eventType: "future-secret-event" as ReplayEvent["eventType"] }];
    expect(() => replayDataset(makeDataset(unknownType), {}, (state) => state)).toThrow(/eventType is invalid/);

    const forgedEconomicManifest = makeDataset(baseEvents());
    forgedEconomicManifest.manifest.economicAssetIds = ["crypto:ethereum"];
    expect(() => replayDataset(forgedEconomicManifest, {}, (state) => state)).toThrow(/economicAssetIds does not match/);

    const forgedConstraintEpoch = makeDataset(baseEvents());
    forgedConstraintEpoch.manifest.instrumentConstraintEpochs[0]!.minimumNotional = 0.5;
    expect(() => replayDataset(forgedConstraintEpoch, {}, (state) => state)).toThrow(/instrumentConstraintEpochs does not match/);
  });

  it("labels current-universe replays as survivorship-biased", () => {
    const events = baseEvents().filter((event) => event.eventType !== "instrument-listed");
    const dataset = makeDataset(events, "current-universe-biased");
    const result = replayDataset(dataset, {}, (state) => state);
    expect(result.identityVerified).toBe(true);
    expect(result.verifiedPointInTime).toBe(false);
    expect(result.warnings[0]).toMatch(/survivorship bias/);
  });

  it("accepts a true schema-v1 manifest only as identity-unverified generic replay", () => {
    const events = withoutEconomicIdentity(baseEvents());
    const dataset = makeLegacyDataset(events);
    const first = replayDataset(dataset, { count: 0 }, (state) => ({ count: state.count + 1 }));
    const second = replayDataset(dataset, { count: 0 }, (state) => ({ count: state.count + 1 }));

    expect(dataset.manifest.schemaVersion).toBe(1);
    expect(dataset.manifest).not.toHaveProperty("economicAssetIds");
    expect(first.identityVerified).toBe(false);
    expect(first.verifiedPointInTime).toBe(false);
    expect(first.warnings.join(" ")).toMatch(/identity-unverified/);
    expect(first.finalStateDigest).toBe(second.finalStateDigest);
    expect(() => runHistoricalBasisBacktest(dataset, [route()])).toThrow(/requires replay manifest schema v4/);
  });

  it("migrates schema v2 only as exploratory replay without verified execution constraints", () => {
    const events = baseEvents().map((value) => {
      if (value.eventType !== "instrument-listed") return structuredClone(value);
      const { minimumNotional: _minimumNotional, ...payload } = value.payload as Record<string, JsonValue>;
      return { ...structuredClone(value), payload };
    });
    const dataset = makeV2Dataset(events);

    const result = replayDataset(dataset, { count: 0 }, (state) => ({ count: state.count + 1 }));

    expect(result.identityVerified).toBe(true);
    expect(result.verifiedPointInTime).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/schema v2.*minimum notional/i);
    expect(() => runHistoricalBasisBacktest(dataset, [route()])).toThrow(/requires replay manifest schema v4/);
  });

  it("keeps public inputs and bounded snapshots immutable without cloning growing state per event", () => {
    const events = Array.from({ length: 8 }, (_, index): ReplayEvent => ({
      sourceId: "copy-on-write",
      sequence: index + 1,
      exchangeTs: index + 1,
      receivedAt: index + 1,
      eventType: "venue-state",
      payload: { value: index }
    }));
    const dataset = makeDataset(events);
    const initial = { values: [] as number[] };
    let previousState: typeof initial | undefined;
    let stableInternalReference = true;
    const result = replayDataset(dataset, initial, (state, replayEvent) => {
      if (previousState && previousState !== state) stableInternalReference = false;
      previousState = state;
      state.values.push(replayEvent.sequence);
      (replayEvent.payload as { value: number }).value = -1;
      return state;
    }, { snapshotEvery: 2, maxSnapshots: 4 });

    expect(stableInternalReference).toBe(true);
    expect(initial.values).toEqual([]);
    expect((dataset.events[0]?.payload as { value: number }).value).toBe(0);
    expect(result.snapshots.map((snapshot) => (snapshot.state as typeof initial).values.length)).toEqual([2, 4, 6, 8]);
    expect((result.snapshots[0]?.state as typeof initial).values).toEqual([1, 2]);
    expect(result.finalState.values).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(() => replayDataset(dataset, initial, (state) => state, { snapshotEvery: 1, maxSnapshots: 7 })).toThrow(/exceeds maxSnapshots/);
    expect(() => replayDataset(dataset, initial, (state) => state, { snapshotEvery: 8, maxSnapshots: 1_001 })).toThrow(/hard limit \(1000\)/);
    expect(() => replayDataset(dataset, { payload: "snapshot-output" }, (state) => state, { snapshotEvery: 8, maxSnapshotBytes: 8 })).toThrow(/exceeds maxSnapshotBytes/);
    expect(() => replayDataset(dataset, { values: [1, 2, 3] }, (state) => state, { snapshotEvery: 8, maxSnapshotStateEntries: 2 })).toThrow(/exceeds maxSnapshotStateEntries/);
    expect(() => replayDataset(dataset, initial, (state) => state, { snapshotEvery: 8, maxSnapshotBytes: 32 * 1024 * 1024 + 1 })).toThrow(/hard limit/);
  });

  it("keeps schema v3 readable only as exploratory replay", () => {
    const dataset = makeV3Dataset(baseEvents());
    const result = replayDataset(dataset, {}, (state) => state);
    expect(result.identityVerified).toBe(true);
    expect(result.verifiedPointInTime).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/schema v3.*constraint updates/i);
    expect(() => runHistoricalBasisBacktest(dataset, [route()])).toThrow(/requires replay manifest schema v4/);
  });

  it("binds monotonic in-place constraint epochs into schema v4", () => {
    const events = [...baseEvents(), constraintUpdate("registry", 3, 2_500, "binance:spot:BTCUSDT", 2, 0.5, 0.5, 25)].sort(compareArrival);
    const dataset = makeDataset(events);
    expect(dataset.manifest.instrumentConstraintEpochs.at(-1)).toEqual({
      instrumentId: "binance:spot:BTCUSDT",
      eventIndex: 4,
      eventType: "instrument-constraints-updated",
      constraintVersion: 2,
      quantityStep: 0.5,
      minimumQuantity: 0.5,
      minimumNotional: 25
    });
    expect(() => replayDataset(dataset, {}, (state) => state)).not.toThrow();

    const forged = makeDataset(events);
    forged.manifest.instrumentConstraintEpochs.at(-1)!.quantityStep = 0.1;
    expect(() => replayDataset(forged, {}, (state) => state)).toThrow(/instrumentConstraintEpochs does not match/);

    const skippedVersion = [...baseEvents(), constraintUpdate("registry", 3, 2_500, "binance:spot:BTCUSDT", 3, 0.5, 0.5, 25)].sort(compareArrival);
    expect(() => replayDataset(makeDataset(skippedVersion), {}, (state) => state)).toThrow(/constraintVersion must advance/);

    const beforeListing = [constraintUpdate("registry", 1, 1_000, "binance:spot:BTCUSDT", 2, 0.5, 0.5, 25)];
    expect(() => replayDataset(makeDataset(beforeListing), {}, (state) => state)).toThrow(/updated before listing/);
  });

  it("replays a 20k-event growing state within the linear-work budget", () => {
    const events = Array.from({ length: 20_000 }, (_, index): ReplayEvent => ({
      sourceId: "scale",
      sequence: index + 1,
      exchangeTs: index + 1,
      receivedAt: index + 1,
      eventType: "venue-state",
      payload: { value: index }
    }));
    const dataset = makeDataset(events);
    const startedAt = performance.now();
    const result = replayDataset(dataset, { values: [] as number[] }, (state, replayEvent) => {
      state.values.push(replayEvent.sequence);
      return state;
    });
    const elapsedMs = performance.now() - startedAt;

    expect(result.finalState.values).toHaveLength(events.length);
    expect(result.finalState.values.at(-1)).toBe(events.length);
    expect(elapsedMs).toBeLessThan(4_000);
  }, 10_000);

  it("orders availability by receivedAt even when exchange timestamps arrive late", () => {
    const events: ReplayEvent[] = [
      { sourceId: "fast", sequence: 1, exchangeTs: 1_900, receivedAt: 3_000, eventType: "venue-state", payload: { state: "first-arrival" } },
      { sourceId: "late", sequence: 1, exchangeTs: 1_000, receivedAt: 4_000, eventType: "venue-state", payload: { state: "late-old-exchange-time" } }
    ];
    const result = replayDataset(makeDataset(events), { exchangeTimes: [], logicalTimes: [] } as { exchangeTimes: number[]; logicalTimes: number[] }, (state, value, context) => ({
      exchangeTimes: [...state.exchangeTimes, value.exchangeTs],
      logicalTimes: [...state.logicalTimes, context.logicalTime]
    }));

    expect(result.finalState).toEqual({ exchangeTimes: [1_900, 1_000], logicalTimes: [3_000, 4_000] });

    const futureStamped = [{ ...events[0]!, exchangeTs: 3_001 }];
    expect(() => replayDataset(makeDataset(futureStamped), {}, (state) => state)).toThrow(/cannot be later than receivedAt/);
  });
});

describe("historical basis backtest", () => {
  it("uses matched executable quantity, verified funding and real exit books", () => {
    const events = basisEvents();
    const first = runHistoricalBasisBacktest(makeDataset(events), [route()]);
    const second = runHistoricalBasisBacktest(makeDataset(events), [route()]);

    expect(first.trades).toHaveLength(1);
    expect(first.trades[0]).toMatchObject({
      routeId: "route-1",
      economicAssetId: "crypto:bitcoin",
      quantity: 9.9,
      openedAt: 2_002,
      closedAt: 3_002,
      fundingSettlementIds: ["funding-1"],
      fundingSettlementProvenance: [{ settlementId: "funding-1", settledAt: 2_500, receivedAt: 2_501 }]
    });
    expect(first.economicAssetIds).toEqual(["crypto:bitcoin"]);
    expect(first.trades[0]?.grossPricePnlUsd).toBeCloseTo(14.85, 10);
    expect(first.trades[0]?.fundingPnlUsd).toBeCloseTo(1.0098, 10);
    expect(first.trades[0]?.slippageReserveUsd).toBeCloseTo(0.5049, 10);
    expect(first.trades[0]?.spotIdentityDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.trades[0]?.derivativeIdentityDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.trades[0]?.netPnlUsd).toBeCloseTo(
      first.trades[0]!.grossPricePnlUsd + first.trades[0]!.fundingPnlUsd - first.trades[0]!.feesUsd - first.trades[0]!.slippageReserveUsd,
      12
    );
    expect(first.trades[0]?.netPnlUsd).toBeGreaterThan(10);
    expect(first.unresolvedPositions).toEqual([]);
    expect(first.finalStateDigest).toBe(second.finalStateDigest);
    expect(first.totalNetPnlUsd).toBe(second.totalNetPnlUsd);
  });

  it("ignores unverified or duplicate funding and never invents an illiquid exit", () => {
    const events = basisEvents({ unverifiedFunding: true, duplicateFunding: true, illiquidExit: true });
    const result = runHistoricalBasisBacktest(makeDataset(events), [route()]);

    expect(result.trades).toEqual([]);
    expect(result.unresolvedPositions).toHaveLength(1);
    expect(result.rejectedFundingEvents).toBe(1);
    expect(result.duplicateFundingEvents).toBe(0);
    expect(result.rejectedExits).toBeGreaterThan(0);
  });

  it("keeps an end-of-dataset position explicitly unresolved", () => {
    const events = basisEvents().slice(0, 5);
    const result = runHistoricalBasisBacktest(makeDataset(events), [route()]);
    expect(result.trades).toEqual([]);
    expect(result.unresolvedPositions).toHaveLength(1);
  });

  it("invalidates pre-delisting depth and requires route identities in the point-in-time universe", () => {
    const events: ReplayEvent[] = [
      ...baseEvents(),
      event("registry", 3, 2_500, "instrument-delisted", "binance:spot:BTCUSDT", {}),
      event("registry", 4, 2_600, "instrument-listed", "binance:spot:BTCUSDT", identity("binance", "BTCUSDT", "spot", 0.1, 1, 25)),
      event("spot", 2, 3_000, "depth-snapshot", "binance:spot:BTCUSDT", book(102, 103, 20, 20)),
      event("perp", 2, 3_001, "depth-snapshot", "bybit:perpetual:BTCUSDT", book(102, 102.5, 2_000, 2_000))
    ];
    const dataset = makeDataset(events);
    expect(dataset.manifest.instrumentConstraintEpochs.filter((row) => row.instrumentId === "binance:spot:BTCUSDT")).toEqual([
      { instrumentId: "binance:spot:BTCUSDT", eventIndex: 0, eventType: "instrument-listed", constraintVersion: 1, quantityStep: 0.1, minimumQuantity: 0.1, minimumNotional: 1 },
      { instrumentId: "binance:spot:BTCUSDT", eventIndex: 5, eventType: "instrument-listed", constraintVersion: 1, quantityStep: 0.1, minimumQuantity: 0.1, minimumNotional: 25 }
    ]);
    const result = runHistoricalBasisBacktest(dataset, [route()]);
    expect(result.trades).toEqual([]);
    expect(result.unresolvedPositions).toHaveLength(1);
    expect(result.rejectedExits).toBeGreaterThan(0);

    const unknownRoute = { ...route(), derivativeInstrumentId: "bybit:perpetual:UNKNOWN" };
    expect(() => runHistoricalBasisBacktest(makeDataset(baseEvents()), [unknownRoute])).toThrow(/has no point-in-time listing event/);

    const beforeListingEpoch = baseEvents();
    beforeListingEpoch[2] = { ...beforeListingEpoch[2]!, exchangeTs: 999 };
    expect(() => runHistoricalBasisBacktest(makeDataset(beforeListingEpoch), [route()])).toThrow(/predates its active listing epoch/);
  });

  it("walks point-in-time depth deterministically and records executable VWAPs", () => {
    const events = basisEvents();
    events[2] = { ...events[2]!, payload: { bids: [[99, 20]], asks: [[100, 5], [102, 10]] } };
    events[3] = { ...events[3]!, payload: { bids: [[105, 500], [103, 2_000]], asks: [[106, 2_000]] } };
    events[5] = { ...events[5]!, payload: { bids: [[102, 4], [101, 20]], asks: [[103, 20]] } };
    events[6] = { ...events[6]!, payload: { bids: [[102, 2_000]], asks: [[102.5, 300], [103, 2_000]] } };

    const first = runHistoricalBasisBacktest(makeDataset(events), [route()]);
    const second = runHistoricalBasisBacktest(makeDataset(events), [route()]);
    expect(first.trades).toHaveLength(1);
    expect(first.trades[0]).toMatchObject({
      quantity: 9.9,
      spotEntryLevelsUsed: 2,
      derivativeEntryLevelsUsed: 2,
      spotExitLevelsUsed: 2,
      derivativeExitLevelsUsed: 2
    });
    expect(first.trades[0]?.spotEntryAskVwap).toBeCloseTo((5 * 100 + 4.9 * 102) / 9.9, 12);
    expect(first.trades[0]?.derivativeEntryBidVwap).toBeCloseTo((5 * 105 + 4.9 * 103) / 9.9, 12);
    expect(first.trades).toEqual(second.trades);
    expect(first.finalStateDigest).toBe(second.finalStateDigest);
  });

  it("fails closed on economic identity mismatch and top-book-only input", () => {
    const sameTickerDifferentEconomicAsset = baseEvents();
    sameTickerDifferentEconomicAsset[1] = {
      ...sameTickerDifferentEconomicAsset[1]!,
      payload: { ...(sameTickerDifferentEconomicAsset[1]!.payload as Record<string, JsonValue>), economicAssetId: "crypto:wrapped-bitcoin" }
    };
    expect(() => runHistoricalBasisBacktest(makeDataset(sameTickerDifferentEconomicAsset), [route()])).toThrow(/economic identity mismatch/);

    const mismatched = baseEvents();
    mismatched[1] = {
      ...mismatched[1]!,
      payload: { ...(mismatched[1]!.payload as Record<string, JsonValue>), baseAsset: "ETH" }
    };
    expect(() => runHistoricalBasisBacktest(makeDataset(mismatched), [route()])).toThrow(/base\/quote identity mismatch/);

    const topOnly = baseEvents();
    topOnly[2] = { ...topOnly[2]!, eventType: "top-book", payload: { bid: 99, bidSize: 20, ask: 101, askSize: 20 } };
    expect(() => runHistoricalBasisBacktest(makeDataset(topOnly), [route()])).toThrow(/requires depth-snapshot events/);

    const missingEconomicIdentity = baseEvents();
    const { economicAssetId: _economicAssetId, ...identityWithoutEconomicAsset } = missingEconomicIdentity[1]!.payload as Record<string, JsonValue>;
    missingEconomicIdentity[1] = { ...missingEconomicIdentity[1]!, payload: identityWithoutEconomicAsset };
    expect(() => runHistoricalBasisBacktest(makeDataset(missingEconomicIdentity), [route()])).toThrow(/economicAssetId/);

    const invalidEconomicIdentity = baseEvents();
    invalidEconomicIdentity[1] = {
      ...invalidEconomicIdentity[1]!,
      payload: { ...(invalidEconomicIdentity[1]!.payload as Record<string, JsonValue>), economicAssetId: "BTC" }
    };
    expect(() => makeDataset(invalidEconomicIdentity)).toThrow(/economicAssetId is invalid/);

    const missingMinimumNotional = baseEvents();
    const { minimumNotional: _minimumNotional, ...identityWithoutMinimumNotional } = missingMinimumNotional[0]!.payload as Record<string, JsonValue>;
    missingMinimumNotional[0] = { ...missingMinimumNotional[0]!, payload: identityWithoutMinimumNotional };
    expect(() => makeDataset(missingMinimumNotional)).toThrow(/minimumNotional is invalid|required.*schema v3/i);
  });

  it("fails closed when either point-in-time entry or exit leg is below minimum notional", () => {
    for (const identityIndex of [0, 1]) {
      const entryBelowMinimum = basisEvents();
      entryBelowMinimum[identityIndex] = {
        ...entryBelowMinimum[identityIndex]!,
        payload: { ...(entryBelowMinimum[identityIndex]!.payload as Record<string, JsonValue>), minimumNotional: 1_100 }
      };
      const entryResult = runHistoricalBasisBacktest(makeDataset(entryBelowMinimum), [route()]);
      expect(entryResult.trades).toEqual([]);
      expect(entryResult.unresolvedPositions).toEqual([]);
      expect(entryResult.rejectedEntries).toBeGreaterThan(0);
    }

    for (const exitLeg of ["spot", "derivative"] as const) {
      const exitBelowMinimum = basisEvents();
      const identityIndex = exitLeg === "spot" ? 0 : 1;
      exitBelowMinimum[identityIndex] = {
        ...exitBelowMinimum[identityIndex]!,
        payload: { ...(exitBelowMinimum[identityIndex]!.payload as Record<string, JsonValue>), minimumNotional: 900 }
      };
      const depthIndex = exitLeg === "spot" ? 5 : 6;
      exitBelowMinimum[depthIndex] = {
        ...exitBelowMinimum[depthIndex]!,
        payload: exitLeg === "spot" ? book(80, 103, 20, 20) : book(79, 80, 2_000, 2_000)
      };
      const exitResult = runHistoricalBasisBacktest(makeDataset(exitBelowMinimum), [route()]);
      expect(exitResult.trades).toEqual([]);
      expect(exitResult.unresolvedPositions).toHaveLength(1);
      expect(exitResult.rejectedExits).toBeGreaterThan(0);
    }
  });

  it("applies in-place quantity and notional constraints at entry and exit without changing identity", () => {
    const blockedEntry = [
      ...basisEvents(),
      constraintUpdate("registry", 3, 1_500, "binance:spot:BTCUSDT", 2, 0.5, 0.5, 1_100)
    ].sort(compareArrival);
    const entryResult = runHistoricalBasisBacktest(makeDataset(blockedEntry), [route()]);
    expect(entryResult.trades).toEqual([]);
    expect(entryResult.unresolvedPositions).toEqual([]);
    expect(entryResult.rejectedEntries).toBeGreaterThan(0);

    for (const [quantityStep, minimumQuantity, minimumNotional] of [[1, 1, 1], [0.1, 20, 1], [0.1, 0.1, 1_100]] as const) {
      const blockedExit = [
        ...basisEvents(),
        constraintUpdate("registry", 3, 2_600, "binance:spot:BTCUSDT", 2, quantityStep, minimumQuantity, minimumNotional)
      ].sort(compareArrival);
      const exitResult = runHistoricalBasisBacktest(makeDataset(blockedExit), [route()]);
      expect(exitResult.trades).toEqual([]);
      expect(exitResult.unresolvedPositions).toHaveLength(1);
      expect(exitResult.rejectedExits).toBeGreaterThan(0);
    }

    const compatibleUpdate = [
      ...basisEvents(),
      constraintUpdate("registry", 3, 2_600, "binance:spot:BTCUSDT", 2, 0.1, 0.2, 2)
    ].sort(compareArrival);
    const compatibleResult = runHistoricalBasisBacktest(makeDataset(compatibleUpdate), [route()]);
    expect(compatibleResult.trades).toHaveLength(1);
    expect(compatibleResult.trades[0]?.spotIdentityDigest).toMatch(/^sha256:/);
  });

  it("accounts funding by settlement time when the immutable record arrives after the trade closes", () => {
    const baseline = basisEvents();
    const delayed = basisEvents();
    const fundingIndex = delayed.findIndex((value) => value.eventType === "funding-settlement");
    delayed[fundingIndex] = {
      ...delayed[fundingIndex]!,
      sourceId: "funding-ledger",
      sequence: 1,
      receivedAt: 3_500
    };
    delayed.sort(compareArrival);

    const immediateResult = runHistoricalBasisBacktest(makeDataset(baseline), [route()]);
    const delayedResult = runHistoricalBasisBacktest(makeDataset(delayed), [route()]);
    expect(delayedResult.trades).toHaveLength(1);
    expect(delayedResult.trades[0]?.fundingPnlUsd).toBe(immediateResult.trades[0]?.fundingPnlUsd);
    expect(delayedResult.trades[0]?.netPnlUsd).toBe(immediateResult.trades[0]?.netPnlUsd);
    expect(delayedResult.trades[0]?.fundingSettlementProvenance).toEqual([
      expect.objectContaining({ settlementId: "funding-1", settledAt: 2_500, receivedAt: 3_500 })
    ]);
    expect(delayedResult.eventDigest).not.toBe(immediateResult.eventDigest);

    const repeated = runHistoricalBasisBacktest(makeDataset(delayed), [route()]);
    expect(repeated.trades).toEqual(delayedResult.trades);
    expect(repeated.finalStateDigest).toBe(delayedResult.finalStateDigest);
  });

  it("accounts verified funding through a delayed actual exit rather than the target horizon", () => {
    const events = basisEvents({ illiquidExit: true });
    events.push(
      event("spot", 3, 4_000, "depth-snapshot", "binance:spot:BTCUSDT", book(102, 103, 20, 20)),
      event("perp", 4, 4_001, "depth-snapshot", "bybit:perpetual:BTCUSDT", book(102, 102.5, 2_000, 2_000)),
      fundingEvent(1, 3_500, 4_500, "funding-after-target", 0.002)
    );
    events.sort(compareArrival);

    const result = runHistoricalBasisBacktest(makeDataset(events), [route()]);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.closedAt).toBe(4_002);
    expect(result.trades[0]?.fundingSettlementIds).toEqual(["funding-1", "funding-after-target"]);
    expect(result.trades[0]?.fundingPnlUsd).toBeCloseTo(9.9 * 102 * 0.003, 12);
  });

  it("uses half-open settlement ownership at the actual close boundary", () => {
    const events = basisEvents().filter((value) => value.eventType !== "funding-settlement");
    events.push(
      fundingEvent(1, 2_002, 3_600, "funding-at-open", 0.001),
      fundingEvent(2, 3_002, 3_601, "funding-at-horizon", 0.002),
      fundingEvent(3, 3_003, 3_602, "funding-after-horizon", 0.004)
    );
    events.sort(compareArrival);

    const result = runHistoricalBasisBacktest(makeDataset(events), [route()]);
    expect(result.trades[0]?.fundingSettlementIds).toEqual(["funding-at-open"]);
    expect(result.trades[0]?.fundingPnlUsd).toBeCloseTo(9.9 * 102 * 0.001, 12);
  });

  it("assigns a close-and-reopen boundary settlement to exactly one position", () => {
    const events = basisEvents().filter((value) => value.eventType !== "funding-settlement");
    events[4] = event("spot", 2, 3_000, "depth-snapshot", "binance:spot:BTCUSDT", book(100, 101, 20, 20));
    events[5] = event("perp", 3, 3_001, "depth-snapshot", "bybit:perpetual:BTCUSDT", book(104, 105, 2_000, 2_000));
    events.push(
      event("spot", 3, 4_000, "depth-snapshot", "binance:spot:BTCUSDT", book(100, 101, 20, 20)),
      event("perp", 4, 4_001, "depth-snapshot", "bybit:perpetual:BTCUSDT", book(104, 105, 2_000, 2_000)),
      fundingEvent(1, 3_002, 5_000, "funding-at-reopen", 0.001)
    );
    events.sort(compareArrival);

    const result = runHistoricalBasisBacktest(makeDataset(events), [route()]);
    expect(result.trades).toHaveLength(2);
    expect(result.trades[0]?.closedAt).toBe(3_002);
    expect(result.trades[0]?.fundingSettlementIds).toEqual([]);
    expect(result.trades[1]?.openedAt).toBe(3_002);
    expect(result.trades[1]?.fundingSettlementIds).toEqual(["funding-at-reopen"]);
    expect(result.trades.flatMap((trade) => trade.fundingSettlementIds).filter((id) => id === "funding-at-reopen")).toHaveLength(1);
  });
});

describe("due-position index", () => {
  it("keeps candidate work bounded to newly due or changed-leg positions", () => {
    const routes = Array.from({ length: 10_000 }, (_, index) => ({
      id: `route-${index}`,
      spotInstrumentId: `spot-${index}`,
      derivativeInstrumentId: `perp-${index}`
    }));
    const index = new DuePositionIndex(routes);
    index.add({ routeId: "route-4242", dueAt: 2_000, openEventIndex: 7 });

    expect(index.pendingCount).toBe(1);
    expect(index.candidates(1_999, "spot-9999")).toEqual([]);
    expect(index.candidates(2_000, "spot-9999")).toEqual(["route-4242"]);
    expect(index.pendingCount).toBe(0);
    expect(index.indexedDueCount).toBe(1);
    expect(index.candidates(2_001, "perp-9999")).toEqual([]);
    expect(index.candidates(2_001, "perp-4242")).toEqual(["route-4242"]);
    index.remove("route-4242");
    expect(index.indexedDueCount).toBe(0);
    expect(index.candidates(2_002, "spot-4242")).toEqual([]);
  });
});

function baseEvents(): ReplayEvent[] {
  return [
    event("registry", 1, 1_000, "instrument-listed", "binance:spot:BTCUSDT", identity("binance", "BTCUSDT", "spot", 0.1, 1)),
    event("registry", 2, 1_001, "instrument-listed", "bybit:perpetual:BTCUSDT", identity("bybit", "BTCUSDT", "perpetual", 1, 0.01)),
    event("spot", 1, 2_000, "depth-snapshot", "binance:spot:BTCUSDT", book(99, 101, 20, 20)),
    event("perp", 1, 2_001, "depth-snapshot", "bybit:perpetual:BTCUSDT", book(103, 104, 2_000, 2_000))
  ];
}

function basisEvents(options: { unverifiedFunding?: boolean; duplicateFunding?: boolean; illiquidExit?: boolean } = {}): ReplayEvent[] {
  const events = [
    ...baseEvents(),
    event("perp", 2, 2_500, "funding-settlement", "bybit:perpetual:BTCUSDT", {
      settlementId: "funding-1",
      rate: 0.001,
      referencePrice: 102,
      verified: !options.unverifiedFunding
    })
  ];
  if (options.duplicateFunding) {
    events.push(event("perp", 3, 2_600, "funding-settlement", "bybit:perpetual:BTCUSDT", { settlementId: "funding-1", rate: 0.001, referencePrice: 102, verified: true }));
  }
  const nextPerpSequence = options.duplicateFunding ? 4 : 3;
  events.push(
    event("spot", 2, 3_000, "depth-snapshot", "binance:spot:BTCUSDT", book(102, 103, options.illiquidExit ? 1 : 20, 20)),
    event("perp", nextPerpSequence, 3_001, "depth-snapshot", "bybit:perpetual:BTCUSDT", book(102, 102.5, 2_000, options.illiquidExit ? 100 : 2_000))
  );
  return events.sort((left, right) => left.receivedAt - right.receivedAt || left.sourceId.localeCompare(right.sourceId) || left.sequence - right.sequence || left.exchangeTs - right.exchangeTs);
}

function route() {
  return {
    id: "route-1",
    spotInstrumentId: "binance:spot:BTCUSDT",
    derivativeInstrumentId: "bybit:perpetual:BTCUSDT",
    requestedNotionalUsd: 1_000,
    holdingPeriodMs: 1_000,
    minimumNetEntryBps: 0,
    entryFeeBpsPerLeg: 10,
    exitFeeBpsPerLeg: 10,
    slippageReserveBps: 5,
    maximumQuoteAgeMs: 2_000,
    maximumLegSkewMs: 1_500
  };
}

function book(bid: number, ask: number, bidSize: number, askSize: number) {
  return { bids: [[bid, bidSize]], asks: [[ask, askSize]] };
}

function identity(
  venue: string,
  symbol: string,
  marketType: "spot" | "perpetual",
  quantityStep: number,
  baseQuantityMultiplier: number,
  minimumNotional = 1
) {
  return {
    venue,
    symbol,
    marketType,
    economicAssetId: "crypto:bitcoin",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    settleAsset: "USDT",
    quantityUnit: marketType === "spot" ? "base" : "contract",
    baseQuantityMultiplier,
    constraintVersion: 1,
    quantityStep,
    minimumQuantity: quantityStep,
    minimumNotional
  };
}

function fundingEvent(sequence: number, exchangeTs: number, receivedAt: number, settlementId: string, rate: number): ReplayEvent {
  return {
    sourceId: "funding-ledger",
    sequence,
    exchangeTs,
    receivedAt,
    eventType: "funding-settlement",
    instrumentId: "bybit:perpetual:BTCUSDT",
    payload: { settlementId, settlementAt: exchangeTs, rate, referencePrice: 102, verified: true }
  };
}

function constraintUpdate(
  sourceId: string,
  sequence: number,
  exchangeTs: number,
  instrumentId: string,
  constraintVersion: number,
  quantityStep: number,
  minimumQuantity: number,
  minimumNotional: number
): ReplayEvent {
  return {
    sourceId,
    sequence,
    exchangeTs,
    receivedAt: exchangeTs + 1,
    eventType: "instrument-constraints-updated",
    instrumentId,
    payload: { constraintVersion, quantityStep, minimumQuantity, minimumNotional }
  };
}

function compareArrival(left: ReplayEvent, right: ReplayEvent) {
  return left.receivedAt - right.receivedAt || left.sourceId.localeCompare(right.sourceId) || left.sequence - right.sequence || left.exchangeTs - right.exchangeTs;
}

function event(sourceId: string, sequence: number, exchangeTs: number, eventType: ReplayEvent["eventType"], instrumentId: string, payload: JsonValue): ReplayEvent {
  return { sourceId, sequence, exchangeTs, receivedAt: exchangeTs + 1, eventType, instrumentId, payload };
}

function makeDataset(
  events: ReplayEvent[],
  policy: "point-in-time" | "current-universe-biased" = "point-in-time"
): ReplayDataset & { manifest: ReplayManifestV4 } {
  return { manifest: createReplayManifest(manifestInput(policy), events), events: structuredClone(events) };
}

function makeV2Dataset(events: ReplayEvent[]): ReplayDataset & { manifest: ReplayManifestV2 } {
  const input = manifestInput("point-in-time");
  const v3 = createReplayManifest(input, events.map((event) => event.eventType === "instrument-listed"
    ? { ...event, payload: { ...(event.payload as Record<string, JsonValue>), minimumNotional: 1 } }
    : event));
  return {
    manifest: {
      schemaVersion: 2,
      datasetId: v3.datasetId,
      createdAt: v3.createdAt,
      eventDigest: eventDigest(events),
      eventCount: events.length,
      economicAssetIds: [...v3.economicAssetIds],
      adapterVersions: { ...v3.adapterVersions },
      registrySnapshotId: v3.registrySnapshotId,
      registrySnapshotDigest: v3.registrySnapshotDigest,
      costModelVersion: v3.costModelVersion,
      survivorshipPolicy: v3.survivorshipPolicy,
      sourceFiles: v3.sourceFiles.map((source) => ({ ...source }))
    },
    events: structuredClone(events)
  };
}

function makeV3Dataset(events: ReplayEvent[]): ReplayDataset & { manifest: ReplayManifestV3 } {
  const v4 = createReplayManifest(manifestInput("point-in-time"), events);
  return {
    manifest: {
      schemaVersion: 3,
      datasetId: v4.datasetId,
      createdAt: v4.createdAt,
      eventDigest: v4.eventDigest,
      eventCount: v4.eventCount,
      economicAssetIds: [...v4.economicAssetIds],
      instrumentMinimumNotionals: events.flatMap((event, listingEventIndex) => event.eventType === "instrument-listed" && event.instrumentId
        ? [{ instrumentId: event.instrumentId, listingEventIndex, minimumNotional: (event.payload as Record<string, JsonValue>).minimumNotional as number }]
        : []),
      adapterVersions: { ...v4.adapterVersions },
      registrySnapshotId: v4.registrySnapshotId,
      registrySnapshotDigest: v4.registrySnapshotDigest,
      costModelVersion: v4.costModelVersion,
      survivorshipPolicy: v4.survivorshipPolicy,
      sourceFiles: v4.sourceFiles.map((source) => ({ ...source }))
    },
    events: structuredClone(events)
  };
}

function makeLegacyDataset(events: ReplayEvent[]): ReplayDataset & { manifest: ReplayManifestV1 } {
  const input = manifestInput("point-in-time");
  return {
    manifest: {
      schemaVersion: 1,
      datasetId: input.datasetId,
      createdAt: input.createdAt,
      eventDigest: eventDigest(events),
      eventCount: events.length,
      adapterVersions: { ...input.adapterVersions },
      registrySnapshotId: input.registrySnapshotId,
      registrySnapshotDigest: input.registrySnapshotDigest,
      costModelVersion: input.costModelVersion,
      survivorshipPolicy: input.survivorshipPolicy,
      sourceFiles: input.sourceFiles.map((source) => ({ ...source }))
    },
    events: structuredClone(events)
  };
}

function withoutEconomicIdentity(events: ReplayEvent[]): ReplayEvent[] {
  return events.map((value) => {
    if (value.eventType !== "instrument-listed") return structuredClone(value);
    const { economicAssetId: _economicAssetId, ...payload } = value.payload as Record<string, JsonValue>;
    return { ...structuredClone(value), payload };
  });
}

function manifestInput(policy: "point-in-time" | "current-universe-biased" = "point-in-time") {
  return {
    datasetId: "fixture-v1",
    createdAt: 10_000,
    adapterVersions: { binance: "recorded-v1", bybit: "recorded-v1" },
    registrySnapshotId: "registry-v1",
    registrySnapshotDigest: `sha256:${"b".repeat(64)}` as const,
    costModelVersion: "cost-v1",
    survivorshipPolicy: policy,
    sourceFiles: [{ id: "fixture.ndjson", digest: SOURCE_DIGEST }]
  };
}
