import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { verifyAppWsSession, verifyTradeWsRequest } from "./auth.js";
import { initializeRuntimeConfig } from "./config/runtimeConfig.js";
import { createArbitrageDepthHandler, createArbitrageHandler, createArbitrageHistoryHandler } from "./arbitrage/routes.js";
import { ArbitrageScannerService } from "./arbitrage/service.js";
import { ArbitrageStreamHub } from "./arbitrage/stream.js";
import { ArbitrageAlertService } from "./arbitrage/alerts.js";
import { ArbitrageHistoryRecorder } from "./arbitrage/history.js";
import { createTriangularArbitrageHandler } from "./arbitrage/triangularRoutes.js";
import { createTriangularDepthVerificationHandler } from "./arbitrage/triangularDepth/index.js";
import { createNativeSpreadHandler } from "./arbitrage/nativeSpreads/index.js";
import { createPairwiseEvaluationHandler } from "./arbitrage/pairwiseRoutes.js";
import { createRouteFamilyEvaluationHandler } from "./arbitrage/routeFamilyRoutes.js";
import { createOptionsParityEvaluationHandler } from "./arbitrage/optionsParityRoutes.js";
import { createNLegEvaluationHandler } from "./arbitrage/nLegRoutes.js";
import { createFundingCurveHandler, createFundingCurveUniverseHandler, FundingCurveService } from "./arbitrage/fundingCurve/index.js";
import { ResearchAlertService } from "./arbitrage/researchAlerts/index.js";
import { ContinuousRouteDiscoveryRuntime, createContinuousRouteRuntimeHandler, loadContinuousRouteConfiguration } from "./arbitrage/continuousRoutesRuntime.js";
import { ContinuousPublicFeedHub, ContinuousRouteFamilyDiscovery, createContinuousFeedHealthHandler } from "./arbitrage/upstream/publicFeeds/index.js";
import { attachBasisOpportunityLifecycle, attachContinuousRouteOpportunityLifecycle, createOpportunityLifecycleHandler, OpportunityLifecycleCoordinator } from "./arbitrage/lifecycle/index.js";
import { createVenueClockHealthHandler, VenueClockCalibrationService } from "./arbitrage/timing/index.js";
import { findInstrument, getCatalog, initCatalog } from "./market/catalog.js";
import { createInstrumentRegistryHandler, createVenueCapabilitiesHandler } from "./market/instrumentRoutes.js";
import { instrumentRegistry } from "./market/instrumentRegistry.js";
import { createNetworkIdentityPreflightHandler, createNetworkIdentityRegistryHandler } from "./market/networkIdentity/index.js";
import { timeframes } from "./market/timeframes.js";
import { OrderBookHub } from "./orderbook/hub.js";
import { createOrderBookMlResearchRouter } from "./orderbook/ml/researchRoutes.js";
import { ProviderRouter } from "./providers/router.js";
import { securityHeaders } from "./securityHeaders.js";
import { configureTrustedProxy } from "./secureTradingOrigin.js";
import { installFrontendDistribution, validateFrontendDistribution } from "./frontendDistribution.js";
import { createTradingApi } from "./trading/routes.js";
import { TradeFlowHub } from "./tradeflow/hub.js";
import type { Candle, OrderBookStreamMessage, QuoteStreamMessage, StreamMessage, Timeframe, TradeFlowStreamMessage } from "./types.js";
import { createPublicVenueRouter, publicVenueAdapters } from "./venues/index.js";
import { initializeIdentityRuntime } from "./identity/runtime.js";
import { resolveLegacyTradingOwnerUserId } from "./identity/legacyTradingOwner.js";
import { createTradingResumeAuthorization } from "./identity/tradingResumePolicy.js";
import { registerIdentityServerRoutes } from "./identity/serverRoutes.js";
import { apiErrorHandler } from "./http/apiErrorHandler.js";
import { installGracefulShutdown } from "./http/gracefulShutdown.js";
import { SingleFlightGate } from "./http/singleFlightGate.js";
import { websocketOriginAllowed } from "./http/websocketOrigin.js";
import { isPaperOnlyRuntime, runtimePolicyFromConfig } from "./runtimeProfile.js";
const runtimeConfig = initializeRuntimeConfig(process.env);
const frontendDistribution = validateFrontendDistribution(runtimeConfig.frontend.distDir);
const { port, host } = runtimeConfig.server;
const runtimePolicy = runtimePolicyFromConfig(runtimeConfig);
const identityRuntime = await initializeIdentityRuntime(process.env, runtimeConfig.auth.mode);
const legacyTradingOwnerUserId = await resolveLegacyTradingOwnerUserId(identityRuntime);
const provider = new ProviderRouter();
const marketDataGate = new SingleFlightGate(24, 128);
const app = express();
configureTrustedProxy(app, runtimeConfig.server.trustProxy);
const server = createServer(app);
const inboundWebSocketLimit = 64 * 1024;
const wss = new WebSocketServer({ noServer: true, maxPayload: inboundWebSocketLimit });
const quoteWss = new WebSocketServer({ noServer: true, maxPayload: inboundWebSocketLimit });
const orderBookWss = new WebSocketServer({ noServer: true, maxPayload: inboundWebSocketLimit });
const tradeFlowWss = new WebSocketServer({ noServer: true, maxPayload: inboundWebSocketLimit });
const arbitrageWss = new WebSocketServer({ noServer: true, maxPayload: inboundWebSocketLimit });
const orderBookHub = new OrderBookHub();
const tradeFlowHub = new TradeFlowHub();
const venueClockCalibration = new VenueClockCalibrationService();
const arbitrageAlerts = new ArbitrageAlertService({ clockCalibration: venueClockCalibration });
const researchAlerts = new ResearchAlertService();
const trading = createTradingApi(provider, arbitrageAlerts, { researchAlerts, legacyOwnerUserId: legacyTradingOwnerUserId, telegramControlEnabled: identityRuntime.mode === "legacy", runtimePolicy });
identityRuntime.service?.setTradingAccessChangeHandler((ownerUserId, action) => action === "restore" ? trading.restoreOwnerAccess(ownerUserId) : trading.revokeOwnerAccess(ownerUserId));
identityRuntime.service?.setSessionRevocationHandler(({ userId, sessionIdHash, reason }) => sessionIdHash ? trading.disconnectSession(sessionIdHash, `Session ${reason.replaceAll("_", " ")}`) : trading.disconnectOwner(userId, `Session ${reason.replaceAll("_", " ")}`));
const arbitrageScanner = new ArbitrageScannerService({ clockCalibration: venueClockCalibration });
const arbitrageStream = new ArbitrageStreamHub(arbitrageWss, arbitrageScanner, 30_000, venueClockCalibration);
const opportunityLifecycle = new OpportunityLifecycleCoordinator();
const detachOpportunityLifecycle = attachBasisOpportunityLifecycle(arbitrageStream, opportunityLifecycle);
const continuousPublicFeeds = new ContinuousPublicFeedHub();
const continuousRouteDiscovery = new ContinuousRouteFamilyDiscovery(continuousPublicFeeds, { clockCalibration: venueClockCalibration });
const continuousRouteSetup = continuousRouteConfigurationFromEnvironment();
const continuousRouteRuntime = new ContinuousRouteDiscoveryRuntime({
  configuration: continuousRouteSetup.configuration,
  registry: instrumentRegistry,
  discovery: continuousRouteDiscovery,
  ...(continuousRouteSetup.error ? { configurationError: continuousRouteSetup.error } : {})
});
const detachContinuousRouteLifecycle = attachContinuousRouteOpportunityLifecycle(continuousRouteDiscovery, opportunityLifecycle);
const arbitrageHistory = new ArbitrageHistoryRecorder();
arbitrageStream.subscribe((scan) => arbitrageHistory.record(scan));
arbitrageAlerts.attach(arbitrageStream);

