// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SharedSocketClient } from "../src/api/sharedWebSocketPool";
import type { BrowserPerformanceProbeController, BrowserPerformanceSummary } from "../src/performance/browserProbe";
import type { Candle, StreamMessage } from "../src/types";

const mocks = vi.hoisted(() => ({
  createMarketSocket: vi.fn(),
  gapAnalysis: vi.fn(() => ({ gapCount: 0, missingBars: 0, largestGapMs: 0 })),
  getCandles: vi.fn(),
  parseStreamMessage: vi.fn((data: string) => JSON.parse(data) as StreamMessage)
}));

vi.mock("../src/api/marketClient", () => ({
  createMarketSocket: mocks.createMarketSocket,
  getCandles: mocks.getCandles,
  parseStreamMessage: mocks.parseStreamMessage
}));

vi.mock("../src/market/dataQuality", () => ({
  analyzeCandleGaps: mocks.gapAnalysis
}));

import { useMarketStream } from "../src/hooks/useMarketStream";

const history: Candle[] = [
  { time: 1, open: 10, high: 11, low: 9, close: 10, volume: 1, final: true },
  { time: 2, open: 10, high: 12, low: 10, close: 11, volume: 2, final: false }
];

function fakeSocket(): SharedSocketClient & { close: ReturnType<typeof vi.fn> } {
  return {
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    close: vi.fn()
  };
}

