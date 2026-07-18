import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { computeDatasetFingerprint } from "@saltanatbotv2/backtest-core";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getResearchJobDefinition,
  registerBuiltinResearchJobKinds,
  ResearchJobExecutionError,
  type ResearchJobExecutionContext,
  type ResearchJobInProcessDefinition
} from "../src/jobs/registry.js";
import type { Candle } from "../src/types.js";
import { createBacktestThreadRunner, type BacktestThreadRunner } from "../src/workers/backtestThreadRunner.js";
import {
  findUnknownEvaluationMarket,
  MULTI_MARKET_EVAL_RESULT_MAX_BYTES,
  type MultiMarketEvalCandleSource
} from "../src/workers/multiMarketEvalTask.js";

const OWNER_ID = "00000000-0000-4000-8000-000000000094";
const JOB_ID = "00000000-0000-4000-8000-000000000095";
const HOUR_MS = 3_600_000;
const BASE_TIME = Date.UTC(2026, 0, 1);
/** Golden dataset fingerprint for the deterministic two-market fixture below. */
const GOLDEN_FINGERPRINT = "d076618630cf584258a3d81c288db5d29d42c76329e1a27ab4373adf32001930";

registerBuiltinResearchJobKinds();
const definition = getResearchJobDefinition("multi-market-eval") as ResearchJobInProcessDefinition;

// The CPU side must run through the EXISTING backtestTask worker-thread
// protocol. Vitest never emits backend/dist, so the suite bundles the real
// worker entry (backtestTask.ts + backtest-core) once into a temp .mjs file
// and spawns genuine worker threads from it.
let bundleDir: string;
let workerEntry: URL;

beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), "r9a-backtest-worker-"));
  const outfile = join(bundleDir, "backtestTask.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/workers/backtestTask.ts", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "silent"
  });
  workerEntry = pathToFileURL(outfile);
}, 60_000);

afterAll(() => {
  rmSync(bundleDir, { recursive: true, force: true });
});

/** Deterministic wave with drift: positive prices, regular SMA crossings. */
function candleHistory(symbol: string, count: number, formingTip = false): Candle[] {
  const phase = symbol === "BTCUSDT" ? 0 : 3;
  const bars: Candle[] = [];
  let close = 100 + phase;
  for (let index = 0; index < count; index += 1) {
    const open = close;
    close = 100 + phase + 10 * Math.sin((index + phase) / 7) + index * 0.01;
    bars.push({
      time: BASE_TIME + index * HOUR_MS,
      open,
      high: Math.max(open, close) + 0.4,
      low: Math.min(open, close) - 0.4,
      close,
      volume: 1_000 + (index % 7),
      final: true,
      source: "BinanceKlines"
    });
  }
  if (formingTip) {
    const tip = bars.at(-1)!;
    bars.push({ ...tip, time: tip.time + HOUR_MS, final: false });
  }
  return bars;
}

function pagedSource(histories: Map<string, Candle[]>): MultiMarketEvalCandleSource {
  return {
    async getCandles(request) {
      const history = histories.get(request.symbol) ?? [];
      const eligible = request.endTime === undefined ? history : history.filter((bar) => bar.time <= request.endTime!);
      return eligible.slice(-request.limit);
    }
  };
}

/** Strategy with regular entries and exits in every window of the fixture. */
function crossoverIr() {
  const sma = { k: "ma", kind: "sma", period: { k: "num", v: 5 }, source: { k: "price", field: "close" } };
  return {
    name: "Eval crossover",
    inputs: [],
    body: [
      { k: "entry", direction: "long", when: { k: "cross", dir: "above", a: { k: "price", field: "close" }, b: sma } },
      { k: "exit", when: { k: "cross", dir: "below", a: { k: "price", field: "close" }, b: sma } }
    ]
  };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "multi-market-eval",
    strategy: crossoverIr(),
    markets: [
      { symbol: "BTCUSDT", timeframe: "1h" },
      { symbol: "ETHUSDT", timeframe: "1h" }
    ],
    lookbackBars: 1_200,
    split: { trainFraction: 0.7, embargoBars: 8 },
    seed: 7,
    ...overrides
  };
}

