// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EvaluationApiError,
  parseEvaluationResult,
  runMultiMarketEvaluation,
  submitMultiMarketEvaluation,
  type EvaluationJobSnapshot,
  type MultiMarketEvaluationRequest
} from "../src/strategy/evaluationClient";

const OWNER = "00000000-0000-4000-8000-000000000061";
const JOB_ID = "00000000-0000-4000-8000-000000000062";
const FINGERPRINT = "d076618630cf584258a3d81c288db5d29d42c76329e1a27ab4373adf32001930";

beforeEach(() => {
  document.cookie = "sbv2_csrf=eval-csrf; path=/";
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = "sbv2_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
});

function validRequest(): MultiMarketEvaluationRequest {
  return {
    ir: { name: "Eval", inputs: [], body: [] },
    markets: [
      { symbol: "BTCUSDT", timeframe: "1h" },
      { symbol: "ETHUSDT", timeframe: "1h" }
    ],
    lookbackBars: 3_000,
    split: { trainFraction: 0.7, embargoBars: 8 },
    seed: 42
  };
}

/** Window sections exactly as the server emits them: flattened metrics + counts. */
function windowSection(netProfitPct: number, overrides: Record<string, unknown> = {}) {
  return {
    netProfitPct,
    sharpe: 1.2,
    profitFactor: 1.6,
    maxDrawdownPct: 4.5,
    totalTrades: 12,
    liquidated: false,
    barCount: 840,
    tradeCount: 12,
    ...overrides
  };
}