// CORS: same-origin needs nothing (the SPA is served by this app). Allow an
// explicit allowlist for cross-origin dev/proxy setups via ALLOWED_ORIGINS.
const allowedOrigins = new Set(runtimeConfig.server.allowedOrigins);
const corsOptions: cors.CorsOptions = {
  origin(origin, callback) {
    // Non-browser / same-origin requests send no Origin header — always allow.
    // For a disallowed cross-origin request, deny CORS headers (callback(null, false))
    // WITHOUT throwing: throwing would turn every response — including the app's own
    // static assets — into a 500. Same-origin requests don't need CORS headers, so the
    // SPA keeps working while foreign origins simply can't read API responses.
    callback(null, !origin || allowedOrigins.has(origin));
  }
};

const exchangeParam = z.enum(["binance", "bybit"]).default("binance");
const marketTypeParam = z.enum(["spot", "linear", "inverse"]).default("spot");
const priceTypeParam = z.enum(["last", "mark", "index"]).default("last");

const candleQuery = z.object({
  symbol: z.string().min(1),
  timeframe: z.enum(timeframes as [Timeframe, ...Timeframe[]]).default("1m"),
  limit: z.coerce.number().int().min(10).max(1000).default(320),
  endTime: z.coerce.number().int().positive().optional(),
  startTime: z.coerce.number().int().positive().optional(),
  exchange: exchangeParam,
  marketType: marketTypeParam,
  priceType: priceTypeParam
});
const sparklineQuery = z.object({
  symbols: z.string().min(1),
  timeframe: z.enum(timeframes as [Timeframe, ...Timeframe[]]).default("1h"),
  points: z.coerce.number().int().min(2).max(120).default(32),
  exchange: exchangeParam,
  marketType: marketTypeParam,
  priceType: priceTypeParam,
  strict: z.enum(["0", "1"]).default("0").transform((value) => value === "1")
});
const orderBookQuery = z.object({
  symbol: z.string().min(1),
  exchange: exchangeParam
});

