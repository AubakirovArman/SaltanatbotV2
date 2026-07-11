// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  compileWorkspace: vi.fn(),
  loadCandleHistory: vi.fn(),
  loadSecurityDataForIr: vi.fn(),
  runBacktest: vi.fn(),
  previewStrategy: vi.fn()
}));

vi.mock("../src/strategy/compile", () => ({ compileWorkspace: mocks.compileWorkspace }));
vi.mock("../src/strategy/candleHistory", () => ({ loadCandleHistory: mocks.loadCandleHistory }));
vi.mock("../src/strategy/securityLoader", () => ({ loadSecurityDataForIr: mocks.loadSecurityDataForIr }));
vi.mock("../src/strategy/backtest", () => ({
  DEFAULT_CONFIG: { initialCapital: 10_000, commissionPct: 0.04, allowShort: true },
  runBacktest: mocks.runBacktest,
  previewStrategy: mocks.previewStrategy
}));
vi.mock("../src/strategy/optimizerClient", () => ({ runOptimizeInWorker: vi.fn(), runWalkForwardInWorker: vi.fn() }));

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
});
