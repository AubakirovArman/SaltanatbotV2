import type { Page } from "@playwright/test";
import { bootstrapBrowserPerformanceProbe, type BrowserPerformanceSummary } from "../../frontend/src/performance/browserProbe";

export interface SoakCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
}

export interface SoakSocketChannelSnapshot {
  created: number;
  active: number;
  maxActive: number;
  closed: number;
  messages: number;
  snapshots: number;
  candles: number;
}

export interface SoakRuntimeSnapshot {
  schemaVersion: 1;
  paused: boolean;
  elapsedMs: number;
  channels: Record<"stream" | "quotes" | "other", SoakSocketChannelSnapshot>;
}

export interface SoakBrowserSnapshot {
  probe?: BrowserPerformanceSummary;
  runtime: SoakRuntimeSnapshot;
}

interface InstallSoakEnvironmentOptions {
  history?: SoakCandle[];
  tickIntervalMs?: number;
  heartbeatIntervalMs?: number;
}

export const SOAK_HISTORY_SIZE = 12_000;

export function createSoakHistory(count = SOAK_HISTORY_SIZE): SoakCandle[] {
  const start = 1_710_000_000_000;
  return Array.from({ length: count }, (_, index) => {
    const open = 100 + index * 0.002 + Math.sin(index * 0.07) * 0.3;
    const close = open + Math.sin(index * 0.19) * 0.18;
    return {
      time: start + index * 60_000,
      open,
      high: Math.max(open, close) + 0.24,
      low: Math.min(open, close) - 0.24,
      close,
      volume: 100 + (index % 97),
      source: "synthetic-soak-history"
    };
  });
}

export async function installSoakEnvironment(page: Page, options: InstallSoakEnvironmentOptions = {}): Promise<SoakCandle[]> {
  const history = options.history ?? createSoakHistory();
  const tickIntervalMs = Math.max(25, options.tickIntervalMs ?? 100);
  await page.addInitScript(bootstrapBrowserPerformanceProbe, {
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 250,
    maxMetricNames: 96,
    maxRenderScopes: 48
  });
  await page.addInitScript(bootstrapSoakRuntime, { history, tickIntervalMs });

  await page.route("**/api/catalog", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        instruments: [instrument("BTCUSDT", "Bitcoin / Tether", 100), instrument("ETHUSDT", "Ethereum / Tether", 80), instrument("SOLUSDT", "Solana / Tether", 60), instrument("BNBUSDT", "BNB / Tether", 40)],
        timeframes: ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1M"],
        chartTypes: ["candles", "hollow", "heikin", "bars", "line", "step", "area", "baseline", "renko", "linebreak", "kagi", "pnf"]
      })
    })
  );
  await page.route("**/api/candles?**", (route) => {
    const symbol = new URL(route.request().url()).searchParams.get("symbol") ?? "BTCUSDT";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        instrument: instrument(symbol, symbol, history.at(-1)?.close ?? 100),
        candles: history,
        provider: "synthetic-soak",
        hasMore: false
      })
    });
  });
  await page.route("**/api/sparklines?**", (route) => {
    const url = new URL(route.request().url());
    const symbols = (url.searchParams.get("symbols") ?? "BTCUSDT").split(",").filter(Boolean);
    const timeframe = url.searchParams.get("timeframe") ?? "1m";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        timeframe,
        series: Object.fromEntries(symbols.map((symbol, index) => [symbol, { last: 100 + index, changePct: 0.25, points: [99 + index, 100 + index] }]))
      })
    });
  });
  return history;
}

export async function readSoakBrowserSnapshot(page: Page): Promise<SoakBrowserSnapshot> {
  return page.evaluate(() => {
    const runtime = (window as Window & { __SBV2_SOAK_RUNTIME__?: { snapshot(): SoakRuntimeSnapshot } }).__SBV2_SOAK_RUNTIME__;
    if (!runtime) throw new Error("Synthetic soak runtime is not installed");
    return {
      probe: window.__SBV2_BROWSER_PERF_PROBE__?.read(),
      runtime: runtime.snapshot()
    };
  });
}