function serverResult(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "multi-market-eval-v1",
    engineVersion: "backtest-core-v1",
    dataset: { schemaVersion: "dataset-v1", fingerprint: FINGERPRINT },
    seed: 42,
    markets: [
      { symbol: "BTCUSDT", timeframe: "1h", train: windowSection(9.1), outOfSample: windowSection(3.4) },
      { symbol: "ETHUSDT", timeframe: "1h", train: windowSection(6.2), outOfSample: windowSection(2.1) }
    ],
    portfolio: {},
    ...overrides
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("multi-market evaluation jobs client", () => {
  it("submits the exact spec POST body with owner, CSRF and no-store transport", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ job: { id: JOB_ID, status: "queued" } }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitMultiMarketEvaluation(OWNER, validRequest())).resolves.toEqual({ id: JOB_ID, status: "queued" });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/jobs");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    const headers = new Headers(init.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-SBV2-Expected-User")).toBe(OWNER);
    expect(headers.get("X-CSRF-Token")).toBe("eval-csrf");
    // Byte-exact body contract: only the spec keys, so a strict server schema accepts it.
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "multi-market-eval",
      ir: { name: "Eval", inputs: [], body: [] },
      markets: [
        { symbol: "BTCUSDT", timeframe: "1h" },
        { symbol: "ETHUSDT", timeframe: "1h" }
      ],
      lookbackBars: 3_000,
      split: { trainFraction: 0.7, embargoBars: 8 },
      seed: 42
    });
  });

  it("fails closed on out-of-bounds requests without any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const valid = validRequest();
    const market = (symbol: string) => ({ symbol, timeframe: "1h" });
    const invalidRequests: MultiMarketEvaluationRequest[] = [
      { ...valid, ir: undefined },
      { ...valid, markets: [] },
      { ...valid, markets: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT"].map(market) },
      { ...valid, markets: [market("BTCUSDT"), market("BTCUSDT")] },
      { ...valid, markets: [market("btcusdt")] },
      { ...valid, markets: [{ symbol: "BTCUSDT", timeframe: "1 hour" }] },
      { ...valid, lookbackBars: 499 },
      { ...valid, lookbackBars: 20_001 },
      { ...valid, split: { trainFraction: 0.4, embargoBars: 8 } },
      { ...valid, split: { trainFraction: 0.7, embargoBars: 501 } },
      { ...valid, seed: -1 },
      { ...valid, seed: 1.5 }
    ];
    const rejection = (request: MultiMarketEvaluationRequest, owner = OWNER) =>
      Promise.resolve()
        .then(() => submitMultiMarketEvaluation(owner, request))
        .catch((error) => error);
    for (const request of invalidRequests) {
      expect(await rejection(request)).toMatchObject({ name: "EvaluationApiError", code: "invalid_request" });
    }
    expect(await rejection(valid, "not-a-uuid")).toMatchObject({ name: "EvaluationApiError", code: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits, polls to completion and returns the parsed provenance-carrying result", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ job: { id: JOB_ID, status: "queued" } }, 202))
      .mockResolvedValueOnce(json({ job: { id: JOB_ID, status: "running" } }))
      .mockResolvedValueOnce(json({ job: { id: JOB_ID, status: "completed", result: serverResult() } }));
    vi.stubGlobal("fetch", fetchMock);
    const observed: EvaluationJobSnapshot[] = [];

    const result = await runMultiMarketEvaluation(OWNER, validRequest(), {
      pollIntervalMs: 250,
      onJob: (snapshot) => observed.push(snapshot)
    });

    expect(fetchMock.mock.calls.map((call) => `${(call[1] as RequestInit).method} ${call[0]}`)).toEqual([
      "POST /api/jobs",
      `GET /api/jobs/${JOB_ID}`,
      `GET /api/jobs/${JOB_ID}`
    ]);
    expect(observed.map((snapshot) => snapshot.status)).toEqual(["queued", "running", "completed"]);
    expect(result.schemaVersion).toBe("multi-market-eval-v1");
    expect(result.engineVersion).toBe("backtest-core-v1");
    expect(result.datasetFingerprint).toBe(FINGERPRINT);
    expect(result.seed).toBe(42);
    expect(result.markets).toHaveLength(2);
    expect(result.markets[0]).toEqual({
      symbol: "BTCUSDT",
      timeframe: "1h",
      train: { netProfitPct: 9.1, sharpe: 1.2, profitFactor: 1.6, maxDrawdownPct: 4.5, trades: 12, liquidated: false },
      outOfSample: { netProfitPct: 3.4, sharpe: 1.2, profitFactor: 1.6, maxDrawdownPct: 4.5, trades: 12, liquidated: false }
    });
  });

  it("surfaces failed jobs as their stable error code and cancelled jobs as run_cancelled", async () => {
    const failed = vi
      .fn()
      .mockResolvedValueOnce(json({ job: { id: JOB_ID, status: "queued" } }, 202))
      .mockResolvedValueOnce(
        json({
          job: {
            id: JOB_ID,
            status: "failed",
            errorCode: "multi_market_eval_market_bars_insufficient",
            errorMessage: "Market ETHUSDT supplied 300 of the 3000 closed real bars this evaluation requires."
          }
        })
      );
    vi.stubGlobal("fetch", failed);
    await expect(runMultiMarketEvaluation(OWNER, validRequest(), { pollIntervalMs: 250 })).rejects.toMatchObject({
      code: "multi_market_eval_market_bars_insufficient",
      message: expect.stringContaining("ETHUSDT")
    });

    const cancelled = vi
      .fn()
      .mockResolvedValueOnce(json({ job: { id: JOB_ID, status: "queued" } }, 202))
      .mockResolvedValueOnce(json({ job: { id: JOB_ID, status: "cancelled" } }));
    vi.stubGlobal("fetch", cancelled);
    await expect(runMultiMarketEvaluation(OWNER, validRequest(), { pollIntervalMs: 250 })).rejects.toMatchObject({
      code: "run_cancelled"
    });
  });

  it("maps the server quota rejection onto job_quota_exceeded", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: "Too many active jobs.", code: "job_quota_exceeded" }, 429));
    vi.stubGlobal("fetch", fetchMock);
    const failure = await runMultiMarketEvaluation(OWNER, validRequest()).catch((error) => error);
    expect(failure).toBeInstanceOf(EvaluationApiError);
    expect(failure).toMatchObject({ status: 429, code: "job_quota_exceeded" });
  });

  it("cancels the job and reports run_timeout when the deadline passes before completion", async () => {
    const fetchMock = vi.fn((path: string, init: RequestInit) => {
      if (init.method === "POST" && path === "/api/jobs") return Promise.resolve(json({ job: { id: JOB_ID, status: "queued" } }, 202));
      if (init.method === "POST" && path === `/api/jobs/${JOB_ID}/cancel`) {
        return Promise.resolve(json({ job: { id: JOB_ID, status: "cancelled" } }));
      }
      return Promise.resolve(json({ job: { id: JOB_ID, status: "running" } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(runMultiMarketEvaluation(OWNER, validRequest(), { pollIntervalMs: 250, timeoutMs: 1_000 })).rejects.toMatchObject({
      code: "run_timeout"
    });
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => call[0] === `/api/jobs/${JOB_ID}/cancel`)).toBe(true);
    });
  });
});

