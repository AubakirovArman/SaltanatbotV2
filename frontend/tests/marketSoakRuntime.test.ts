// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapSoakRuntime, createSoakHistory } from "../../e2e/support/marketSoak";

const nativeWebSocket = window.WebSocket;

afterEach(() => {
  const target = window as Window & {
    __SBV2_SOAK_RUNTIME__?: { stop(): void };
  };
  const runtime = target.__SBV2_SOAK_RUNTIME__;
  runtime?.stop();
  Reflect.deleteProperty(target, "__SBV2_SOAK_RUNTIME__");
  window.WebSocket = nativeWebSocket;
  vi.useRealTimers();
});

describe("synthetic market soak runtime", () => {
  it("finalizes the last tick of each minute before opening the next provisional bar", async () => {
    vi.useFakeTimers();
    const history = createSoakHistory(2);
    bootstrapSoakRuntime({ history, tickIntervalMs: 1_000 });
    const socket = new WebSocket("ws://localhost/stream?symbol=BTCUSDT&timeframe=1m");
    const candles: Array<{ time: number; final?: boolean }> = [];
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        candle?: { time: number; final?: boolean };
      };
      if (message.type === "candle" && message.candle) candles.push(message.candle);
    };

    await vi.advanceTimersByTimeAsync(59_000);
    expect(candles).toHaveLength(59);
    expect(candles.every((candle) => candle.final === false)).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(candles.at(-1)).toMatchObject({
      time: history.at(-1)?.time,
      final: true
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(candles.at(-1)).toMatchObject({
      time: (history.at(-1)?.time ?? 0) + 60_000,
      final: false
    });
    socket.close();
  });
});