interface ContextOverrides {
  signal?: AbortSignal;
  heartbeat?: (progress: number) => void;
  candleSource?: MultiMarketEvalCandleSource;
  backtestRunner?: BacktestThreadRunner;
}

function executionContext(jobPayload: Record<string, unknown>, overrides: ContextOverrides = {}): ResearchJobExecutionContext {
  return {
    ownerUserId: OWNER_ID,
    jobId: JOB_ID,
    payload: jobPayload,
    signal: overrides.signal ?? new AbortController().signal,
    heartbeat: overrides.heartbeat ?? (() => undefined),
    logger: () => undefined,
    ...(overrides.candleSource ? { candleSource: overrides.candleSource } : {}),
    ...(overrides.backtestRunner ? { backtestRunner: overrides.backtestRunner } : {})
  };
}

function fakeReport(pad?: string): Record<string, unknown> {
  return {
    name: "Fake strategy",
    metrics: {
      netProfitPct: 1.5,
      sharpe: 0.4,
      profitFactor: 1.2,
      maxDrawdownPct: 3,
      totalTrades: 6,
      liquidated: false,
      ...(pad ? { pad } : {})
    },
    trades: [],
    metadata: {
      config: {
        initialCapital: 10_000,
        commissionPct: 0.1,
        slippagePct: 0.05,
        allowShort: true,
        fillTiming: "next_open",
        maxLeverage: 5,
        qtyStep: 0,
        fundingRatePctPer8h: 0
      }
    }
  };
}

