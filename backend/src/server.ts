import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { getAuthToken, isDemoMode, verifyWsToken, wasAuthTokenGeneratedThisRun } from "./auth.js";
import { createArbitrageDepthHandler, createArbitrageHandler } from "./arbitrage/routes.js";
import { ArbitrageScannerService } from "./arbitrage/service.js";
import { ArbitrageStreamHub } from "./arbitrage/stream.js";
import { findInstrument, getCatalog, initCatalog } from "./market/catalog.js";
import { timeframes } from "./market/timeframes.js";
import { OrderBookHub } from "./orderbook/hub.js";
import { ProviderRouter } from "./providers/router.js";
import { securityHeaders } from "./securityHeaders.js";
import { frontendCacheControl } from "./staticCache.js";
import { createTradingApi } from "./trading/routes.js";
import { TradeFlowHub } from "./tradeflow/hub.js";
import type { Candle, OrderBookStreamMessage, QuoteStreamMessage, StreamMessage, Timeframe, TradeFlowStreamMessage } from "./types.js";

const port = Number(process.env.PORT ?? 4180);
// Fail safe: bind to loopback unless the operator explicitly opts into a wider bind.
const host = process.env.HOST ?? "127.0.0.1";
const provider = new ProviderRouter();
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const quoteWss = new WebSocketServer({ noServer: true });
const orderBookWss = new WebSocketServer({ noServer: true });
const tradeFlowWss = new WebSocketServer({ noServer: true });
const arbitrageWss = new WebSocketServer({ noServer: true });
const orderBookHub = new OrderBookHub();
const tradeFlowHub = new TradeFlowHub();
const trading = createTradingApi(provider);
const arbitrageScanner = new ArbitrageScannerService();
const arbitrageStream = new ArbitrageStreamHub(arbitrageWss, arbitrageScanner);

// CORS: same-origin needs nothing (the SPA is served by this app). Allow an
// explicit allowlist for cross-origin dev/proxy setups via ALLOWED_ORIGINS.
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
);
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

const candleQuery = z.object({
  symbol: z.string().min(1),
  timeframe: z.enum(timeframes as [Timeframe, ...Timeframe[]]).default("1m"),
  limit: z.coerce.number().int().min(10).max(1000).default(320),
  endTime: z.coerce.number().int().positive().optional(),
  startTime: z.coerce.number().int().positive().optional(),
  exchange: exchangeParam
});

const sparklineQuery = z.object({
  symbols: z.string().min(1),
  timeframe: z.enum(timeframes as [Timeframe, ...Timeframe[]]).default("1h"),
  points: z.coerce.number().int().min(2).max(120).default(32),
  exchange: exchangeParam
});

const orderBookQuery = z.object({
  symbol: z.string().min(1),
  exchange: exchangeParam
});

app.use(cors(corsOptions));
app.disable("x-powered-by");
app.use(securityHeaders);
app.use(express.json({ limit: "1mb" }));
// The trading API holds exchange keys and can place real orders. Its router
// exposes only /session publicly; every other route is gated inside routes.ts.
app.use("/api/trade", trading.router);

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, service: "saltanatbotv2-backend", ts: Date.now() });
});

app.get("/api/catalog", (_request, response) => {
  response.json(getCatalog());
});

