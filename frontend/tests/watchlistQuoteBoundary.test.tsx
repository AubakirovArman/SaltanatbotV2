// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQuoteSocket, getSparklines, parseQuoteStreamMessage } from "../src/api/marketClient";
import { WatchlistQuotePanel } from "../src/components/WatchlistQuotePanel";
import type { Instrument } from "../src/types";

vi.mock("../src/api/marketClient", () => ({
  createQuoteSocket: vi.fn(),
  getSparklines: vi.fn(),
  parseQuoteStreamMessage: vi.fn()
}));

const createQuoteSocketMock = vi.mocked(createQuoteSocket);
const getSparklinesMock = vi.mocked(getSparklines);
const parseQuoteStreamMessageMock = vi.mocked(parseQuoteStreamMessage);

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.clear();
  getSparklinesMock.mockResolvedValue({ timeframe: "5m", series: {} });
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  vi.useRealTimers();
  vi.clearAllMocks();
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("watchlist quote ownership boundary", () => {
  it("keeps quote renders inside the watchlist and preserves the active route and 40-symbol cap", async () => {
    const socket = fakeSocket();
    createQuoteSocketMock.mockReturnValue(socket as unknown as WebSocket);
    const instruments = Array.from({ length: 45 }, (_, index) => instrument(`SYM${index}`));
    const selectedSymbol = "SYM44";
    const onSelectSymbol = vi.fn();
    let chartSiblingRenders = 0;
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <>
          <WatchlistQuotePanel
            enabled
            locale="en"
            instruments={instruments}
            quoteInstruments={instruments}
            selectedSymbol={selectedSymbol}
            selectedAsset="all"
            timeframe="5m"
            exchange="bybit"
            marketType="perpetual"
            priceType="mark"
            onSelectSymbol={onSelectSymbol}
            onSelectAsset={vi.fn()}
            onSelectExchange={vi.fn()}
          />
          <ChartSibling onRender={() => {
            chartSiblingRenders += 1;
          }} />
        </>
      );
    });
    await flush();

    const quoteSymbols = getSparklinesMock.mock.calls[0]?.[0] ?? [];
    expect(quoteSymbols).toHaveLength(40);
    expect(quoteSymbols[0]).toBe(selectedSymbol);
    expect(getSparklinesMock).toHaveBeenCalledWith(
      quoteSymbols,
      "5m",
      32,
      "bybit",
      { marketType: "perpetual", priceType: "mark", strict: false }
    );
    expect(createQuoteSocketMock).toHaveBeenCalledWith(
      quoteSymbols,
      "5m",
      32,
      "bybit",
      { marketType: "perpetual", priceType: "mark", strict: false }
    );
    expect(chartSiblingRenders).toBe(1);

    parseQuoteStreamMessageMock.mockReturnValue({
      type: "quote",
      symbol: selectedSymbol,
      series: { last: 123.45, changePct: 2.5, points: [120, 123.45] }
    });
    await act(async () => socket.onmessage?.({ data: "quote" } as MessageEvent));

    expect(chartSiblingRenders).toBe(1);
    expect(container.textContent).toContain("123.45");

    const firstSymbolButton = container.querySelector<HTMLButtonElement>(".symbol-select");
    firstSymbolButton?.click();
    expect(onSelectSymbol).toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("does not subscribe while hidden and closes its socket when the panel becomes hidden", async () => {
    const socket = fakeSocket();
    createQuoteSocketMock.mockReturnValue(socket as unknown as WebSocket);
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => root.render(<BoundaryHarness enabled={false} />));
    await flush();
    expect(getSparklinesMock).not.toHaveBeenCalled();
    expect(createQuoteSocketMock).not.toHaveBeenCalled();

    await act(async () => root.render(<BoundaryHarness enabled />));
    await flush();
    expect(getSparklinesMock).toHaveBeenCalledTimes(1);
    expect(createQuoteSocketMock).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<BoundaryHarness enabled={false} />));
    expect(socket.close).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });
});

function BoundaryHarness({ enabled }: { enabled: boolean }) {
  const instruments = [instrument("BTCUSDT")];
  return (
    <WatchlistQuotePanel
      enabled={enabled}
      locale="en"
      instruments={instruments}
      quoteInstruments={instruments}
      selectedSymbol="BTCUSDT"
      selectedAsset="all"
      timeframe="1m"
      exchange="binance"
      marketType="spot"
      priceType="last"
      onSelectSymbol={vi.fn()}
      onSelectAsset={vi.fn()}
      onSelectExchange={vi.fn()}
    />
  );
}

function ChartSibling({ onRender }: { onRender: () => void }) {
  onRender();
  return <div data-testid="chart-sibling" />;
}

function instrument(symbol: string): Instrument {
  return {
    symbol,
    displayName: symbol,
    assetClass: "crypto",
    exchange: "Test",
    currency: "USDT",
    provider: "binance",
    basePrice: 100,
    decimals: 2
  };
}

function fakeSocket() {
  return {
    close: vi.fn(),
    onclose: null as ((event: CloseEvent) => unknown) | null,
    onerror: null as ((event: Event) => unknown) | null,
    onmessage: null as ((event: MessageEvent) => unknown) | null,
    onopen: null as ((event: Event) => unknown) | null
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}