export async function pauseSoakStream(page: Page): Promise<void> {
  await page.evaluate(() => {
    const runtime = (window as Window & { __SBV2_SOAK_RUNTIME__?: { pause(): void } }).__SBV2_SOAK_RUNTIME__;
    runtime?.pause();
  });
}

export async function resumeSoakStream(page: Page): Promise<void> {
  await page.evaluate(() => {
    const runtime = (window as Window & { __SBV2_SOAK_RUNTIME__?: { resume(): void } }).__SBV2_SOAK_RUNTIME__;
    runtime?.resume();
  });
}

export async function resetSoakProbe(page: Page): Promise<void> {
  await page.evaluate(() => window.__SBV2_BROWSER_PERF_PROBE__?.reset());
}

function instrument(symbol: string, displayName: string, basePrice: number) {
  return {
    symbol,
    displayName,
    assetClass: "crypto",
    exchange: "Synthetic",
    currency: "USDT",
    provider: "synthetic",
    basePrice,
    decimals: 2
  };
}

export function bootstrapSoakRuntime(input: { history: SoakCandle[]; tickIntervalMs: number }): void {
  type Channel = "stream" | "quotes" | "other";
  type MutableChannel = SoakSocketChannelSnapshot;
  type Runtime = {
    paused: boolean;
    startedAt: number;
    channels: Record<Channel, MutableChannel>;
    sockets: Set<SoakWebSocket>;
    snapshot(): SoakRuntimeSnapshot;
    pause(): void;
    resume(): void;
    stop(): void;
  };
  type SoakWindow = Window & {
    __SBV2_SOAK_RUNTIME__?: Runtime;
  };

  const target = window as SoakWindow;
  target.__SBV2_SOAK_RUNTIME__?.stop();
  const freshChannel = (): MutableChannel => ({ created: 0, active: 0, maxActive: 0, closed: 0, messages: 0, snapshots: 0, candles: 0 });
  const runtime: Runtime = {
    paused: false,
    startedAt: performance.now(),
    channels: { stream: freshChannel(), quotes: freshChannel(), other: freshChannel() },
    sockets: new Set(),
    snapshot() {
      return {
        schemaVersion: 1,
        paused: runtime.paused,
        elapsedMs: performance.now() - runtime.startedAt,
        channels: {
          stream: { ...runtime.channels.stream },
          quotes: { ...runtime.channels.quotes },
          other: { ...runtime.channels.other }
        }
      };
    },
    pause() {
      runtime.paused = true;
    },
    resume() {
      runtime.paused = false;
    },
    stop() {
      runtime.paused = true;
      for (const socket of [...runtime.sockets]) socket.close(1000, "soak stopped");
      runtime.sockets.clear();
    }
  };

  const channelFor = (url: string): Channel => {
    const pathname = new URL(url, location.href).pathname;
    if (pathname === "/stream") return "stream";
    if (pathname === "/quotes") return "quotes";
    return "other";
  };
  const recordMessage = (channel: Channel, type: "snapshot" | "candle" | "quote") => {
    const counters = runtime.channels[channel];
    counters.messages += 1;
    if (type === "snapshot") counters.snapshots += 1;
    if (type === "candle") counters.candles += 1;
    target.__SBV2_BROWSER_PERF_PROBE__?.recordMetric(`socket.${channel}.messages`, 1);
  };

  class SoakWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readonly url: string;
    readonly channel: Channel;
    binaryType: BinaryType = "blob";
    bufferedAmount = 0;
    extensions = "";
    protocol = "";
    readyState = SoakWebSocket.CONNECTING;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    private timer?: number;
    private sequence = 0;

    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      this.url = String(url);
      this.channel = channelFor(this.url);
      this.protocol = typeof protocols === "string" ? protocols : (protocols?.[0] ?? "");
      const counters = runtime.channels[this.channel];
      counters.created += 1;
      counters.active += 1;
      counters.maxActive = Math.max(counters.maxActive, counters.active);
      runtime.sockets.add(this);
      window.setTimeout(() => this.open(), 0);
    }

    send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {}

    close(code = 1000, reason = ""): void {
      if (this.readyState >= SoakWebSocket.CLOSING) return;
      this.readyState = SoakWebSocket.CLOSING;
      if (this.timer !== undefined) window.clearInterval(this.timer);
      this.readyState = SoakWebSocket.CLOSED;
      runtime.sockets.delete(this);
      const counters = runtime.channels[this.channel];
      counters.active = Math.max(0, counters.active - 1);
      counters.closed += 1;
      const event = new CloseEvent("close", { code, reason, wasClean: code === 1000 });
      this.onclose?.(event);
      this.dispatchEvent(event);
    }

    private open(): void {
      if (this.readyState !== SoakWebSocket.CONNECTING) return;
      this.readyState = SoakWebSocket.OPEN;
      const event = new Event("open");
      this.onopen?.(event);
      this.dispatchEvent(event);
      if (this.channel === "stream") this.startMarketStream();
      else if (this.channel === "quotes") this.startQuoteStream();
    }

    private startMarketStream(): void {
      const parsed = new URL(this.url, location.href);
      const symbol = parsed.searchParams.get("symbol") ?? "BTCUSDT";
      const timeframe = parsed.searchParams.get("timeframe") ?? "1m";
      this.emit({ type: "snapshot", symbol, timeframe, candles: input.history, provider: "synthetic-soak", ts: Date.now() }, "snapshot");
      this.timer = window.setInterval(() => {
        if (runtime.paused || this.readyState !== SoakWebSocket.OPEN) return;
        this.sequence += 1;
        const last = input.history[input.history.length - 1];
        const ticksPerCandle = Math.max(1, Math.round(60_000 / input.tickIntervalMs));
        const slot = Math.floor((this.sequence - 1) / ticksPerCandle);
        const final = this.sequence % ticksPerCandle === 0;
        const open = last.close + slot * 0.01;
        const close = open + Math.sin(this.sequence * 0.17) * 0.35;
        this.emit(
          {
            type: "candle",
            symbol,
            timeframe,
            candle: {
              time: last.time + slot * 60_000,
              open,
              high: Math.max(open, close) + 0.2,
              low: Math.min(open, close) - 0.2,
              close,
              volume: 200 + (this.sequence % 100),
              final,
              source: `synthetic-soak:${symbol}:${this.sequence}`
            },
            provider: "synthetic-soak",
            ts: Date.now()
          },
          "candle"
        );
      }, input.tickIntervalMs);
    }

    private startQuoteStream(): void {
      const parsed = new URL(this.url, location.href);
      const timeframe = parsed.searchParams.get("timeframe") ?? "1m";
      const symbols = (parsed.searchParams.get("symbols") ?? "BTCUSDT").split(",").filter(Boolean);
      this.emit(
        {
          type: "quotes_snapshot",
          timeframe,
          provider: "synthetic-soak",
          series: Object.fromEntries(symbols.map((symbol, index) => [symbol, { last: 100 + index, changePct: 0.25, points: [99 + index, 100 + index] }])),
          ts: Date.now()
        },
        "snapshot"
      );
      this.timer = window.setInterval(
        () => {
          if (runtime.paused || this.readyState !== SoakWebSocket.OPEN || symbols.length === 0) return;
          this.sequence += 1;
          const symbol = symbols[this.sequence % symbols.length];
          const last = 100 + (this.sequence % 50) * 0.01;
          this.emit(
            {
              type: "quote",
              symbol,
              timeframe,
              provider: "synthetic-soak",
              series: { last, changePct: 0.25, points: [last - 0.5, last] },
              ts: Date.now()
            },
            "quote"
          );
        },
        Math.max(250, input.tickIntervalMs * 5)
      );
    }

    private emit(message: unknown, type: "snapshot" | "candle" | "quote"): void {
      recordMessage(this.channel, type);
      const event = new MessageEvent<string>("message", { data: JSON.stringify(message) });
      this.onmessage?.(event);
      this.dispatchEvent(event);
    }
  }

  target.__SBV2_SOAK_RUNTIME__ = runtime;
  window.WebSocket = SoakWebSocket as unknown as typeof WebSocket;
}