afterEach(() => {
  window.__SBV2_BROWSER_PERF_PROBE__ = undefined;
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useMarketStream", () => {
  it("does not fetch or connect while disabled and tears down when disabled", async () => {
    const socket = fakeSocket();
    mocks.createMarketSocket.mockReturnValue(socket);
    mocks.getCandles.mockResolvedValue({ candles: history, provider: "Test", hasMore: false });
    const container = document.createElement("div");
    const root = createRoot(container);
    let state: ReturnType<typeof useMarketStream> | undefined;

    function Harness({ enabled }: { enabled: boolean }) {
      state = useMarketStream("BTCUSDT", "1m", "binance", { enabled });
      return null;
    }

    await act(async () => root.render(<Harness enabled={false} />));
    expect(state?.connection).toBe("idle");
    expect(mocks.getCandles).not.toHaveBeenCalled();
    expect(mocks.createMarketSocket).not.toHaveBeenCalled();

    await act(async () => root.render(<Harness enabled />));
    expect(mocks.getCandles).toHaveBeenCalledTimes(1);
    expect(mocks.createMarketSocket).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<Harness enabled={false} />));
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(state?.connection).toBe("idle");
    await act(async () => root.unmount());
  });

  it("keeps the structural gap-analysis input stable for same-bar ticks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const socket = fakeSocket();
    const recordMetric = vi.fn();
    const probe: BrowserPerformanceProbeController = {
      recordMetric,
      recordRender: vi.fn(),
      read: vi.fn(() => ({ schemaVersion: 1 }) as BrowserPerformanceSummary),
      reset: vi.fn(),
      stop: vi.fn()
    };
    window.__SBV2_BROWSER_PERF_PROBE__ = probe;
    mocks.createMarketSocket.mockReturnValue(socket);
    mocks.getCandles.mockResolvedValue({ candles: history, provider: "Test", hasMore: true });
    const container = document.createElement("div");
    const root = createRoot(container);
    let state: ReturnType<typeof useMarketStream> | undefined;

    function Harness() {
      state = useMarketStream("BTCUSDT", "1m");
      return null;
    }

    await act(async () => root.render(<Harness />));
    const gapCallsAfterSnapshot = mocks.gapAnalysis.mock.calls.length;
    const previousCandles = state?.candles;
    expect(recordMetric).toHaveBeenCalledWith("candle.copiedElements", history.length);
    expect(recordMetric).toHaveBeenCalledWith("candle.copiedElements.snapshot", history.length);
    recordMetric.mockClear();
    const tick = (close: number): StreamMessage => ({
      type: "candle",
      symbol: "BTCUSDT",
      timeframe: "1m",
      candle: { ...history[1], close },
      provider: "Test",
      ts: Date.now()
    });

    await act(async () => {
      socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify(tick(11.25)) }));
      socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify(tick(11.5)) }));
      socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify(tick(11.75)) }));
    });

    expect(state?.candles).toBe(previousCandles);
    expect(state?.candles.at(-1)?.close).toBe(11);
    expect(mocks.gapAnalysis).toHaveBeenCalledTimes(gapCallsAfterSnapshot);
    expect(recordMetric.mock.calls.filter(([name]) => name === "stream.processed")).toHaveLength(3);
    expect(recordMetric.mock.calls.filter(([name]) => name === "candle.received")).toHaveLength(3);
    expect(recordMetric.mock.calls.filter(([name]) => name === "candle.coalesced")).toHaveLength(3);
    expect(recordMetric).not.toHaveBeenCalledWith("candle.committed", 1);
    expect(recordMetric).not.toHaveBeenCalledWith("candle.copiedElements", history.length);

    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(state?.candles.at(-1)?.close).toBe(11.75);
    expect(mocks.gapAnalysis).toHaveBeenCalledTimes(gapCallsAfterSnapshot);
    expect(recordMetric).toHaveBeenCalledWith("candle.committed", 1);
    expect(recordMetric).toHaveBeenCalledWith("candle.provisionalTail", 1);

    recordMetric.mockClear();
    const gapCallsBeforeFinal = mocks.gapAnalysis.mock.calls.length;
    const finalTick: StreamMessage = {
      type: "candle",
      symbol: "BTCUSDT",
      timeframe: "1m",
      candle: { ...history[1], close: 11.8, final: true },
      provider: "Test",
      ts: Date.now()
    };
    await act(async () => {
      socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify(finalTick) }));
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(state?.candles.at(-1)?.final).toBe(true);
    expect(mocks.gapAnalysis).toHaveBeenCalledTimes(gapCallsBeforeFinal + 1);
    expect(recordMetric).toHaveBeenCalledWith("candle.copiedElements", history.length);
    expect(recordMetric).toHaveBeenCalledWith("candle.copiedElements.finalization", history.length);
    expect(recordMetric).not.toHaveBeenCalledWith("candle.copiedElements.newBar", history.length);
    expect(recordMetric).not.toHaveBeenCalledWith("candle.provisionalTail", 1);

    recordMetric.mockClear();
    const gapCallsBeforeNewBar = mocks.gapAnalysis.mock.calls.length;
    const nextBar: StreamMessage = {
      ...tick(12),
      candle: { ...history[1], time: 3, close: 12 }
    };
    await act(async () => socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify(nextBar) })));
    expect(mocks.gapAnalysis).toHaveBeenCalledTimes(gapCallsBeforeNewBar + 1);
    expect(recordMetric).toHaveBeenCalledWith("candle.copiedElements", 3);
    expect(recordMetric).toHaveBeenCalledWith("candle.copiedElements.newBar", 3);
    expect(recordMetric).not.toHaveBeenCalledWith("candle.copiedElements.finalization", 3);

    recordMetric.mockClear();
    await act(async () => socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ ...nextBar, candle: { ...nextBar.candle, close: 12.25 } }) })));
    expect(recordMetric).toHaveBeenCalledWith("candle.coalesced", 1);
    await act(async () => root.unmount());
    await vi.advanceTimersByTimeAsync(250);
    expect(recordMetric).not.toHaveBeenCalledWith("candle.committed", 1);
  });

  it("classifies older-history copies as prepend work", async () => {
    const socket = fakeSocket();
    const recordMetric = vi.fn();
    window.__SBV2_BROWSER_PERF_PROBE__ = {
      recordMetric,
      recordRender: vi.fn(),
      read: vi.fn(() => ({ schemaVersion: 1 }) as BrowserPerformanceSummary),
      reset: vi.fn(),
      stop: vi.fn()
    };
    mocks.createMarketSocket.mockReturnValue(socket);
    mocks.getCandles
      .mockResolvedValueOnce({ candles: history, provider: "Test", hasMore: true })
      .mockResolvedValueOnce({
        candles: [{ time: 0, open: 9, high: 10, low: 8, close: 9, volume: 3, final: true }],
        provider: "Test",
        hasMore: false
      });
    const container = document.createElement("div");
    const root = createRoot(container);
    let state: ReturnType<typeof useMarketStream> | undefined;

    function Harness() {
      state = useMarketStream("BTCUSDT", "1m");
      return null;
    }

    await act(async () => root.render(<Harness />));
    recordMetric.mockClear();
    await act(async () => state?.loadOlder());

    expect(state?.candles.map((candle) => candle.time)).toEqual([0, 1, 2]);
    expect(recordMetric).toHaveBeenCalledWith("candle.copiedElements", 3);
    expect(recordMetric).toHaveBeenCalledWith("candle.copiedElements.prepend", 3);
    expect(recordMetric).not.toHaveBeenCalledWith("candle.copiedElements.snapshot", 3);
    await act(async () => root.unmount());
  });
});
