// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTradeFlowSocket } from "../src/api/marketClient";
import { TradeFootprintLayer } from "../src/components/chartCanvas/TradeFootprintLayer";
import { createCandleSeriesBuffer, mergeCandleSeriesBuffer } from "../src/market/candleSeries";
import type { Candle } from "../src/types";

vi.mock("../src/api/marketClient", () => ({
  createTradeFlowSocket: vi.fn()
}));

const createTradeFlowSocketMock = vi.mocked(createTradeFlowSocket);

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    disconnect() {}
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("TradeFootprintLayer stream lifecycle", () => {
  it("keeps one trade-flow socket while candle commits and render keys change", async () => {
    const socket = fakeSocket();
    createTradeFlowSocketMock.mockReturnValue(socket as unknown as WebSocket);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const viewportRef = { current: undefined };
    const initial = createCandleSeriesBuffer([candle(1, 100)], 12_000);
    const provisional = mergeCandleSeriesBuffer(initial, candle(1, 101), 12_000);
    const finalized = mergeCandleSeriesBuffer(provisional, candle(1, 101, true), 12_000);
    const nextBar = mergeCandleSeriesBuffer(finalized, candle(2, 102), 12_000);

    await act(async () => {
      root.render(<TradeFootprintLayer enabled symbol="BTCUSDT" exchange="binance" locale="en" timeZone="UTC" candles={initial.candles} viewportRef={viewportRef} renderKey="first" />);
    });
    expect(createTradeFlowSocketMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(<TradeFootprintLayer enabled symbol="BTCUSDT" exchange="binance" locale="en" timeZone="UTC" candles={provisional.candles} viewportRef={viewportRef} renderKey="second" />);
    });
    await act(async () => {
      root.render(<TradeFootprintLayer enabled symbol="BTCUSDT" exchange="binance" locale="en" timeZone="UTC" candles={nextBar.candles} viewportRef={viewportRef} renderKey="third" />);
    });

    expect(createTradeFlowSocketMock).toHaveBeenCalledTimes(1);
    expect(socket.close).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    expect(socket.close).toHaveBeenCalledTimes(1);
  });
});

function candle(time: number, close: number, final = false): Candle {
  return { time, open: close, high: close, low: close, close, volume: 1, final };
}

function fakeSocket() {
  return {
    readyState: WebSocket.CONNECTING,
    close: vi.fn(),
    onopen: null as WebSocket["onopen"],
    onmessage: null as WebSocket["onmessage"],
    onclose: null as WebSocket["onclose"],
    onerror: null as WebSocket["onerror"]
  };
}
