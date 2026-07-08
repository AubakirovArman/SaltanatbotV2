import { randomUUID } from "node:crypto";
import { Router } from "express";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { isDemoMode } from "../auth.js";
import { timeframes } from "../market/timeframes.js";
import type { ProviderRouter } from "../providers/router.js";
import { TradingEngine, type TradeEvent } from "./engine.js";
import type { ExchangeKeys } from "./exchange/binance.js";
import { getNotifyConfig, testNotify, type NotifyConfig } from "./notifications.js";
import { deleteBot, initStore, listBots, listFills, listLogs, getSetting, setSetting, upsertBot } from "./store.js";
import type { Timeframe } from "../types.js";
import type { BotConfig, ExchangeId } from "./types.js";

const timeframeEnum = z.enum(timeframes as [Timeframe, ...Timeframe[]]);

const botBodySchema = z.object({
  id: z.string().optional(),
  name: z.string().max(120).optional(),
  strategyName: z.string().max(120).optional(),
  ir: z.record(z.string(), z.unknown()).refine((v) => v && typeof v === "object", "ir must be an object"),
  symbol: z.string().min(1).max(30),
  timeframe: timeframeEnum,
  exchange: z.enum(["paper", "binance", "bybit"]).default("paper"),
  market: z.enum(["spot", "futures"]).default("spot"),
  sizeMode: z.enum(["quote", "base", "equity_pct", "risk_pct"]).default("quote"),
  sizeValue: z.coerce.number().positive().finite().max(1_000_000_000),
  leverage: z.coerce.number().int().min(1).max(125).default(1),
  notifyMarkers: z.boolean().default(false),
  // Live-trading risk caps (0/undefined = unlimited; enforced by the engine).
  maxPositionQuote: z.coerce.number().nonnegative().finite().max(1_000_000_000).optional(),
  maxDailyLossQuote: z.coerce.number().nonnegative().finite().max(1_000_000_000).optional()
});

const keysBodySchema = z.object({
  exchange: z.enum(["binance", "bybit"]),
  apiKey: z.string().trim().min(8).max(256),
  apiSecret: z.string().trim().min(8).max(256)
});

const commandBodySchema = z.object({
  command: z.string().min(1).max(2000),
  dryRun: z.boolean().optional()
});

const notifyBodySchema = z.object({
  telegram: z
    .object({ enabled: z.boolean().optional(), token: z.string().max(256).optional(), chatId: z.string().max(64).optional() })
    .optional(),
  vk: z
    .object({ enabled: z.boolean().optional(), token: z.string().max(512).optional(), peerId: z.string().max(64).optional() })
    .optional()
});

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

  const liveEnabled = () => getSetting<boolean>("liveTradingEnabled") === true;

  // Lets the frontend verify a stored token and learn whether live trading is armed.
  router.get("/auth", (_req, res) => {
    res.json({ ok: true, demo: isDemoMode(), liveTradingEnabled: liveEnabled() });
  });

  router.get("/settings", (_req, res) => {
    res.json({ demo: isDemoMode(), liveTradingEnabled: liveEnabled() });
  });

  router.post("/settings", (req, res) => {
    const parsed = z.object({ liveTradingEnabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    if (isDemoMode() && parsed.data.liveTradingEnabled) {
      res.status(403).json({ error: "Live trading is disabled in DEMO_MODE." });
      return;
    }
    setSetting("liveTradingEnabled", parsed.data.liveTradingEnabled);
    res.json({ liveTradingEnabled: parsed.data.liveTradingEnabled });
  });

  // Global kill switch: stop every bot and disarm live trading.
  router.post("/kill", (_req, res) => {
    engine.stopAll();
    setSetting("liveTradingEnabled", false);
    res.json({ ok: true });
  });

  router.get("/bots", (_req, res) => {
    res.json({ bots: listBots().map(withStatus) });
  });

  // Cross-bot portfolio: live account equity/positions/orders (deduped by
  // exchange) plus today's realized PnL. Fail-safe — never throws to the client.
  router.get("/portfolio", async (_req, res) => {
    try {
      res.json(await engine.portfolio());
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "portfolio failed" });
    }
  });

  router.post("/bots", (req, res) => {
    const parsed = botBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const body = parsed.data;
    if (isDemoMode() && body.exchange !== "paper") {
      res.status(403).json({ error: "Only paper trading is available in DEMO_MODE." });
      return;
    }
    const now = Date.now();
    const existing = body.id ? listBots().find((bot) => bot.id === body.id) : undefined;
    const bot: BotConfig = {
      id: body.id ?? randomUUID(),
      name: body.name?.trim() || body.strategyName || "Bot",
      strategyName: body.strategyName ?? "Strategy",
      ir: body.ir as unknown as BotConfig["ir"],
      symbol: body.symbol.toUpperCase(),
      timeframe: body.timeframe,
      exchange: body.exchange as ExchangeId,
      market: body.market,
      sizeMode: body.sizeMode,
      sizeValue: body.sizeValue,
      leverage: body.leverage,
      notifyMarkers: body.notifyMarkers,
      maxPositionQuote: body.maxPositionQuote,
      maxDailyLossQuote: body.maxDailyLossQuote,
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
    // Live trading is double-gated: a global arm flag AND per-request confirmation.
    if (bot.exchange !== "paper") {
      if (isDemoMode()) {
        res.status(403).json({ error: "Live trading is disabled in DEMO_MODE." });
        return;
      }
      if (!liveEnabled()) {
        res.status(403).json({ error: "Live trading is not armed. Enable it in Trade settings first." });
        return;
      }
      if ((req.body as { confirmLive?: boolean })?.confirmLive !== true) {
        res.status(428).json({ error: "Live start requires confirmLive:true.", needsConfirm: true });
        return;
      }
    }
    try {
      const override = (req.body as { override?: boolean })?.override === true;
      await engine.start(bot, { override });
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
    const parsed = commandBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const result = await engine.manualCommand(req.params.id, parsed.data.command, parsed.data.dryRun === true);
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
    if (isDemoMode()) {
      res.status(403).json({ error: "Exchange keys cannot be stored in DEMO_MODE." });
      return;
    }
    const parsed = keysBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    setSetting(`keys:${parsed.data.exchange}`, { apiKey: parsed.data.apiKey, apiSecret: parsed.data.apiSecret }, true);
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
    const parsed = notifyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const body = parsed.data as Partial<NotifyConfig>;
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
