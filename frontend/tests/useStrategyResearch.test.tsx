// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  compileWorkspace: vi.fn(),
  loadCandleHistory: vi.fn(),
  loadSecurityDataForIr: vi.fn(),
  runBacktest: vi.fn(),
  previewStrategy: vi.fn(),
  runGeneticOptimizeInWorker: vi.fn(),
  runOptimizeInWorker: vi.fn(),
  runWalkForwardInWorker: vi.fn()
}));

vi.mock("../src/strategy/compile", () => ({ compileWorkspace: mocks.compileWorkspace }));
vi.mock("../src/strategy/candleHistory", () => ({ loadCandleHistory: mocks.loadCandleHistory }));
vi.mock("../src/strategy/securityLoader", () => ({ loadSecurityDataForIr: mocks.loadSecurityDataForIr }));
vi.mock("../src/strategy/backtest", () => ({
  DEFAULT_CONFIG: { initialCapital: 10_000, commissionPct: 0.04, allowShort: true },
  runBacktest: mocks.runBacktest,
  previewStrategy: mocks.previewStrategy
}));
vi.mock("../src/strategy/optimizerClient", () => ({
  runGeneticOptimizeInWorker: mocks.runGeneticOptimizeInWorker,
  runOptimizeInWorker: mocks.runOptimizeInWorker,
  runWalkForwardInWorker: mocks.runWalkForwardInWorker
}));

import { useStrategyResearch } from "../src/strategy/useStrategyResearch";
import type { StrategyIR } from "../src/strategy/ir";

afterEach(() => vi.clearAllMocks());

describe("useStrategyResearch", () => {
  it("aborts an in-flight history request when the research workspace unmounts", async () => {
    const ir: StrategyIR = { name: "test", inputs: [], body: [] };
    mocks.compileWorkspace.mockReturnValue({ ir, errors: [] });
    let signal: AbortSignal | undefined;
    mocks.loadCandleHistory.mockImplementation(({ signal: nextSignal }: { signal: AbortSignal }) => {
      signal = nextSignal;
      return new Promise((_resolve, reject) => {
        nextSignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });

    const container = document.createElement("div");
    const root = createRoot(container);
    let research: ReturnType<typeof useStrategyResearch> | undefined;
    function Harness() {
      research = useStrategyResearch({
        workspaceRef: { current: {} as never },
        strategyInputs: [],
        initialSymbol: "BTCUSDT",
        initialTimeframe: "1m",
        exchange: "binance"
      });
      return null;
    }

    await act(async () => root.render(<Harness />));
    await act(async () => {
      void research?.run();
      await Promise.resolve();
    });
    expect(signal?.aborted).toBe(false);

    await act(async () => root.unmount());
    expect(signal?.aborted).toBe(true);
  });

  it("applies an optimized assignment to Blockly and backtests the captured market scope", async () => {
    const fields: Record<string, string> = { NAME: "threshold", VALUE: "10", MIN: "1", MAX: "20" };
    const block = {
      type: "param_number",
      getFieldValue: (name: string) => fields[name],
      setFieldValue: (value: string, name: string) => {
        fields[name] = String(value);
      }
    };
    const workspace = { getAllBlocks: () => [block] };
    const buildIr = (): StrategyIR => ({
      name: "optimized",
      inputs: [{ name: "threshold", value: Number(fields.VALUE), min: 1, max: 20, step: 1 }],
      body: []
    });
    mocks.compileWorkspace.mockImplementation(() => ({ ir: buildIr(), errors: [] }));
    mocks.loadCandleHistory.mockResolvedValue(
      Array.from({ length: 64 }, (_, index) => ({
        time: index * 60_000,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1,
        source: "test"
      }))
    );
    mocks.loadSecurityDataForIr.mockResolvedValue({});
    mocks.runOptimizeInWorker.mockResolvedValue({
      ranked: [{ params: { threshold: 12 }, score: 1 }],
      objective: "netProfit",
      evaluated: 1,
      totalCombos: 1,
      truncated: false
    });
    const backtest = { metrics: { netProfit: 1 } };
    mocks.runBacktest.mockReturnValue(backtest);
    mocks.previewStrategy.mockReturnValue({ plots: [], shapes: {} });
    const onApplyResult = vi.fn();

    const container = document.createElement("div");
    const root = createRoot(container);
    let research: ReturnType<typeof useStrategyResearch> | undefined;
    function Harness() {
      research = useStrategyResearch({
        workspaceRef: { current: workspace as never },
        strategyInputs: buildIr().inputs,
        initialSymbol: "BTCUSDT",
        initialTimeframe: "1m",
        exchange: "binance",
        onApplyResult
      });
      return null;
    }

    await act(async () => root.render(<Harness />));
    await act(async () => {
      await research?.optimize();
    });
    await act(async () => research?.applyCombo({ threshold: 12 }));

    expect(fields.VALUE).toBe("12");
    expect(mocks.runBacktest).toHaveBeenCalledWith(expect.objectContaining({ inputs: [expect.objectContaining({ name: "threshold", value: 12 })] }), expect.any(Array), expect.objectContaining({ initialCapital: 10_000 }), {}, expect.objectContaining({ symbol: "BTCUSDT", timeframe: "1m", requestedBars: 1_000 }));
    expect(onApplyResult).toHaveBeenCalledWith(backtest, "BTCUSDT", "1m", expect.any(Object), "binance");
    await act(async () => root.unmount());
  });

  it("refuses to combine a saved optimizer result with a strategy changed afterward", async () => {
    const fields: Record<string, string> = { NAME: "threshold", VALUE: "10", MIN: "1", MAX: "20" };
    const block = {
      type: "param_number",
      getFieldValue: (name: string) => fields[name],
      setFieldValue: (value: string, name: string) => {
        fields[name] = String(value);
      }
    };
    const workspace = { getAllBlocks: () => [block] };
    const buildIr = (): StrategyIR => ({ name: "stale", inputs: [{ name: "threshold", value: Number(fields.VALUE), min: 1, max: 20, step: 1 }], body: [] });
    mocks.compileWorkspace.mockImplementation(() => ({ ir: buildIr(), errors: [] }));
    mocks.loadCandleHistory.mockResolvedValue(Array.from({ length: 64 }, (_, index) => ({ time: index, open: 1, high: 1, low: 1, close: 1, volume: 1, source: "test" })));
    mocks.loadSecurityDataForIr.mockResolvedValue({});
    mocks.runOptimizeInWorker.mockResolvedValue({ ranked: [], objective: "netProfit", evaluated: 1, totalCombos: 1, truncated: false });

    const container = document.createElement("div");
    const root = createRoot(container);
    let research: ReturnType<typeof useStrategyResearch> | undefined;
    function Harness() {
      research = useStrategyResearch({ workspaceRef: { current: workspace as never }, strategyInputs: buildIr().inputs, initialSymbol: "BTCUSDT", initialTimeframe: "1m", exchange: "binance" });
      return null;
    }
    await act(async () => root.render(<Harness />));
    await act(async () => {
      await research?.optimize();
    });
    fields.VALUE = "11";
    await act(async () => research?.applyCombo({ threshold: 12 }));

    expect(fields.VALUE).toBe("11");
    expect(mocks.runBacktest).not.toHaveBeenCalled();
    expect(research?.errors.join(" ")).toMatch(/changed after optimization/);
    await act(async () => root.unmount());
  });
});