app.use(cors(corsOptions));
app.disable("x-powered-by");
app.use(securityHeaders);

registerIdentityServerRoutes(app, identityRuntime);
app.use("/api", express.json({ limit: "1mb" }));
app.use("/api/trade", trading.router);
app.use("/api/orderbook-ml/research", createOrderBookMlResearchRouter());

app.get("/api/catalog", (_request, response) => {
  response.json(getCatalog());
});
app.get("/api/instruments", createInstrumentRegistryHandler());
app.get("/api/venues", createVenueCapabilitiesHandler());
app.get("/api/network-identity/registry", createNetworkIdentityRegistryHandler());
app.post("/api/network-identity/preflight", createNetworkIdentityPreflightHandler());
app.use("/api/market-data", createPublicVenueRouter(publicVenueAdapters));

app.get("/api/arbitrage", createArbitrageHandler(arbitrageScanner));
app.get("/api/arbitrage/depth", createArbitrageDepthHandler());
app.get("/api/arbitrage/history", createArbitrageHistoryHandler());
app.get("/api/arbitrage/triangular", createTriangularArbitrageHandler());
app.post("/api/arbitrage/triangular/verify-depth", createTriangularDepthVerificationHandler());
app.get("/api/arbitrage/native-spreads", createNativeSpreadHandler());
app.post("/api/arbitrage/pairwise/evaluate", createPairwiseEvaluationHandler());
app.post("/api/arbitrage/route-families/evaluate", createRouteFamilyEvaluationHandler());
app.post("/api/arbitrage/options-parity/evaluate", createOptionsParityEvaluationHandler());
app.post("/api/arbitrage/n-leg/evaluate", createNLegEvaluationHandler());
app.post("/api/arbitrage/funding-curve", createFundingCurveHandler(new FundingCurveService(publicVenueAdapters, { clockCalibration: venueClockCalibration })));
app.get("/api/arbitrage/funding-curve/universe", createFundingCurveUniverseHandler());
app.get("/api/arbitrage/route-families/live", createContinuousRouteRuntimeHandler(continuousRouteRuntime));
app.get("/api/arbitrage/continuous-feed-health", createContinuousFeedHealthHandler(continuousPublicFeeds));
app.get("/api/arbitrage/clock-health", createVenueClockHealthHandler(venueClockCalibration));
app.get("/api/arbitrage/lifecycle", createOpportunityLifecycleHandler(opportunityLifecycle));

app.get("/api/candles", async (request, response) => {
  const parsed = candleQuery.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const instrument = findInstrument(parsed.data.symbol);
  if (!instrument) {
    response.status(404).json({ error: `Unknown symbol: ${parsed.data.symbol}` });
    return;
  }

  let candles: Candle[];
  try {
    candles = await marketDataGate.run(JSON.stringify(["candles", instrument.symbol, parsed.data]), () =>
      provider.getCandles(
        instrument,
        parsed.data.timeframe,
        {
          limit: parsed.data.limit,
          endTime: parsed.data.endTime,
          startTime: parsed.data.startTime
        },
        {
          exchange: parsed.data.exchange,
          marketType: parsed.data.marketType,
          priceType: parsed.data.priceType
        }
      ));
  } catch (error) {
    response.status(503).json({
      error: error instanceof Error ? error.message : "Market data unavailable",
      unavailable: true
    });
    return;
  }
  response.json({
    instrument,
    candles,
    provider: candles.at(-1)?.source ?? provider.name,
    // Older-history paging hint: a full page implies more bars likely exist.
    hasMore: candles.length >= parsed.data.limit
  });
});

