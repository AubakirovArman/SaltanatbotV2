// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCandles, getSparklines, createQuoteSocket } from "../src/api/marketClient";
import { AuthContext, type AuthContextValue } from "../src/auth/AuthRoot";
import type { CompareOverlayConfig } from "../src/chart/types";
import { useCompareSeries } from "../src/hooks/useCompareSeries";
import { useLivePositions } from "../src/hooks/useLivePositions";
import { useSparklines } from "../src/hooks/useSparklines";
import { createCandleSeriesBuffer, mergeCandleSeriesBuffer } from "../src/market/candleSeries";
import { checkAuth, getLive, getToken, listBots, type TradingBot } from "../src/trading/tradeClient";
import type { Candle } from "../src/types";
import { useSessionLiquidity } from "../src/components/chartCanvas/SessionLiquidityLayer";

vi.mock("../src/api/marketClient", () => ({
  createQuoteSocket: vi.fn(),
  getCandles: vi.fn(),
  getSparklines: vi.fn(),
  parseQuoteStreamMessage: vi.fn()
}));

vi.mock("../src/trading/tradeClient", () => ({
  checkAuth: vi.fn(),
  getLive: vi.fn(),
  getToken: vi.fn(),
  listBots: vi.fn()
}));

const createQuoteSocketMock = vi.mocked(createQuoteSocket);
const getCandlesMock = vi.mocked(getCandles);
const getSparklinesMock = vi.mocked(getSparklines);
const checkAuthMock = vi.mocked(checkAuth);
const getLiveMock = vi.mocked(getLive);
const getTokenMock = vi.mocked(getToken);
const listBotsMock = vi.mocked(listBots);

const auth: AuthContextValue = {
  authRequired: true,
  openAccount: vi.fn(),
  refreshSession: vi.fn(),
  tradingRoleAssignmentsEnabled: true,
  tradingAvailable: true
};

const overlay: CompareOverlayConfig = {
  id: "compare-btc",
  symbol: "BTCUSDT",
  timeframe: "1m",
  chartType: "line",
  color: "#ffffff",
  upColor: "#00ff00",
  downColor: "#ff0000"
};
const overlays = [overlay];

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  getSparklinesMock.mockResolvedValue({
    timeframe: "1m",
    series: { BTCUSDT: { last: 101, changePct: 1, points: [100, 101] } }
  });
  getCandlesMock.mockResolvedValue({
    candles: [{ time: 1, open: 100, high: 102, low: 99, close: 101, volume: 10, source: "test" }],
    provider: "test",
    hasMore: false
  });
  checkAuthMock.mockResolvedValue({
    ok: true,
    demo: true,
    liveTradingEnabled: false,
    runtimeProfile: "public-http-paper"
  });
  getTokenMock.mockReturnValue("");
  listBotsMock.mockResolvedValue([paperBot()]);
  getLiveMock.mockResolvedValue({
    price: 101,
    position: { symbol: "BTCUSDT", side: "long", qty: 1, entryPrice: 100, leverage: 1, openedAt: 1 }
  });
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  window.__SBV2_BROWSER_PERF_PROBE__ = undefined;
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("lifecycle-enabled data hooks", () => {
  it("closes the quote socket, cancels fallback work and clears sparklines when disabled", async () => {
    const socket = fakeSocket();
    createQuoteSocketMock.mockReturnValue(socket as unknown as WebSocket);
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => root.render(<SparklinesHarness enabled />));
    await flush();
    expect(getSparklinesMock).toHaveBeenCalledTimes(1);
    expect(createQuoteSocketMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("1");

    await act(async () => socket.onclose?.({} as CloseEvent));
    await act(async () => root.render(<SparklinesHarness enabled={false} />));
    expect(socket.close).toHaveBeenCalled();
    expect(container.textContent).toBe("0");

    await advance(60_000);
    expect(getSparklinesMock).toHaveBeenCalledTimes(1);
    expect(createQuoteSocketMock).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("stops compare refresh and removes stale compare state when disabled", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => root.render(<CompareHarness enabled />));
    await flush();
    expect(getCandlesMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("1:0:0");

    await act(async () => root.render(<CompareHarness enabled={false} />));
    expect(container.textContent).toBe("0:0:0");
    await advance(30_000);
    expect(getCandlesMock).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("stops live-position polling and clears positions when disabled", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => root.render(<LivePositionsHarness enabled />));
    await flush();
    expect(listBotsMock).toHaveBeenCalledTimes(1);
    expect(getLiveMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("1");

    await act(async () => root.render(<LivePositionsHarness enabled={false} />));
    expect(container.textContent).toBe("0");
    await advance(10_000);
    expect(listBotsMock).toHaveBeenCalledTimes(1);
    expect(getLiveMock).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("does not continue a live-position poll after it is disabled during authentication", async () => {
    let resolveAuth!: (value: Awaited<ReturnType<typeof checkAuth>>) => void;
    checkAuthMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAuth = resolve;
        })
    );
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => root.render(<LivePositionsHarness enabled />));
    expect(checkAuthMock).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<LivePositionsHarness enabled={false} />));
    await act(async () => {
      resolveAuth({
        ok: true,
        demo: true,
        liveTradingEnabled: false,
        runtimeProfile: "public-http-paper"
      });
      await Promise.resolve();
    });

    expect(listBotsMock).not.toHaveBeenCalled();
    expect(getLiveMock).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("does not load daily chart analysis while hidden and aborts a pending load when hidden", async () => {
    let requestSignal: AbortSignal | undefined;
    getCandlesMock.mockImplementationOnce((_symbol, _timeframe, _limit, _endTime, _exchange, options) => {
      requestSignal = options?.signal;
      return new Promise(() => undefined);
    });
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => root.render(<SessionLiquidityHarness operational={false} />));
    expect(getCandlesMock).not.toHaveBeenCalled();

    await act(async () => root.render(<SessionLiquidityHarness operational />));
    expect(getCandlesMock).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(false);

    await act(async () => root.render(<SessionLiquidityHarness operational={false} />));
    expect(requestSignal?.aborted).toBe(true);
    await act(async () => root.unmount());
  });

  it("does not rebuild structural sessions for a dense-to-provisional tail update", async () => {
    const recordMetric = vi.fn();
    window.__SBV2_BROWSER_PERF_PROBE__ = {
      recordMetric,
      recordRender: vi.fn(),
      read: vi.fn(),
      reset: vi.fn(),
      stop: vi.fn()
    } as unknown as NonNullable<Window["__SBV2_BROWSER_PERF_PROBE__"]>;
    const dense = createCandleSeriesBuffer([candle(Date.UTC(2026, 6, 15, 13, 30), 100), candle(Date.UTC(2026, 6, 15, 14, 0), 103), candle(Date.UTC(2026, 6, 15, 14, 30), 107)], 12_000);
    const provisional = mergeCandleSeriesBuffer(dense, { ...dense.candles.at(-1)!, high: 114, close: 112, final: false }, 12_000);
    const finalized = mergeCandleSeriesBuffer(provisional, { ...provisional.candles.at(-1)!, high: 115, close: 113, final: true }, 12_000);
    const nextBar = mergeCandleSeriesBuffer(finalized, candle(Date.UTC(2026, 6, 15, 15, 0), 114), 12_000);
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => root.render(<SessionLiquidityCandlesHarness candles={dense.candles} />));
    expect(metricCount(recordMetric, "chart.marketSessions.structuralMs")).toBe(1);
    expect(metricCount(recordMetric, "chart.marketSessions.ms")).toBe(1);

    await act(async () => root.render(<SessionLiquidityCandlesHarness candles={provisional.candles} />));
    expect(metricCount(recordMetric, "chart.marketSessions.structuralMs")).toBe(1);
    expect(metricCount(recordMetric, "chart.marketSessions.ms")).toBe(2);

    await act(async () => root.render(<SessionLiquidityCandlesHarness candles={finalized.candles} />));
    expect(metricCount(recordMetric, "chart.marketSessions.structuralMs")).toBe(1);
    expect(metricCount(recordMetric, "chart.marketSessions.ms")).toBe(3);

    await act(async () => root.render(<SessionLiquidityCandlesHarness candles={nextBar.candles} />));
    expect(metricCount(recordMetric, "chart.marketSessions.structuralMs")).toBe(2);
    expect(metricCount(recordMetric, "chart.marketSessions.ms")).toBe(4);
    await act(async () => root.unmount());
  });

  it("does not recreate market-session ranges from the tail on unsupported timeframes", async () => {
    const candles = [candle(Date.UTC(2026, 6, 15, 13, 30), 100), candle(Date.UTC(2026, 6, 15, 15, 30), 103)];
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => root.render(<SessionLiquidityCandlesHarness candles={candles} timeframe="2h" />));
    expect(container.textContent).toBe("0");
    await act(async () => root.unmount());
  });
});

