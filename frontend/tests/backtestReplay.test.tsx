// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createBacktestReplay, replayFrame, stepReplay } from "@saltanatbotv2/backtest-core";
import { describe, expect, it } from "vitest";
import { BacktestReplayPanel } from "../src/strategy/components/BacktestReplayPanel";
import { DEFAULT_CONFIG, runBacktest } from "../src/strategy/backtest";
import type { StrategyIR } from "../src/strategy/ir";
import type { Candle } from "../src/types";

const candles: Candle[] = [99, 101, 102, 98].map((close, index) => ({
  time: index * 60_000,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 100,
  source: "Binance"
}));

const strategy: StrategyIR = {
  name: "replay",
  inputs: [],
  body: [{
    k: "entry",
    direction: "long",
    when: { k: "compare", op: ">", a: { k: "price", field: "close" }, b: { k: "num", v: 100 } }
  }]
};

describe("deterministic backtest replay", () => {
  it("joins strategy explanations, broker events and equity by bar", () => {
    const result = runBacktest(strategy, candles, { ...DEFAULT_CONFIG, commissionPct: 0, slippagePct: 0 });
    const timeline = createBacktestReplay(result);

    expect(timeline.schemaVersion).toBe(1);
    expect(timeline.frames).toHaveLength(candles.length);
    expect(timeline.frames[1].strategyEvents).toContainEqual({ kind: "entry", direction: "long" });
    expect(timeline.frames[1].executionEvents).toContainEqual(expect.objectContaining({ kind: "fill_scheduled" }));
    expect(timeline.frames[1].explanations.length).toBeGreaterThan(0);
    expect(stepReplay(timeline, 0, 1)).toBe(timeline.frames[1]);
    expect(replayFrame(timeline, 999)).toBe(timeline.frames.at(-1));
    expect(JSON.stringify(createBacktestReplay(result))).toBe(JSON.stringify(timeline));
    expect(Object.isFrozen(timeline.frames)).toBe(true);
  });

  it("offers keyboard-native range and previous/next controls", async () => {
    const result = runBacktest(strategy, candles, DEFAULT_CONFIG);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<BacktestReplayPanel locale="en" result={result} />));

    const range = container.querySelector<HTMLInputElement>('input[type="range"]');
    const next = container.querySelector<HTMLButtonElement>('button[aria-label="Next bar"]');
    const previous = container.querySelector<HTMLButtonElement>('button[aria-label="Previous bar"]');
    expect(range?.getAttribute("max")).toBe("3");
    expect(previous?.disabled).toBe(true);
    await act(async () => next?.click());
    expect(range?.value).toBe("1");
    expect(previous?.disabled).toBe(false);

    await act(async () => root.unmount());
    container.remove();
  });
});