app.get("/api/sparklines", async (request, response) => {
  const parsed = sparklineQuery.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const symbols = parsed.data.symbols
    .split(",")
    .map((symbol) => symbol.trim())
    .filter(Boolean)
    .slice(0, 40);

  const entries = await Promise.all(
    symbols.map(async (symbol) => {
      const instrument = findInstrument(symbol);
      if (!instrument) return [symbol, null] as const;
      try {
        const candles = await marketDataGate.run(JSON.stringify(["spark", instrument.symbol, parsed.data]), () =>
          provider.getCandles(instrument, parsed.data.timeframe, { limit: parsed.data.points }, parsed.data));
        const closes = candles.map((candle) => candle.close);
        const first = closes[0];
        const last = closes.at(-1);
        const changePct = first && last ? ((last - first) / first) * 100 : 0;
        return [symbol, { last: last ?? null, changePct, points: closes }] as const;
      } catch {
        return [symbol, null] as const;
      }
    })
  );

  response.json({ timeframe: parsed.data.timeframe, series: Object.fromEntries(entries) });
});

server.on("upgrade", (request, socket, head) => {
  if (!websocketOriginAllowed(request.headers.origin, request.headers.host, runtimeConfig.server)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  const url = new URL(request.url ?? "", `http://${request.headers.host}`);
  if (url.pathname === "/trade-stream") {
    // Trade events reveal positions/PnL. Authenticate a one-use, session-bound
    // ticket before attaching the socket to its owner-partitioned event stream.
    socket.pause();
    void verifyTradeWsRequest(request.headers["sec-websocket-protocol"])
      .then((principal) => {
        if (!principal) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        Object.assign(request, { authPrincipal: typeof principal === "object" ? principal : undefined });
        trading.wss.handleUpgrade(request, socket, head, (client) => trading.wss.emit("connection", client, request));
        socket.resume();
      })
      .catch(() => {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
      });
    return;
  }
  const target = url.pathname === "/stream" ? wss
    : url.pathname === "/quotes" ? quoteWss
      : url.pathname === "/orderbook" ? orderBookWss
        : url.pathname === "/trade-flow" ? tradeFlowWss
          : url.pathname === "/arbitrage-stream" ? arbitrageWss : undefined;
  if (!target) {
    socket.destroy();
    return;
  }
  socket.pause();
  void verifyAppWsSession(request.headers.cookie).then((allowed) => {
    if (!allowed) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    target.handleUpgrade(request, socket, head, (client) => target.emit("connection", client, request));
    socket.resume();
  }).catch(() => socket.destroy());
});

tradeFlowWss.on("connection", (socket, request) => {
  const url = new URL(request.url ?? "", `http://${request.headers.host}`);
  const parsed = orderBookQuery.safeParse(Object.fromEntries(url.searchParams));
  const send = (message: TradeFlowStreamMessage) => {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > 512 * 1024) {
      socket.close(1013, "Trade flow client is too slow");
      return;
    }
    socket.send(JSON.stringify(message));
  };
  if (!parsed.success) {
    send({ type: "error", message: "Invalid trade flow stream query", ts: Date.now() });
    socket.close();
    return;
  }
  const instrument = findInstrument(parsed.data.symbol);
  if (!instrument || instrument.assetClass !== "crypto" || instrument.provider !== "binance") {
    send({ type: "error", message: `Public trade flow is unavailable for ${parsed.data.symbol}`, ts: Date.now() });
    socket.close();
    return;
  }
  try {
    const subscription = tradeFlowHub.subscribe(parsed.data.exchange, instrument.symbol, send);
    socket.on("close", () => subscription.close());
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : "Trade flow stream unavailable", ts: Date.now() });
    socket.close(1013, "Trade flow stream unavailable");
  }
});