describe("multi-market evaluation result parsing", () => {
  it("accepts the server's flattened windows and metrics-nested windows alike", () => {
    expect(parseEvaluationResult(serverResult())).toBeDefined();
    const nested = serverResult({
      markets: [
        {
          symbol: "BTCUSDT",
          timeframe: "1h",
          train: { metrics: { netProfitPct: 1, sharpe: 1, profitFactor: 1, maxDrawdownPct: 1, liquidated: false, totalTrades: 7 }, tradeCount: 7 },
          outOfSample: { metrics: { netProfitPct: 1, sharpe: 1, profitFactor: 1, maxDrawdownPct: 1, liquidated: false, totalTrades: 7 }, tradeCount: 7 }
        }
      ]
    });
    const parsed = parseEvaluationResult(nested);
    expect(parsed?.markets[0]?.train.trades).toBe(7);
  });

  it("fails closed on version, fingerprint and shape violations", () => {
    expect(parseEvaluationResult(undefined)).toBeUndefined();
    expect(parseEvaluationResult(serverResult({ schemaVersion: "multi-market-eval-v2" }))).toBeUndefined();
    expect(parseEvaluationResult(serverResult({ dataset: { fingerprint: "not-hex" } }))).toBeUndefined();
    expect(parseEvaluationResult(serverResult({ dataset: {} }))).toBeUndefined();
    expect(parseEvaluationResult(serverResult({ seed: 1.5 }))).toBeUndefined();
    expect(parseEvaluationResult(serverResult({ markets: [] }))).toBeUndefined();
    const noLiquidated = serverResult();
    (noLiquidated.markets[0]!.train as Record<string, unknown>).liquidated = undefined;
    expect(parseEvaluationResult(noLiquidated)).toBeUndefined();
    const negativeTrades = serverResult();
    (negativeTrades.markets[0]!.train as Record<string, unknown>).tradeCount = -1;
    expect(parseEvaluationResult(negativeTrades)).toBeUndefined();
  });

  it("keeps JSON-nulled non-finite metrics parseable so the pure ranker fails them closed", () => {
    // A window with zero losing trades has profitFactor = Infinity, which the
    // durable JSONB result can only store as null. The result must still parse;
    // the ranker's finite-metrics gate is the single honesty boundary.
    const allWins = serverResult();
    (allWins.markets[0]!.outOfSample as Record<string, unknown>).profitFactor = null;
    const parsed = parseEvaluationResult(allWins);
    expect(parsed).toBeDefined();
    expect(Number.isNaN(parsed!.markets[0]!.outOfSample.profitFactor)).toBe(true);
    // Absent metrics still fail the parse: null means "measured, not storable".
    const missing = serverResult();
    (missing.markets[0]!.outOfSample as Record<string, unknown>).profitFactor = undefined;
    expect(parseEvaluationResult(missing)).toBeUndefined();
  });
});
