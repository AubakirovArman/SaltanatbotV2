import { describe, expect, it, vi } from "vitest";
import type { Candle, Instrument, ScreenerDefinitionV1 } from "@saltanatbotv2/contracts";
import { parseScreenerRunResultV1 } from "@saltanatbotv2/contracts";
import { parseAndHashScreenerDefinition } from "../src/screener/repository.js";
import type { ScreenerPresetRecord } from "../src/screener/repositoryTypes.js";
import type { ScreenerMarketDataSnapshotV1 } from "../src/screener/marketData.js";
import { runScreenerTask, SCREENER_JOB_TIMEOUT_MS } from "../src/workers/screenerTask.js";

const OWNER = "00000000-0000-4000-8000-000000000071";
const PRESET_ID = "00000000-0000-4000-8000-000000000072";
const NOW = Date.parse("2026-07-17T12:00:00.000Z");
const HOUR = 3_600_000;

const definition: ScreenerDefinitionV1 = {
  schemaVersion: "screener-definition-v1",
  kind: "technical",
  name: "Worker screen",
  exchange: "binance",
  marketType: "spot",
  priceType: "last",
  timeframe: "1h",
  universeLimit: 25,
  sort: { key: "quoteVolume24h", direction: "desc" },
  filters: [{ kind: "price", min: "1" }],
  researchOnly: true,
  executionPermission: false
};

describe("in-process screener job executor", () => {
  it("keeps the screener job wall-time fence at 120 seconds", () => {
    expect(SCREENER_JOB_TIMEOUT_MS).toBe(120_000);
  });

  it("evaluates a definition run into a contract-validated result", async () => {
    const marketData = vi.fn().mockResolvedValue(snapshot());
    const presets = { get: vi.fn() };

    const result = await runScreenerTask(
      { ownerUserId: OWNER, payload: payload({ definition }) },
      { presets, marketData, now: () => NOW }
    );

    const parsed = parseScreenerRunResultV1(result);
    expect(parsed.definitionHash).toBe(parseAndHashScreenerDefinition(definition).hash);
    expect(parsed.generatedAt).toBe(new Date(NOW).toISOString());
    expect(parsed.timeframe).toBe("1h");
    expect(parsed.universe).toEqual({ requested: 1, evaluated: 1, matched: 1, unavailable: 0 });
    expect(parsed.rows).toMatchObject([{ symbol: "BTCUSDT", lastClose: "65050" }]);
    expect(parsed.researchOnly).toBe(true);
    expect(parsed.executionPermission).toBe(false);
    expect(marketData).toHaveBeenCalledWith(definition, expect.anything());
    expect(presets.get).not.toHaveBeenCalled();
  });

  it("resolves presets against the job owner at execution time", async () => {
    const marketData = vi.fn().mockResolvedValue(snapshot());
    const presets = { get: vi.fn().mockResolvedValue(preset()) };

    const result = await runScreenerTask(
      { ownerUserId: OWNER, payload: payload({ presetId: PRESET_ID }) },
      { presets, marketData, now: () => NOW }
    );

    expect(presets.get).toHaveBeenCalledWith(OWNER, PRESET_ID);
    expect(marketData).toHaveBeenCalledWith(preset().definition, expect.anything());
    expect(parseScreenerRunResultV1(result).definitionHash).toBe(parseAndHashScreenerDefinition(preset().definition).hash);
  });

  it("fails typed when a preset is missing, archived or the payload is malformed", async () => {
    const marketData = vi.fn().mockResolvedValue(snapshot());

    const missing = { get: vi.fn().mockResolvedValue(undefined) };
    await expect(
      runScreenerTask({ ownerUserId: OWNER, payload: payload({ presetId: PRESET_ID }) }, { presets: missing, marketData })
    ).rejects.toMatchObject({ name: "ScreenerTaskError", code: "screener_preset_not_found" });

    const archived = { get: vi.fn().mockResolvedValue(preset({ archivedAt: "2026-07-17T11:00:00.000Z" })) };
    await expect(
      runScreenerTask({ ownerUserId: OWNER, payload: payload({ presetId: PRESET_ID }) }, { presets: archived, marketData })
    ).rejects.toMatchObject({ name: "ScreenerTaskError", code: "screener_preset_archived" });

    const presets = { get: vi.fn() };
    for (const malformed of [
      undefined,
      [],
      { kind: "backtest", request: { schemaVersion: "screener-run-request-v1", definition, researchOnly: true, executionPermission: false } },
      { kind: "screener", request: { schemaVersion: "screener-run-request-v1", definition, presetId: PRESET_ID, researchOnly: true, executionPermission: false } },
      { kind: "screener", request: { schemaVersion: "screener-run-request-v1", researchOnly: true, executionPermission: false } }
    ]) {
      await expect(runScreenerTask({ ownerUserId: OWNER, payload: malformed }, { presets, marketData })).rejects.toMatchObject({
        name: "ScreenerTaskError",
        code: "screener_payload_invalid"
      });
    }
    // Typed failures happen before any market data is fetched.
    expect(marketData).not.toHaveBeenCalled();
  });

  it("degrades exhausted run budgets into per-symbol unavailability", async () => {
    const getCandles = vi.fn();
    const presets = { get: vi.fn() };

    const result = await runScreenerTask(
      { ownerUserId: OWNER, payload: payload({ definition }) },
      {
        presets,
        now: () => NOW,
        marketDataDependencies: {
          instruments: async () => [instrument("BTCUSDT"), instrument("ETHUSDT")],
          fetch: (async () => new Response(JSON.stringify(tickerRows()), { status: 200 })) as typeof fetch,
          candleSource: { getCandles },
          runBudgetMs: 0,
          concurrency: 2,
          now: () => NOW
        }
      }
    );

    const parsed = parseScreenerRunResultV1(result);
    expect(parsed.universe).toEqual({ requested: 2, evaluated: 0, matched: 0, unavailable: 2 });
    expect(parsed.unavailableReasons).toEqual({ "run-budget-exhausted": 2 });
    expect(parsed.rows).toEqual([]);
    expect(getCandles).not.toHaveBeenCalled();
  });

  it("fails the whole run closed when the 24h ticker snapshot is unusable", async () => {
    const presets = { get: vi.fn() };
    await expect(
      runScreenerTask(
        { ownerUserId: OWNER, payload: payload({ definition }) },
        {
          presets,
          marketDataDependencies: {
            instruments: async () => [instrument("BTCUSDT")],
            fetch: (async () => new Response("service unavailable", { status: 503 })) as typeof fetch,
            candleSource: { getCandles: vi.fn() }
          }
        }
      )
    ).rejects.toMatchObject({ name: "ScreenerTaskError", code: "screener_ticker_unavailable" });
  });
});