orderBookWss.on("connection", (socket, request) => {
  const url = new URL(request.url ?? "", `http://${request.headers.host}`);
  const parsed = orderBookQuery.safeParse(Object.fromEntries(url.searchParams));
  const send = (message: OrderBookStreamMessage) => {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > 256 * 1024) {
      socket.close(1013, "Order book client is too slow");
      return;
    }
    socket.send(JSON.stringify(message));
  };
  if (!parsed.success) {
    send({ type: "error", message: "Invalid order book stream query", ts: Date.now() });
    socket.close();
    return;
  }
  const instrument = findInstrument(parsed.data.symbol);
  if (!instrument || instrument.assetClass !== "crypto" || instrument.provider !== "binance") {
    send({ type: "error", message: `Public depth is unavailable for ${parsed.data.symbol}`, ts: Date.now() });
    socket.close();
    return;
  }
  try {
    const subscription = orderBookHub.subscribe(parsed.data.exchange, instrument.symbol, send);
    socket.on("close", () => subscription.close());
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : "Order book stream unavailable", ts: Date.now() });
    socket.close(1013, "Order book stream unavailable");
  }
});

quoteWss.on("connection", async (socket, request) => {
  const url = new URL(request.url ?? "", `http://${request.headers.host}`);
  const parsed = sparklineQuery.safeParse(Object.fromEntries(url.searchParams));
  const send = (message: QuoteStreamMessage) => {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > 512 * 1024) return socket.close(1013, "Quote client is too slow");
    socket.send(JSON.stringify(message));
  };
  if (!parsed.success) {
    send({ type: "error", message: "Invalid quote stream query", ts: Date.now() });
    socket.close();
    return;
  }
  const symbols = [
    ...new Set(
      parsed.data.symbols
        .split(",")
        .map((symbol) => symbol.trim())
        .filter(Boolean)
    )
  ].slice(0, 40);
  const instruments = symbols.map((symbol) => findInstrument(symbol)).filter((item) => item !== undefined);
  const histories = new Map<string, Candle[]>();
  const series: Record<string, { last: number | null; changePct: number; points: number[] } | null> = {};
  await Promise.all(
    instruments.map(async (instrument) => {
      try {
        const candles = await marketDataGate.run(JSON.stringify(["quote", instrument.symbol, parsed.data]), () =>
          provider.getCandles(instrument, parsed.data.timeframe, { limit: parsed.data.points }, parsed.data));
        histories.set(instrument.symbol, candles);
        series[instrument.symbol] = sparklineSeries(candles);
      } catch {
        series[instrument.symbol] = null;
      }
    })
  );
  send({ type: "quotes_snapshot", timeframe: parsed.data.timeframe, series, provider: provider.name, ts: Date.now() });

  const subscriptions: Array<{ close(): void }> = [];
  await Promise.allSettled(
    instruments.map(async (instrument) => {
      const subscription = await provider.subscribe(
        instrument,
        parsed.data.timeframe,
        (candle) => {
          const current = histories.get(instrument.symbol) ?? [];
          const last = current.at(-1);
          const next = last?.time === candle.time ? [...current.slice(0, -1), candle] : [...current, candle];
          const bounded = next.slice(-parsed.data.points);
          histories.set(instrument.symbol, bounded);
          send({
            type: "quote",
            symbol: instrument.symbol,
            timeframe: parsed.data.timeframe,
            series: sparklineSeries(bounded),
            provider: candle.source ?? provider.name,
            ts: Date.now()
          });
        },
        () => undefined,
        parsed.data
      );
      subscriptions.push(subscription);
    })
  );
  socket.on("close", () => subscriptions.forEach((subscription) => subscription.close()));
});