app.get("/api/arbitrage", createArbitrageHandler(arbitrageScanner));
app.get("/api/arbitrage/depth", createArbitrageDepthHandler());

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
    candles = await provider.getCandles(
      instrument,
      parsed.data.timeframe,
      {
        limit: parsed.data.limit,
        endTime: parsed.data.endTime,
        startTime: parsed.data.startTime
      },
      parsed.data.exchange
    );
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
        const candles = await provider.getCandles(
          instrument,
          parsed.data.timeframe,
          { limit: parsed.data.points },
          parsed.data.exchange
        );
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
  const url = new URL(request.url ?? "", `http://${request.headers.host}`);
  if (url.pathname === "/stream") {
    // Public market-data stream (read-only candles). No secrets exposed here.
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  } else if (url.pathname === "/quotes") {
    // One browser connection multiplexes the watchlist's read-only quote feeds.
    quoteWss.handleUpgrade(request, socket, head, (client) => quoteWss.emit("connection", client, request));
  } else if (url.pathname === "/orderbook") {
    // Public read-only depth snapshots; one shared upstream serves all viewers.
    orderBookWss.handleUpgrade(request, socket, head, (client) => orderBookWss.emit("connection", client, request));
  } else if (url.pathname === "/trade-flow") {
    // Public read-only exchange prints; one shared upstream serves all viewers.
    tradeFlowWss.handleUpgrade(request, socket, head, (client) => tradeFlowWss.emit("connection", client, request));
  } else if (url.pathname === "/arbitrage-stream") {
    // Public read-only cross-venue snapshots; no account data or order path.
    arbitrageWss.handleUpgrade(request, socket, head, (client) => arbitrageWss.emit("connection", client, request));
  } else if (url.pathname === "/trade-stream") {
    // Trade events can reveal positions/PnL — require the access token.
    if (!verifyWsToken(url, request.headers["sec-websocket-protocol"])) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    trading.wss.handleUpgrade(request, socket, head, (client) => trading.wss.emit("connection", client, request));
  } else {
    socket.destroy();
  }
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
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };
  if (!parsed.success) {
    send({ type: "error", message: "Invalid quote stream query", ts: Date.now() });
    socket.close();
    return;
  }
  const symbols = [...new Set(parsed.data.symbols.split(",").map((symbol) => symbol.trim()).filter(Boolean))].slice(0, 40);
  const instruments = symbols.map((symbol) => findInstrument(symbol)).filter((item) => item !== undefined);
  const histories = new Map<string, Candle[]>();
  const series: Record<string, { last: number | null; changePct: number; points: number[] } | null> = {};
  await Promise.all(instruments.map(async (instrument) => {
    try {
      const candles = await provider.getCandles(instrument, parsed.data.timeframe, { limit: parsed.data.points }, parsed.data.exchange);
      histories.set(instrument.symbol, candles);
      series[instrument.symbol] = sparklineSeries(candles);
    } catch {
      series[instrument.symbol] = null;
    }
  }));
  send({ type: "quotes_snapshot", timeframe: parsed.data.timeframe, series, provider: provider.name, ts: Date.now() });

  const subscriptions: Array<{ close(): void }> = [];
  await Promise.allSettled(instruments.map(async (instrument) => {
    const subscription = await provider.subscribe(instrument, parsed.data.timeframe, (candle) => {
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
    }, () => undefined, parsed.data.exchange);
    subscriptions.push(subscription);
  }));
  socket.on("close", () => subscriptions.forEach((subscription) => subscription.close()));
});

wss.on("connection", async (socket, request) => {
  const url = new URL(request.url ?? "", `http://${request.headers.host}`);
  const parsed = candleQuery.safeParse(Object.fromEntries(url.searchParams));
  const send = (message: StreamMessage) => socket.send(JSON.stringify(message));

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
    const candles = await provider.getCandles(
      instrument,
      parsed.data.timeframe,
      { limit: parsed.data.limit },
      parsed.data.exchange
    );
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
      parsed.data.exchange
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDist = path.resolve(__dirname, "../../frontend/dist");

app.use(express.static(frontendDist, {
  setHeaders(response, filePath) {
    const relative = path.relative(frontendDist, filePath);
    response.setHeader("Cache-Control", frontendCacheControl(relative));
    if (relative === "service-worker.js") response.setHeader("Service-Worker-Allowed", "/");
  }
}));
app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(frontendDist, "index.html"), { headers: { "Cache-Control": "no-cache" } });
});

server.listen(port, host, () => {
  console.log(`SaltanatbotV2 backend listening on http://${host}:${port}`);
  // Upgrade the crypto catalog to the exchanges' full USDT-spot universe. Runs
  // fire-and-forget: the curated fallback already serves requests, so a slow or
  // failed fetch never delays startup or breaks the catalog endpoint.
  void initCatalog()
    .then(() => console.log(`Instrument catalog ready (${getCatalog().instruments.length} instruments).`))
    .catch((error) => console.log(`Catalog fetch failed, using curated fallback: ${String(error)}`));
  if (isDemoMode()) {
    console.log("⚠️  DEMO_MODE is ON — exchange keys and live trading are disabled.");
  }
  // Ensure the token exists and surface it to the operator on first run.
  const token = getAuthToken();
  if (wasAuthTokenGeneratedThisRun()) {
    console.log("");
    console.log("🔑 Trading API access token (needed to log in to the Trade tab):");
    console.log(`      ${token}`);
    console.log("   Stored in backend/data/.authtoken · override with the AUTH_TOKEN env var.");
    console.log("");
  }
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!loopback) {
    console.log(
      `⚠️  Bound to ${host} (reachable off-machine). Put this behind a reverse proxy with TLS,\n` +
        "   restrict access, and keep the access token secret. See docs/CONFIGURATION.md."
    );
  }
  // Bring back bots that were running before the last shutdown/crash.
  void trading.engine.resume();
  // Start the inbound Telegram control poller. No-op unless a token+chatId are
  // configured and Telegram is enabled; it can also be activated later from the
  // UI (POST /notify calls refresh()).
  trading.telegramControl.start();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // Preserve desired status so running bots resume on the next start.
    trading.telegramControl.stop();
    trading.engine.shutdown();
    arbitrageStream.close();
    server.close(() => process.exit(0));
  });
}
