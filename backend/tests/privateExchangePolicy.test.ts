import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceReadonlyTelemetryTransport, BybitReadonlyTelemetryTransport } from "../src/arbitrage/telemetry/transport.js";
import { createTradingResumeAuthorization } from "../src/identity/tradingResumePolicy.js";
import { resolveRuntimeProfile } from "../src/runtimeProfile.js";
import { buildEmergencyAdapters, buildEngineAdapter } from "../src/trading/engineAdapters.js";
import { BinanceSignedClient } from "../src/trading/exchange/binanceClient.js";
import { BybitV5Client } from "../src/trading/exchange/bybitClient.js";
import { subscribeBinanceOrders, subscribeBybitOrders } from "../src/trading/exchange/privateOrderStreams.js";
import type { BotConfig } from "../src/trading/types.js";
import { signedRequestAuthorizerForTests } from "./support/signedRequestAuthorizer.js";

const paperOnly = resolveRuntimeProfile({ RUNTIME_PROFILE: "public-http-paper" } as NodeJS.ProcessEnv);
const keys = { apiKey: "api-key-for-test", apiSecret: "api-secret-for-test" };
const callbacks = { onSnapshot: vi.fn(), onConnection: vi.fn() };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("paper-only private exchange boundary", () => {
  it("blocks signed REST transports before fetch", async () => {
    const binanceFetch = vi.fn();
    vi.stubGlobal("fetch", binanceFetch);
    await expect(new BinanceSignedClient(keys, "futures", signedRequestAuthorizerForTests(), { runtimePolicy: paperOnly }).request("GET", "/fapi/v2/account"))
      .rejects.toMatchObject({ code: "PAPER_ONLY_MODE" });
    expect(binanceFetch).not.toHaveBeenCalled();

    const bybitFetch = vi.fn();
    const bybit = new BybitV5Client(keys, "futures", signedRequestAuthorizerForTests(), { fetch: bybitFetch as never, runtimePolicy: paperOnly });
    await expect(bybit.request("GET", "/v5/account/wallet-balance"))
      .rejects.toMatchObject({ code: "PAPER_ONLY_MODE" });
    expect(bybitFetch).not.toHaveBeenCalled();
  });

  it("blocks private WebSocket subscriptions before listen-key fetch or socket construction", async () => {
    const fetcher = vi.fn();
    const createSocket = vi.fn();
    const dependencies = { fetch: fetcher as never, createSocket: createSocket as never, runtimePolicy: paperOnly };
    const controller = new AbortController();
    const context = { authorizer: signedRequestAuthorizerForTests(), signal: controller.signal };

    await expect(subscribeBinanceOrders(keys, callbacks, context, dependencies)).rejects.toMatchObject({ code: "PAPER_ONLY_MODE" });
    await expect(subscribeBybitOrders(keys, callbacks, context, dependencies)).rejects.toMatchObject({ code: "PAPER_ONLY_MODE" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(createSocket).not.toHaveBeenCalled();
  });

  it("blocks signed telemetry before fetch", async () => {
    const fetcher = vi.fn();
    const signal = new AbortController().signal;
    const binance = new BinanceReadonlyTelemetryTransport(keys, {
      signedRequestAuthorizer: signedRequestAuthorizerForTests(),
      fetch: fetcher as never,
      runtimePolicy: paperOnly
    });
    const bybit = new BybitReadonlyTelemetryTransport(keys, {
      signedRequestAuthorizer: signedRequestAuthorizerForTests(),
      fetch: fetcher as never,
      runtimePolicy: paperOnly
    });

    await expect(binance.read("spot", "/api/v3/account/commission", {}, signal)).rejects.toMatchObject({ code: "PAPER_ONLY_MODE" });
    await expect(bybit.read("/v5/account/fee-rate", {}, signal)).rejects.toMatchObject({ code: "PAPER_ONLY_MODE" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("blocks private adapter construction and persisted live resume without reading the store", async () => {
    expect(() => buildEngineAdapter(liveBot(), () => 1, paperOnly)).toThrowError(expect.objectContaining({ code: "PAPER_ONLY_MODE" }));
    expect(buildEmergencyAdapters("owner", paperOnly)).toEqual([]);

    const authorize = createTradingResumeAuthorization({ mode: "legacy", async close() {} }, paperOnly);
    expect(await authorize(liveBot())).toBe(false);
    expect(await authorize({ ...liveBot(), exchange: "paper", accountId: "paper:live-test" })).toBe(true);
  });
});

function liveBot(): BotConfig {
  return {
    id: "live-test",
    ownerUserId: "owner",
    accountId: "account",
    name: "Live test",
    strategyName: "test",
    ir: { name: "test", inputs: [], body: [] },
    symbol: "BTCUSDT",
    timeframe: "1m",
    exchange: "binance",
    market: "futures",
    sizeMode: "quote",
    sizeValue: 100,
    leverage: 1,
    notifyMarkers: false,
    maxPositionQuote: 1_000,
    maxOrderQuote: 100,
    maxDailyLossQuote: 50,
    maxOpenOrders: 2,
    status: "running",
    createdAt: 1,
    updatedAt: 1
  };
}