wss.on("connection", async (socket, request) => {
  const url = new URL(request.url ?? "", `http://${request.headers.host}`);
  const parsed = candleQuery.safeParse(Object.fromEntries(url.searchParams));
  const send = (message: StreamMessage) => {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > 512 * 1024) return socket.close(1013, "Market client is too slow");
    socket.send(JSON.stringify(message));
  };

  if (!parsed.success) {
    send({ type: "error", message: "Invalid stream query", ts: Date.now() });
    socket.close();
    return;
  }

  const instrument = findInstrument(parsed.data.symbol);
  if (!instrument) {
    send({ type: "error", message: `Unknown symbol: ${parsed.data.symbol}`, ts: Date.now() });
    socket.close();
    return;
  }

  try {
    const candles = await marketDataGate.run(JSON.stringify(["stream", instrument.symbol, parsed.data]), () =>
      provider.getCandles(
        instrument,
        parsed.data.timeframe,
        { limit: parsed.data.limit },
        {
          exchange: parsed.data.exchange,
          marketType: parsed.data.marketType,
          priceType: parsed.data.priceType
        }
      ));
    send({
      type: "snapshot",
      symbol: instrument.symbol,
      timeframe: parsed.data.timeframe,
      candles,
      provider: candles.at(-1)?.source ?? provider.name,
      ts: Date.now()
    });

    const subscription = await provider.subscribe(
      instrument,
      parsed.data.timeframe,
      (candle) => {
        if (socket.readyState !== socket.OPEN) return;
        send({
          type: "candle",
          symbol: instrument.symbol,
          timeframe: parsed.data.timeframe,
          candle,
          provider: candle.source ?? provider.name,
          ts: Date.now()
        });
      },
      (message) => {
        if (socket.readyState !== socket.OPEN) return;
        send({
          type: "status",
          status: message.includes("Fallback") ? "fallback" : "connected",
          provider: instrument.provider,
          message,
          ts: Date.now()
        });
      },
      {
        exchange: parsed.data.exchange,
        marketType: parsed.data.marketType,
        priceType: parsed.data.priceType
      }
    );

    socket.on("close", () => subscription.close());
  } catch (error) {
    send({
      type: "error",
      message: error instanceof Error ? error.message : "Market stream unavailable",
      ts: Date.now()
    });
    socket.close();
  }
});

function sparklineSeries(candles: Candle[]) {
  const points = candles.map((candle) => candle.close);
  const first = points[0];
  const last = points.at(-1);
  return { last: last ?? null, changePct: first && last ? ((last - first) / first) * 100 : 0, points };
}

app.use(apiErrorHandler);
installFrontendDistribution(app, frontendDistribution);

server.listen(port, host, () => {
  console.log(`SaltanatbotV2 backend listening on http://${host}:${port}`);
  // Upgrade the crypto catalog to the exchanges' full USDT-spot universe. Runs
  // fire-and-forget: the curated fallback already serves requests, so a slow or
  // failed fetch never delays startup or breaks the catalog endpoint.
  void initCatalog()
    .then(() => console.log(`Instrument catalog ready (${getCatalog().instruments.length} instruments).`))
    .catch((error) => console.log(`Catalog fetch failed, using curated fallback: ${String(error)}`));
  if (isPaperOnlyRuntime(runtimePolicy)) {
    console.log("🔒 Runtime profile public-http-paper — private exchange access and live trading are disabled.");
  }
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!loopback) {
    console.log(
      `⚠️  Bound to ${host} (reachable off-machine). During the current HTTP Research / Paper phase,\n` +
        "   allow only a trusted private network/VPN or strict source IPs. HTTPS is deferred. See docs/CONFIGURATION.md."
    );
  }
  // Bring back bots that were running before the last shutdown/crash.
  void trading.engine.resume(createTradingResumeAuthorization(identityRuntime, runtimePolicy));
  // Start the inbound Telegram control poller. No-op unless a token+chatId are
  // configured and Telegram is enabled; it can also be activated later from the
  // UI (POST /notify calls refresh()).
  trading.telegramControl.start();
  researchAlerts.start();
  venueClockCalibration.start();
  continuousRouteRuntime.start();
  if (continuousRouteSetup.error) console.log(`Continuous route allowlist disabled: ${continuousRouteSetup.error}`);
});

installGracefulShutdown(server, {
  quiesce() {
    // Preserve desired status so running bots resume on the next start.
    trading.telegramControl.stop();
    researchAlerts.close();
    arbitrageAlerts.close();
    trading.engine.shutdown();
    detachOpportunityLifecycle();
    detachContinuousRouteLifecycle();
    arbitrageStream.close();
    continuousRouteRuntime.close();
    continuousPublicFeeds.close();
    venueClockCalibration.stop();
  },
  closeResources: async () => {
    trading.close();
    await identityRuntime.close();
  }
});

function continuousRouteConfigurationFromEnvironment() {
  try {
    return { configuration: loadContinuousRouteConfiguration({ json: process.env.ARBITRAGE_CONTINUOUS_ROUTES_JSON, file: process.env.ARBITRAGE_CONTINUOUS_ROUTES_FILE }) };
  } catch (error) {
    return { configuration: [], error: error instanceof Error ? error.message : "Continuous route allowlist is invalid" };
  }
}
