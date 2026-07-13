import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { clearAuthSession, createAuthSession, isDemoMode, issueWsTicket, requireAuth, roleAllows, roleForToken } from "../auth.js";
import { timeframes } from "../market/timeframes.js";
import type { ProviderRouter } from "../providers/router.js";
import { TradingEngine, type TradeEvent } from "./engine.js";
import type { ExchangeKeys } from "./exchange/binance.js";
import { BybitV5Client } from "./exchange/bybitClient.js";
import { BybitUtaService } from "./bybitUta.js";
import { createBybitUtaHandlers } from "./bybitUtaRoutes.js";
import { getNotifyConfig, notify, testNotify, type NotifyConfig } from "./notifications.js";
import { TelegramControl } from "./telegramControl.js";
import { deleteBot, deleteSetting, initStore, insertAuditLog, listAuditLog, listBots, listFills, listLogs, listOrderEvents, listOrderJournal, getSetting, setSetting, upsertBot } from "./store.js";
import { parseStrategyIR } from "./strategy/irSchema.js";
import type { Timeframe } from "../types.js";
import type { AuthRole, BotConfig, ExchangeId } from "./types.js";

const timeframeEnum = z.enum(timeframes as [Timeframe, ...Timeframe[]]);

const botBodySchema = z.object({
  id: z.string().optional(),
  name: z.string().max(120).optional(),
  strategyName: z.string().max(120).optional(),
  // Structurally validated separately by parseStrategyIR (a strict node whitelist).
  ir: z.unknown(),
  symbol: z.string().min(1).max(30),
  timeframe: timeframeEnum,
  exchange: z.enum(["paper", "binance", "bybit"]).default("paper"),
  market: z.enum(["spot", "futures"]).default("spot"),
  sizeMode: z.enum(["quote", "base", "equity_pct", "risk_pct"]).default("quote"),
  sizeValue: z.coerce.number().positive().finite().max(1_000_000_000),
  leverage: z.coerce.number().int().min(1).max(125).default(1),
  bybitCrossCollateral: z.boolean().default(false),
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

const sessionBodySchema = z.object({
  token: z.string().trim().min(1).max(512)
});

const notifyBodySchema = z.object({
  telegram: z
    .object({
      enabled: z.boolean().optional(),
      token: z.string().max(256).optional(),
      chatId: z.string().max(64).optional(),
      // Inbound two-way control toggle. Omitted = follow `enabled`.
      control: z.boolean().optional()
    })
    .optional(),
  vk: z
    .object({ enabled: z.boolean().optional(), token: z.string().max(512).optional(), peerId: z.string().max(64).optional() })
    .optional()
});

export interface TradingApi {
  router: Router;
  wss: WebSocketServer;
  engine: TradingEngine;
  /** Inbound Telegram control channel — start()/stop() from the server lifecycle. */
  telegramControl: TelegramControl;
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
  // Inbound Telegram control. No-op until a token+chatId are configured and
  // Telegram is enabled; refresh()'d by POST /notify so a UI toggle takes effect
  // without a restart. Started from server.ts after listen().
  const telegramControl = new TelegramControl(engine);
  const router = Router();

  const withStatus = (bot: BotConfig): BotConfig => ({
    ...bot,
    status: engine.isRunning(bot.id) ? "running" : "stopped"
  });

  const liveEnabled = () => getSetting<boolean>("liveTradingEnabled") === true;
  const uta = createBybitUtaHandlers({
    demo: isDemoMode,
    liveEnabled,
    keys: () => getSetting<ExchangeKeys>("keys:bybit")
  });

  router.post("/session", (req, res) => {
    const parsed = sessionBodySchema.safeParse(req.body);
    const role = parsed.success ? roleForToken(parsed.data.token) : undefined;
    if (!parsed.success || !role) {
      res.status(401).json({ error: "Unauthorized — a valid access token is required." });
      return;
    }
    const session = createAuthSession(res, role);
    res.json({ ok: true, demo: isDemoMode(), liveTradingEnabled: liveEnabled(), role: session.role, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
  });

  // Public status probe for the Trade tab. It avoids a noisy browser-console 401
  // on first load, while every actual trading endpoint below remains gated.
  router.get("/auth", (req, res) => {
    if (!req.headers.authorization && !req.headers.cookie) {
      res.json({ ok: false, demo: isDemoMode(), liveTradingEnabled: false });
      return;
    }
    requireAuth(req, res, () => {
      res.json({ ok: true, demo: isDemoMode(), liveTradingEnabled: liveEnabled(), role: res.locals.authRole, csrfToken: res.locals.csrfToken });
    });
  });

  router.use(requireAuth);
  router.use(auditMutations);

  router.delete("/session", (req, res) => {
    clearAuthSession(req, res);
    res.json({ ok: true });
  });

  router.post("/ws-ticket", (_req, res) => {
    res.json(issueWsTicket());
  });

  router.get("/settings", (_req, res) => {
    res.json({ demo: isDemoMode(), liveTradingEnabled: liveEnabled() });
  });

  router.post("/settings", requireRole("admin"), (req, res) => {
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
  router.post("/kill", requireRole("live-trade"), (_req, res) => {
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
    if (!ensureRole(res, body.exchange === "paper" ? "paper-trade" : "live-trade")) return;
    if (isDemoMode() && body.exchange !== "paper") {
      res.status(403).json({ error: "Only paper trading is available in DEMO_MODE." });
      return;
    }
    // Reject any IR that isn't a known node shape before it can be persisted/executed.
    const irResult = parseStrategyIR(body.ir);
    if (!irResult.ok) {
      res.status(400).json({ error: `Invalid strategy IR: ${irResult.error}` });
      return;
    }
    const now = Date.now();
    const existing = body.id ? listBots().find((bot) => bot.id === body.id) : undefined;
    const bot: BotConfig = {
      id: body.id ?? randomUUID(),
      name: body.name?.trim() || body.strategyName || "Bot",
      strategyName: body.strategyName ?? "Strategy",
      ir: irResult.ir,
      symbol: body.symbol.toUpperCase(),
      timeframe: body.timeframe,
      exchange: body.exchange as ExchangeId,
      market: body.market,
      sizeMode: body.sizeMode,
      sizeValue: body.sizeValue,
      leverage: body.leverage,
      bybitCrossCollateral: body.exchange === "bybit" && body.market === "futures" && body.bybitCrossCollateral,
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

  router.delete("/bots/:id", requireRole("admin"), (req, res) => {
    const id = routeParam(req, "id");
    engine.stop(id);
    deleteBot(id);
    res.json({ ok: true });
  });

  router.post("/bots/:id/start", async (req, res) => {
    const id = routeParam(req, "id");
    const bot = listBots().find((item) => item.id === id);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    if (!ensureRole(res, roleForBot(bot))) return;
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
      if (bot.exchange === "bybit" && bot.market === "futures" && bot.bybitCrossCollateral) {
        const snapshot = await bybitUta().snapshot();
        if (!snapshot.risk.entryAllowed) throw new Error(`Bybit UTA risk guard blocked start: ${snapshot.risk.reasons.join("; ")}`);
        if (!snapshot.assets.some((asset) => asset.collateralEnabled && asset.usdValue > 0)) {
          throw new Error("Bybit cross-collateral mode requires a funded collateral asset to be enabled.");
        }
      }
      const override = (req.body as { override?: boolean })?.override === true;
      await engine.start(bot, { override });
      res.json({ ok: true, bot: withStatus(bot) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Failed to start" });
    }
  });

  router.post("/bots/:id/stop", (req, res) => {
    const id = routeParam(req, "id");
    const bot = listBots().find((item) => item.id === id);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    if (!ensureRole(res, roleForBot(bot))) return;
    engine.stop(id);
    res.json({ ok: true });
  });

  // Clear the pause set by the resume staleness gate (bot resumed with stale
  // open-position/counter state) and let it trade again.
  router.post("/bots/:id/confirm-resume", (req, res) => {
    const id = routeParam(req, "id");
    const bot = listBots().find((item) => item.id === id);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    if (!ensureRole(res, roleForBot(bot))) return;
    res.json({ ok: engine.confirmResume(id) });
  });

  // Reset a bot's durable strategy state (setvar counters + managed tracking).
  // Only allowed while the bot is stopped so a running bot can't be desynced.
  router.post("/bots/:id/reset-state", requireRole("admin"), (req, res) => {
    const id = routeParam(req, "id");
    if (engine.isRunning(id)) {
      res.status(409).json({ error: "Stop the bot before resetting its state." });
      return;
    }
    deleteSetting(`state:${id}`);
    res.json({ ok: true });
  });

  router.post("/bots/:id/command", async (req, res) => {
    const parsed = commandBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const id = routeParam(req, "id");
    const bot = listBots().find((item) => item.id === id);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    if (!ensureRole(res, roleForBot(bot))) return;
    const result = await engine.manualCommand(id, parsed.data.command, parsed.data.dryRun === true);
    res.json(result);
  });

  router.get("/bots/:id/fills", (req, res) => {
    res.json({ fills: listFills(routeParam(req, "id"), 200) });
  });

  router.get("/bots/:id/logs", (req, res) => {
    res.json({ logs: listLogs(routeParam(req, "id"), 200) });
  });

  router.get("/bots/:id/live", async (req, res) => {
    res.json((await engine.liveState(routeParam(req, "id"))) ?? { price: 0 });
  });

  router.get("/bots/:id/orders", async (req, res) => {
    res.json({ orders: await engine.orders(routeParam(req, "id")) });
  });

  router.get("/bots/:id/order-journal", (req, res) => {
    res.json({ orders: listOrderJournal(routeParam(req, "id"), 200) });
  });

  router.get("/bots/:id/order-journal/:orderId/events", (req, res) => {
    res.json({ events: listOrderEvents(routeParam(req, "orderId"), 500) });
  });

  router.get("/audit", requireRole("admin"), (req, res) => {
    const limit = z.coerce.number().int().min(1).max(500).default(200).parse(req.query.limit);
    res.json({ events: listAuditLog(limit) });
  });

  // ---- exchange keys (never returned in plaintext) ----
  router.get("/keys", requireRole("admin"), (_req, res) => {
    res.json({
      binance: hasKeys("binance"),
      bybit: hasKeys("bybit")
    });
  });

  router.post("/keys", requireRole("admin"), (req, res) => {
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

  // ---- Bybit Unified Trading Account collateral + manual debt ----
  router.get("/bybit/uta", requireRole("admin"), uta.status);
  router.post("/bybit/uta/borrow", requireRole("admin"), uta.borrow);
  router.post("/bybit/uta/repay", requireRole("admin"), uta.repay);
  router.post("/bybit/uta/collateral", requireRole("admin"), uta.collateral);

  // ---- notifications ----
  router.get("/notify", requireRole("admin"), (_req, res) => {
    const config = getNotifyConfig();
    res.json({
      telegram: {
        enabled: config.telegram.enabled,
        chatId: config.telegram.chatId,
        hasToken: !!config.telegram.token,
        control: config.telegram.control
      },
      vk: { enabled: config.vk.enabled, peerId: config.vk.peerId, hasToken: !!config.vk.token }
    });
  });

  router.post("/notify", requireRole("admin"), (req, res) => {
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
        chatId: body.telegram?.chatId ?? current.telegram.chatId,
        control: body.telegram?.control ?? current.telegram.control
      },
      vk: {
        enabled: body.vk?.enabled ?? current.vk.enabled,
        token: body.vk?.token || current.vk.token,
        peerId: body.vk?.peerId ?? current.vk.peerId
      }
    };
    setSetting("notify", next, true);
    // Enabling/disabling Telegram in the UI activates/stops control live.
    telegramControl.refresh();
    res.json({ ok: true });
  });

  router.post("/notify/test", requireRole("admin"), async (_req, res) => {
    res.json(await testNotify());
  });

  // Deliver a client-side price alert through the notification channel (Telegram),
  // so an alert reaches the operator even when the browser tab is closed.
  router.post("/notify-alert", requireRole("paper-trade"), async (req, res) => {
    const parsed = z
      .object({
        symbol: z.string().min(1).max(30),
        price: z.number().finite(),
        direction: z.enum(["above", "below"]),
        hitPrice: z.number().finite().optional()
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const { symbol, price, direction, hitPrice } = parsed.data;
    await notify({
      event: "signal",
      bot: "Price alert",
      symbol,
      text: `crossed ${direction} ${price}${hitPrice !== undefined ? ` — now ${hitPrice}` : ""}`
    });
    res.json({ ok: true });
  });

  return { router, wss, engine, telegramControl };
}

function hasKeys(exchange: ExchangeId): boolean {
  const keys = getSetting<ExchangeKeys>(`keys:${exchange}`);
  return !!(keys?.apiKey && keys.apiSecret);
}

function bybitUta(): BybitUtaService {
  const keys = getSetting<ExchangeKeys>("keys:bybit");
  if (!keys?.apiKey || !keys.apiSecret) throw new Error("Bybit API keys are not configured.");
  return new BybitUtaService(new BybitV5Client(keys));
}

function requireRole(required: AuthRole) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (ensureRole(res, required)) next();
  };
}

function ensureRole(res: Response, required: AuthRole): boolean {
  const role = res.locals.authRole as AuthRole | undefined;
  if (roleAllows(role, required)) return true;
  res.status(403).json({ error: `Forbidden — requires ${required} access.` });
  return false;
}

function roleForBot(bot: BotConfig): AuthRole {
  return bot.exchange === "paper" ? "paper-trade" : "live-trade";
}

function auditMutations(req: Request, res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) {
    next();
    return;
  }
  const startedAt = Date.now();
  res.on("finish", () => {
    try {
      insertAuditLog({
        id: randomUUID(),
        actor: String(res.locals.authMode ?? "unknown"),
        role: (res.locals.authRole as AuthRole | undefined) ?? "read-only",
        action: `${req.method.toUpperCase()} ${req.route?.path ?? req.path}`,
        target: routeParamOptional(req, "id") ?? routeParamOptional(req, "orderId"),
        statusCode: res.statusCode,
        ip: req.ip,
        data: {
          params: sanitizeAuditValue(req.params),
          query: sanitizeAuditValue(req.query),
          body: sanitizeAuditValue(req.body)
        },
        ts: startedAt
      });
    } catch {
      // Audit must never break an operator action; failed writes are surfaced by tests/logs.
    }
  });
  next();
}

function sanitizeAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeAuditValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretKey(key) ? "[redacted]" : sanitizeAuditValue(child);
  }
  return out;
}

function isSecretKey(key: string): boolean {
  return /token|secret|apikey|api_key|authorization|password/i.test(key);
}

function routeParam(req: Request, key: string): string {
  return routeParamOptional(req, key) ?? "";
}

function routeParamOptional(req: Request, key: string): string | undefined {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] : value;
}