describe("multi-market evaluation job (real registry + worker-thread backtests)", () => {
  it("runs deterministically: two identical runs produce byte-identical results with golden dataset provenance", async () => {
    const histories = new Map([
      ["BTCUSDT", candleHistory("BTCUSDT", 1_300, true)],
      ["ETHUSDT", candleHistory("ETHUSDT", 1_300, true)]
    ]);
    const runner = createBacktestThreadRunner({ workerEntry });
    const run = (heartbeats: number[]) =>
      definition.run(
        executionContext(payload(), {
          candleSource: pagedSource(histories),
          backtestRunner: runner,
          heartbeat: (progress) => heartbeats.push(progress)
        })
      );

    const heartbeats: number[] = [];
    const first = await run(heartbeats);
    const second = await run([]);

    // Determinism is the release criterion: same dataset => same result bytes.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    expect(first.schemaVersion).toBe("multi-market-eval-v1");
    expect(first.engineVersion).toBe("backtest-core-v1");
    expect(first.seed).toBe(7);

    // dataset-v1 provenance over the exact evaluated window (forming tip dropped).
    const window = (symbol: string) => histories.get(symbol)!.filter((bar) => bar.final === true).slice(-1_200);
    const expectedFingerprint = computeDatasetFingerprint(
      "binance:spot:last",
      "1h",
      new Map([
        ["BTCUSDT", window("BTCUSDT")],
        ["ETHUSDT", window("ETHUSDT")]
      ])
    );
    const dataset = first.dataset as Record<string, unknown>;
    expect(dataset).toMatchObject({
      schemaVersion: "dataset-v1",
      source: "binance:spot:last",
      timeframe: "1h",
      symbols: ["BTCUSDT", "ETHUSDT"],
      barCounts: { BTCUSDT: 1_200, ETHUSDT: 1_200 },
      split: { trainFraction: 0.7, embargoBars: 8, testFraction: 0.3 },
      fromMs: window("BTCUSDT")[0]!.time,
      toMs: window("BTCUSDT").at(-1)!.time
    });
    expect(dataset.fingerprint).toBe(expectedFingerprint);
    expect(dataset.fingerprint).toBe(GOLDEN_FINGERPRINT);

    // Golden metrics from the real worker-thread backtests (train 840 bars,
    // embargo 8, out-of-sample 352 bars).
    const markets = first.markets as Record<string, unknown>[];
    expect(markets.map((market) => market.symbol)).toEqual(["BTCUSDT", "ETHUSDT"]);
    const btc = markets[0]!;
    const train = btc.train as Record<string, unknown>;
    const oos = btc.outOfSample as Record<string, unknown>;
    expect(train.barCount).toBe(840);
    expect(oos.barCount).toBe(352);
    expect(train.tradeCount).toBeGreaterThan(5);
    expect(oos.tradeCount).toBeGreaterThan(5);
    for (const section of [train, oos]) {
      expect(typeof section.netProfitPct).toBe("number");
      expect(typeof section.sharpe).toBe("number");
      expect(typeof section.profitFactor).toBe("number");
      expect(typeof section.maxDrawdownPct).toBe("number");
      expect(section.liquidated).toBe(false);
    }
    expect(train.netProfitPct).toBe(GOLDEN_TRAIN_NET_PROFIT_PCT);
    expect(oos.netProfitPct).toBe(GOLDEN_OOS_NET_PROFIT_PCT);
    expect(train.totalTrades).toBe(train.tradeCount);

    // Out-of-sample shared-capital portfolio section: bounded, no curves.
    const portfolio = first.portfolio as Record<string, unknown>;
    expect(portfolio.symbols).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(portfolio).toHaveProperty("metrics");
    expect(portfolio).toHaveProperty("correlation");
    expect(portfolio).toHaveProperty("contributions");
    expect(portfolio.rejectionCounts).toMatchObject({ max_concurrent: expect.any(Number) });
    expect(portfolio).not.toHaveProperty("equityCurve");
    expect(portfolio).not.toHaveProperty("trades");

    // Bounded result and phase-scaled monotone heartbeats.
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(MULTI_MARKET_EVAL_RESULT_MAX_BYTES);
    expect(heartbeats[0]).toBe(0.05);
    expect(heartbeats.at(-1)).toBe(0.98);
    for (let index = 1; index < heartbeats.length; index += 1) {
      expect(heartbeats[index]).toBeGreaterThanOrEqual(heartbeats[index - 1]!);
    }
  }, 120_000);

  it("fails the whole job with an explicit reason when a market cannot supply enough real bars", async () => {
    const histories = new Map([
      ["BTCUSDT", candleHistory("BTCUSDT", 1_300)],
      ["ETHUSDT", candleHistory("ETHUSDT", 300)]
    ]);
    const failure = await definition
      .run(executionContext(payload(), { candleSource: pagedSource(histories), backtestRunner: unreachableRunner() }))
      .catch((error) => error);
    expect(failure).toBeInstanceOf(ResearchJobExecutionError);
    expect((failure as ResearchJobExecutionError).code).toBe("multi_market_eval_market_bars_insufficient");
    expect((failure as ResearchJobExecutionError).message).toContain("ETHUSDT");
    expect((failure as ResearchJobExecutionError).message).toContain("synthetic fills are not allowed");
  });

  it("rejects synthetic fallback bars: server evaluation requires real exchange data", async () => {
    const synthetic = candleHistory("BTCUSDT", 1_300).map((bar) => ({ ...bar, source: "FallbackSynthetic" }));
    const histories = new Map([
      ["BTCUSDT", synthetic],
      ["ETHUSDT", candleHistory("ETHUSDT", 1_300)]
    ]);
    await expect(
      definition.run(executionContext(payload(), { candleSource: pagedSource(histories), backtestRunner: unreachableRunner() }))
    ).rejects.toMatchObject({ code: "multi_market_eval_market_bars_not_real" });
  });

  it("rejects windows containing non-final bars", async () => {
    const history = candleHistory("BTCUSDT", 1_300);
    history[900] = { ...history[900]!, final: false };
    const histories = new Map([
      ["BTCUSDT", history],
      ["ETHUSDT", candleHistory("ETHUSDT", 1_300)]
    ]);
    await expect(
      definition.run(executionContext(payload(), { candleSource: pagedSource(histories), backtestRunner: unreachableRunner() }))
    ).rejects.toMatchObject({ code: "multi_market_eval_market_bars_invalid" });
  });

  it("honors cancellation between markets without starting the next market's backtests", async () => {
    const histories = new Map([
      ["BTCUSDT", candleHistory("BTCUSDT", 1_300)],
      ["ETHUSDT", candleHistory("ETHUSDT", 1_300)]
    ]);
    const abort = new AbortController();
    let runs = 0;
    const runner: BacktestThreadRunner = {
      async run() {
        runs += 1;
        // Cancel while the first market's out-of-sample backtest is finishing.
        if (runs === 2) abort.abort();
        return fakeReport();
      }
    };
    await expect(
      definition.run(executionContext(payload(), { candleSource: pagedSource(histories), backtestRunner: runner, signal: abort.signal }))
    ).rejects.toMatchObject({ code: "multi_market_eval_cancelled" });
    expect(runs).toBe(2);
  });

  it("fails closed when the result exceeds the 256KB bound even after correlation trimming", async () => {
    const histories = new Map([["BTCUSDT", candleHistory("BTCUSDT", 600)]]);
    const runner: BacktestThreadRunner = {
      async run() {
        return fakeReport("x".repeat(150_000));
      }
    };
    await expect(
      definition.run(
        executionContext(payload({ markets: [{ symbol: "BTCUSDT", timeframe: "1h" }], lookbackBars: 500 }), {
          candleSource: pagedSource(histories),
          backtestRunner: runner
        })
      )
    ).rejects.toMatchObject({ code: "multi_market_eval_result_too_large" });
  });

  it("re-validates the durable payload and IR at execution time", async () => {
    const histories = new Map([["BTCUSDT", candleHistory("BTCUSDT", 600)]]);
    const base = { candleSource: pagedSource(histories), backtestRunner: unreachableRunner() };
    const { seed: _seed, ...withoutSeed } = payload();
    await expect(definition.run(executionContext(withoutSeed, base))).rejects.toMatchObject({
      code: "multi_market_eval_payload_invalid"
    });
    await expect(
      definition.run(executionContext(payload({ strategy: { name: "bad", inputs: [], body: [{ k: "nope" }] } }), base))
    ).rejects.toMatchObject({ code: "multi_market_eval_payload_invalid" });
  });

  it("fails a split whose windows are too small to backtest", async () => {
    const histories = new Map([["BTCUSDT", candleHistory("BTCUSDT", 600)]]);
    await expect(
      definition.run(
        executionContext(
          payload({
            markets: [{ symbol: "BTCUSDT", timeframe: "1h" }],
            lookbackBars: 500,
            split: { trainFraction: 0.9, embargoBars: 45 }
          }),
          { candleSource: pagedSource(histories), backtestRunner: unreachableRunner() }
        )
      )
    ).rejects.toMatchObject({ code: "multi_market_eval_market_bars_insufficient" });
  });
});

describe("evaluation market catalog gate", () => {
  it("accepts real Binance spot instruments and rejects unknown or synthetic-only symbols", () => {
    expect(findUnknownEvaluationMarket([{ symbol: "BTCUSDT", timeframe: "1h" }])).toBeUndefined();
    expect(findUnknownEvaluationMarket([{ symbol: "NOPEUSDT", timeframe: "1h" }])).toBe("NOPEUSDT");
    // EURUSD exists in the catalog but only with a synthetic provider.
    expect(
      findUnknownEvaluationMarket([
        { symbol: "BTCUSDT", timeframe: "1h" },
        { symbol: "EURUSD", timeframe: "1h" }
      ])
    ).toBe("EURUSD");
  });
});

function unreachableRunner(): BacktestThreadRunner {
  return {
    async run() {
      throw new Error("backtests must not start for this scenario");
    }
  };
}

// Pinned after the first recorded run of the deterministic fixture; any drift
// in engine, dataset serialization or split logic must fail loudly here.
const GOLDEN_TRAIN_NET_PROFIT_PCT = 3069.9431466734254;
const GOLDEN_OOS_NET_PROFIT_PCT = 295.79736617628566;
