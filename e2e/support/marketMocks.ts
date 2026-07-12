import type { Page } from "@playwright/test";

export function mockCandles() {
  return [
    { time: 1_710_000_000_000, open: 100, high: 102, low: 99, close: 101, volume: 10, source: "mock" },
    { time: 1_710_000_060_000, open: 101, high: 103, low: 100, close: 101.5, volume: 12, source: "mock" }
  ];
}

export function mockChartCandles() {
  return Array.from({ length: 180 }, (_, index) => ({
    time: 1_710_000_000_000 + index * 60_000,
    open: 100 + index * 0.1,
    high: 101 + index * 0.1,
    low: 99 + index * 0.1,
    close: 100.5 + index * 0.1,
    volume: 10 + index,
    source: "mock"
  }));
}

export async function mockCandleHistory(page: Page, candles: ReturnType<typeof mockCandles>) {
  await page.route("**/api/candles?**", (route) => {
    const symbol = new URL(route.request().url()).searchParams.get("symbol") ?? "BTCUSDT";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        instrument: {
          symbol,
          displayName: symbol,
          assetClass: "crypto",
          exchange: "Mock",
          currency: "USDT",
          provider: "synthetic",
          basePrice: candles.at(-1)?.close ?? 100,
          decimals: 2
        },
        candles,
        provider: "mock",
        hasMore: false
      })
    });
  });
}

export async function installMarketSocketMock(
  page: Page,
  mode: "reconnect" | "stable" | "unavailable",
  candles: ReturnType<typeof mockCandles>
) {
  await page.addInitScript(({ socketMode, rows }) => {
    const target = window as Window & { __marketSocketAttempts?: number };
    target.__marketSocketAttempts = 0;

    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(url: string | URL) {
        this.url = String(url);
        if (this.url.includes("/quotes?")) {
          window.setTimeout(() => {
            this.readyState = MockWebSocket.OPEN;
            this.onopen?.(new Event("open"));
            this.emit({
              type: "quotes_snapshot",
              timeframe: "1m",
              provider: "mock",
              series: { BTCUSDT: { last: 101, changePct: 1, points: [100, 101] } },
              ts: Date.now()
            });
          }, 0);
          return;
        }
        const attempt = (target.__marketSocketAttempts ?? 0) + 1;
        target.__marketSocketAttempts = attempt;
        window.setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event("open"));
          if (socketMode === "unavailable") {
            this.emit({ type: "error", message: "Market data unavailable for BTCUSDT", ts: Date.now() });
            return;
          }
          this.emit({ type: "snapshot", symbol: "BTCUSDT", timeframe: "1m", candles: rows, provider: "mock", ts: Date.now() });
          if (socketMode === "stable") return;
          if (attempt === 1) {
            window.setTimeout(() => {
              this.readyState = MockWebSocket.CLOSED;
              this.onclose?.(new CloseEvent("close"));
            }, 50);
          } else {
            window.setTimeout(() => this.emit({
              type: "candle",
              symbol: "BTCUSDT",
              timeframe: "1m",
              candle: { ...rows.at(-1), close: 102 },
              provider: "mock",
              ts: Date.now()
            }), 50);
          }
        }, 0);
      }

      close() {
        this.readyState = MockWebSocket.CLOSED;
      }

      send() {}

      private emit(message: unknown) {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
      }
    }

    window.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  }, { socketMode: mode, rows: candles });
}