function payload(request: { definition?: ScreenerDefinitionV1; presetId?: string }): Record<string, unknown> {
  return {
    kind: "screener",
    request: {
      schemaVersion: "screener-run-request-v1",
      ...request,
      researchOnly: true,
      executionPermission: false
    }
  };
}

function snapshot(): ScreenerMarketDataSnapshotV1 {
  return {
    observedAt: NOW,
    universe: [{ symbol: "BTCUSDT", lastClose: 65_100, quoteVolume24h: 5_000_000, change24hPercent: 2.5 }],
    candlesBySymbol: new Map([["BTCUSDT", candleSeries([64_000, 64_500, 65_050])]]),
    unavailableReasonBySymbol: new Map()
  };
}

function preset(overrides: Partial<ScreenerPresetRecord> = {}): ScreenerPresetRecord {
  return {
    id: PRESET_ID,
    ownerUserId: OWNER,
    clientId: "browser.screener-01",
    revision: 1,
    authorizationRevision: 1,
    createdAt: "2026-07-17T07:00:00.000Z",
    updatedAt: "2026-07-17T07:30:00.000Z",
    definitionHash: parseAndHashScreenerDefinition({ ...definition, name: "Preset screen" }).hash,
    definition: { ...definition, name: "Preset screen" },
    ...overrides
  };
}

function instrument(symbol: string): Instrument {
  return {
    symbol,
    displayName: symbol,
    assetClass: "crypto",
    exchange: "Binance",
    currency: "USDT",
    provider: "binance",
    basePrice: 100,
    decimals: 2
  };
}

function tickerRows() {
  return [
    { symbol: "BTCUSDT", lastPrice: "65000", priceChangePercent: "2.5", quoteVolume: "5000000" },
    { symbol: "ETHUSDT", lastPrice: "3500", priceChangePercent: "-1.2", quoteVolume: "2500000" }
  ];
}

function candleSeries(closes: readonly number[]): Candle[] {
  return closes.map((close, index) => {
    const open = index === 0 ? close : closes[index - 1]!;
    return {
      time: Date.parse("2026-07-17T08:00:00.000Z") + index * HOUR,
      open,
      high: Math.max(open, close) * 1.001,
      low: Math.min(open, close) * 0.999,
      close,
      volume: 1_000,
      final: true
    };
  });
}