function SparklinesHarness({ enabled }: { enabled: boolean }) {
  const value = useSparklines(["BTCUSDT"], "1m", "binance", { enabled });
  return <span>{Object.keys(value).length}</span>;
}

function CompareHarness({ enabled }: { enabled: boolean }) {
  const value = useCompareSeries(overlays, "binance", { enabled });
  return (
    <span>
      {Object.keys(value.series).length}:{Object.keys(value.loading).filter((key) => value.loading[key]).length}:{Object.values(value.errors).filter(Boolean).length}
    </span>
  );
}

function LivePositionsHarness({ enabled }: { enabled: boolean }) {
  return (
    <AuthContext.Provider value={auth}>
      <LivePositionsValue enabled={enabled} />
    </AuthContext.Provider>
  );
}

function LivePositionsValue({ enabled }: { enabled: boolean }) {
  const value = useLivePositions("BTCUSDT", { enabled });
  return <span>{value.length}</span>;
}

function SessionLiquidityHarness({ operational }: { operational: boolean }) {
  useSessionLiquidity([{ time: 1, open: 100, high: 102, low: 99, close: 101, volume: 10, source: "test" }], "BTCUSDT", "1m", "binance", undefined, "spot", "last", operational);
  return null;
}

function SessionLiquidityCandlesHarness({ candles, timeframe = "1m" }: { candles: Candle[]; timeframe?: "1m" | "2h" }) {
  const state = useSessionLiquidity(candles, "BTCUSDT", timeframe, "binance");
  return <span>{state.marketSessions.length}</span>;
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

function paperBot(): TradingBot {
  return {
    id: "paper-bot",
    name: "Paper bot",
    strategyName: "Strategy",
    ir: {} as TradingBot["ir"],
    symbol: "BTCUSDT",
    timeframe: "1m",
    exchange: "paper",
    market: "futures",
    sizeMode: "quote",
    sizeValue: 100,
    leverage: 1,
    notifyMarkers: false,
    status: "running",
    createdAt: 1,
    updatedAt: 1
  };
}

function candle(time: number, close: number): Candle {
  return { time, open: close - 1, high: close + 2, low: close - 2, close, volume: 10, source: "test" };
}

function metricCount(recordMetric: ReturnType<typeof vi.fn>, name: string) {
  return recordMetric.mock.calls.filter(([metric]) => metric === name).length;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(milliseconds: number) {
  await act(async () => {
    vi.advanceTimersByTime(milliseconds);
    await Promise.resolve();
    await Promise.resolve();
  });
}
