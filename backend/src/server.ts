import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { findInstrument, getCatalog } from "./market/catalog.js";
import { timeframes } from "./market/timeframes.js";
import { ProviderRouter } from "./providers/router.js";
import { createTradingApi } from "./trading/routes.js";
import type { StreamMessage, Timeframe } from "./types.js";

const port = Number(process.env.PORT ?? 4180);
const host = process.env.HOST ?? "0.0.0.0";
const provider = new ProviderRouter();
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const trading = createTradingApi(provider);

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

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use("/api/trade", trading.router);

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, service: "saltanatbotv2-backend", ts: Date.now() });
});

app.get("/api/catalog", (_request, response) => {
  response.json(getCatalog());
});

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

  const candles = await provider.getCandles(
    instrument,
    parsed.data.timeframe,
    {
      limit: parsed.data.limit,
      endTime: parsed.data.endTime,
      startTime: parsed.data.startTime
    },
    parsed.data.exchange
  );
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
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  } else if (url.pathname === "/trade-stream") {
    trading.wss.handleUpgrade(request, socket, head, (client) => trading.wss.emit("connection", client, request));
  } else {
    socket.destroy();
  }
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
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDist = path.resolve(__dirname, "../../frontend/dist");

app.use(express.static(frontendDist));
app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(frontendDist, "index.html"));
});

server.listen(port, host, () => {
  console.log(`SaltanatbotV2 backend listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    trading.engine.stopAll();
    server.close(() => process.exit(0));
  });
}
