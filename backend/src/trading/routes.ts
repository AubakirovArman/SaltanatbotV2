import { randomUUID } from "node:crypto";
import { Router } from "express";
import { WebSocket, WebSocketServer } from "ws";
import type { ProviderRouter } from "../providers/router.js";
import { TradingEngine, type TradeEvent } from "./engine.js";
import type { ExchangeKeys } from "./exchange/binance.js";
import { getNotifyConfig, testNotify, type NotifyConfig } from "./notifications.js";
import { deleteBot, initStore, listBots, listFills, listLogs, getSetting, setSetting, upsertBot } from "./store.js";
import type { BotConfig, ExchangeId } from "./types.js";

export interface TradingApi {
  router: Router;
  wss: WebSocketServer;
  engine: TradingEngine;
}

export function createTradingApi(provider: ProviderRouter): TradingApi {
  initStore();

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  wss.on("connection", (socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });
  const broadcast = (event: TradeEvent) => {
    const message = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.send(message);
    }
  };

  const engine = new TradingEngine(provider, broadcast);
  const router = Router();

  const withStatus = (bot: BotConfig): BotConfig => ({
    ...bot,
    status: engine.isRunning(bot.id) ? "running" : "stopped"
  });

  router.get("/bots", (_req, res) => {
    res.json({ bots: listBots().map(withStatus) });
  });

  router.post("/bots", (req, res) => {
    const body = req.body as Partial<BotConfig>;
    if (!body.symbol || !body.ir || !body.timeframe) {
      res.status(400).json({ error: "symbol, timeframe and ir are required" });
      return;
    }
    const now = Date.now();
    const existing = body.id ? listBots().find((bot) => bot.id === body.id) : undefined;
    const bot: BotConfig = {
      id: body.id ?? randomUUID(),
      name: body.name?.trim() || body.strategyName || "Bot",
      strategyName: body.strategyName ?? "Strategy",
      ir: body.ir,
      symbol: body.symbol.toUpperCase(),
      timeframe: body.timeframe,
      exchange: (body.exchange ?? "paper") as ExchangeId,
      market: body.market === "spot" ? "spot" : "futures",
      sizeMode: body.sizeMode ?? "quote",
      sizeValue: body.sizeValue ?? 100,
      leverage: Math.max(1, body.leverage ?? 1),
      notifyMarkers: body.notifyMarkers ?? false,
      status: "stopped",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    upsertBot(bot);
    res.json({ bot: withStatus(bot) });
  });

  router.delete("/bots/:id", (req, res) => {
    engine.stop(req.params.id);
    deleteBot(req.params.id);
    res.json({ ok: true });
  });

  router.post("/bots/:id/start", async (req, res) => {
    const bot = listBots().find((item) => item.id === req.params.id);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    try {
      await engine.start(bot);
      res.json({ ok: true, bot: withStatus(bot) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Failed to start" });
    }
  });

  router.post("/bots/:id/stop", (req, res) => {
    engine.stop(req.params.id);
    res.json({ ok: true });
  });

  router.post("/bots/:id/command", async (req, res) => {
    const command = (req.body as { command?: string }).command;
    if (!command) {
      res.status(400).json({ error: "command is required" });
      return;
    }
    const result = await engine.manualCommand(req.params.id, command);
    res.json(result);
  });

  router.get("/bots/:id/fills", (req, res) => {
    res.json({ fills: listFills(req.params.id, 200) });
  });

  router.get("/bots/:id/logs", (req, res) => {
    res.json({ logs: listLogs(req.params.id, 200) });
  });

  router.get("/bots/:id/live", async (req, res) => {
    res.json((await engine.liveState(req.params.id)) ?? { price: 0 });
  });

  router.get("/bots/:id/orders", async (req, res) => {
    res.json({ orders: await engine.orders(req.params.id) });
  });

  // ---- exchange keys (never returned in plaintext) ----
  router.get("/keys", (_req, res) => {
    res.json({
      binance: hasKeys("binance"),
      bybit: hasKeys("bybit")
    });
  });

  router.post("/keys", (req, res) => {
    const body = req.body as { exchange?: ExchangeId; apiKey?: string; apiSecret?: string };
    if (body.exchange !== "binance" && body.exchange !== "bybit") {
      res.status(400).json({ error: "exchange must be binance or bybit" });
      return;
    }
    setSetting(`keys:${body.exchange}`, { apiKey: body.apiKey ?? "", apiSecret: body.apiSecret ?? "" }, true);
    res.json({ ok: true });
  });

  // ---- notifications ----
  router.get("/notify", (_req, res) => {
    const config = getNotifyConfig();
    res.json({
      telegram: { enabled: config.telegram.enabled, chatId: config.telegram.chatId, hasToken: !!config.telegram.token },
      vk: { enabled: config.vk.enabled, peerId: config.vk.peerId, hasToken: !!config.vk.token }
    });
  });

  router.post("/notify", (req, res) => {
    const body = req.body as Partial<NotifyConfig>;
    const current = getNotifyConfig();
    const next: NotifyConfig = {
      telegram: {
        enabled: body.telegram?.enabled ?? current.telegram.enabled,
        token: body.telegram?.token || current.telegram.token,
        chatId: body.telegram?.chatId ?? current.telegram.chatId
      },
      vk: {
        enabled: body.vk?.enabled ?? current.vk.enabled,
        token: body.vk?.token || current.vk.token,
        peerId: body.vk?.peerId ?? current.vk.peerId
      }
    };
    setSetting("notify", next, true);
    res.json({ ok: true });
  });

  router.post("/notify/test", async (_req, res) => {
    res.json(await testNotify());
  });

  return { router, wss, engine };
}

function hasKeys(exchange: ExchangeId): boolean {
  const keys = getSetting<ExchangeKeys>(`keys:${exchange}`);
  return !!(keys?.apiKey && keys.apiSecret);
}
