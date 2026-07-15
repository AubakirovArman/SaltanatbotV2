import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { clearAuthSession, createAuthSession, isDemoMode, issueWsTicket, requireAuth, roleAllows, roleForToken } from "../auth.js";
import { timeframes } from "../market/timeframes.js";
import type { ProviderRouter } from "../providers/router.js";
import { TradingEngine } from "./engine.js";
import type { TradeEvent } from "./engineEvents.js";
import type { ExchangeKeys } from "./exchange/binance.js";
import { BybitV5Client } from "./exchange/bybitClient.js";
import { BybitUtaService } from "./bybitUta.js";
import { createBybitUtaHandlers } from "./bybitUtaRoutes.js";
import { mutationAuthority, resolveBotRouteIdentity, roleForBot } from "./botRouteIdentity.js";
import { getNotifyConfig, notify, testNotify, type NotifyConfig } from "./notifications.js";
import { TelegramControl } from "./telegramControl.js";
import { deleteBot, deleteSetting, ensureLegacyTradingAccount, getSetting, getTradingAccount, initStore, listAuditLog, listBots, listFills, listLogs, listOrderEvents, listOrderJournal, setSetting, upsertBot } from "./store.js";
import { parseStrategyIR } from "./strategy/irSchema.js";
import type { Timeframe } from "../types.js";
import type { AuthRole, BotConfig, ExchangeId } from "./types.js";
import type { ArbitrageAlertService } from "../arbitrage/alerts.js";
import { registerArbitrageAlertRoutes } from "../arbitrage/alertRoutes.js";
import { ensureSecureTradingOrigin, isSecureTradingOrigin, requireSecureTradingOrigin } from "../secureTradingOrigin.js";
import { liveRiskValidationErrors } from "./liveRisk.js";
import { ensureEmergencyCanRearm, registerEmergencyStopRoutes } from "./emergencyStopRoutes.js";
import { auditTradingMutation } from "./tradingRouteAudit.js";
import { createPaperMultiLegRouter, getPaperMultiLegRuntime, type PaperMultiLegService } from "../arbitrage/paperMultiLeg/index.js";
import { registerResearchAlertRoutes, type ResearchAlertService } from "../arbitrage/researchAlerts/index.js";
import { botTradingAccountId, legacyTradingAccountId, paperTradingAccountId, tradingAccountBindingIssue } from "./tradingAccounts.js";
import { registerTradingAccountIntegrationRoutes, registerTradingAccountRegistryRoutes } from "./tradingAccountRoutes.js";

const timeframeEnum = z.enum(timeframes as [Timeframe, ...Timeframe[]]);

const botBodySchema = z.object({
  id: z.string().optional(),
  accountId: z.string().trim().min(3).max(128).optional(),
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
  // Paper may omit these. Live bots must provide every cap as a positive value.
  maxPositionQuote: z.coerce.number().nonnegative().finite().max(1_000_000_000).optional(),
  maxOrderQuote: z.coerce.number().nonnegative().finite().max(1_000_000_000).optional(),
  maxDailyLossQuote: z.coerce.number().nonnegative().finite().max(1_000_000_000).optional(),
  maxOpenOrders: z.coerce.number().int().nonnegative().max(10_000).optional()
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
  vk: z.object({ enabled: z.boolean().optional(), token: z.string().max(512).optional(), peerId: z.string().max(64).optional() }).optional()
});

export interface TradingApi {
  router: Router;
  wss: WebSocketServer;
  engine: TradingEngine;
  /** Inbound Telegram control channel — start()/stop() from the server lifecycle. */
  telegramControl: TelegramControl;
}

export interface TradingApiOptions {
  emergencyAdapters?: () => Iterable<import("./types.js").ExchangeAdapter>;
  paperMultiLeg?: PaperMultiLegService | false;
  researchAlerts?: ResearchAlertService;
}

export function createTradingApi(provider: ProviderRouter, arbitrageAlerts?: ArbitrageAlertService, options: TradingApiOptions = {}): TradingApi {
  initStore();

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
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

  const engine = new TradingEngine(provider, broadcast, options.emergencyAdapters);
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
  const paperMultiLeg = options.paperMultiLeg === false ? undefined : (options.paperMultiLeg ?? (process.env.NODE_ENV === "test" ? undefined : getPaperMultiLegRuntime()));

  router.post("/session", (req, res) => {
    const parsed = sessionBodySchema.safeParse(req.body);
    const role = parsed.success ? roleForToken(parsed.data.token) : undefined;
    if (!parsed.success || !role) {
      res.status(401).json({ error: "Unauthorized — a valid access token is required." });
      return;
    }
    const session = createAuthSession(res, role);
    res.json({ ok: true, demo: isDemoMode(), liveTradingEnabled: liveEnabled(), secureTradingOrigin: isSecureTradingOrigin(req), role: session.role, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
  });

  // Public status probe for the Trade tab. It avoids a noisy browser-console 401
  // on first load, while every actual trading endpoint below remains gated.
  router.get("/auth", (req, res) => {
    if (!req.headers.authorization && !req.headers.cookie) {
      res.json({ ok: false, demo: isDemoMode(), liveTradingEnabled: false, secureTradingOrigin: isSecureTradingOrigin(req) });
      return;
    }
    requireAuth(req, res, () => {
      res.json({ ok: true, demo: isDemoMode(), liveTradingEnabled: liveEnabled(), secureTradingOrigin: isSecureTradingOrigin(req), role: res.locals.authRole, csrfToken: res.locals.csrfToken });
    });
  });

  router.use(requireAuth);
  router.use(auditTradingMutation);

  router.delete("/session", (req, res) => {
    clearAuthSession(req, res);
    res.json({ ok: true });
  });

  router.post("/ws-ticket", (_req, res) => {
    res.json(issueWsTicket());
  });

  router.get("/settings", (req, res) => {
    res.json({ demo: isDemoMode(), liveTradingEnabled: liveEnabled(), secureTradingOrigin: isSecureTradingOrigin(req), role: res.locals.authRole });
  });

  registerTradingAccountRegistryRoutes(router, requireRole("admin"));

  router.post("/settings", requireRole("admin"), (req, res) => {
    const parsed = z.object({ liveTradingEnabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    if (parsed.data.liveTradingEnabled && !ensureSecureTradingOrigin(req, res)) return;
    if (isDemoMode() && parsed.data.liveTradingEnabled) {
      res.status(403).json({ error: "Live trading is disabled in DEMO_MODE." });
      return;
    }
    if (parsed.data.liveTradingEnabled && !ensureEmergencyCanRearm(engine, res)) return;
    setSetting("liveTradingEnabled", parsed.data.liveTradingEnabled);
    res.json({ liveTradingEnabled: parsed.data.liveTradingEnabled });
  });

  registerEmergencyStopRoutes(router, engine, requireRole("live-trade"));

  router.get("/bots", (_req, res) => {
    res.json({ bots: listBots().map(withStatus) });
  });

  // Cross-bot portfolio: live account equity/positions/orders (deduped by
  // account+market) plus today's realized PnL. Fail-safe — never throws.
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
    const existing = body.id ? listBots().find((bot) => bot.id === body.id) : undefined;
    const { runtime, role, secureOrigin } = mutationAuthority(engine, existing, body.id, body.exchange);
    if (!ensureRole(res, role)) return;
    if (secureOrigin && !ensureSecureTradingOrigin(req, res)) return;
    if (runtime) {
      res.status(409).json({ error: "Stop the running bot before changing its configuration." });
      return;
    }
    if (isDemoMode() && body.exchange !== "paper") {
      res.status(403).json({ error: "Only paper trading is available in DEMO_MODE." });
      return;
    }
    const liveRiskErrors = liveRiskValidationErrors(body);
    if (liveRiskErrors.length) {
      res.status(400).json({ error: `Live risk limits are incomplete: ${liveRiskErrors.join("; ")}` });
      return;
    }
    // Reject any IR that isn't a known node shape before it can be persisted/executed.
    const irResult = parseStrategyIR(body.ir);
    if (!irResult.ok) {
      res.status(400).json({ error: `Invalid strategy IR: ${irResult.error}` });
      return;
    }
    const id = body.id ?? randomUUID();
    let accountId: string;
    if (body.exchange === "paper") {
      accountId = paperTradingAccountId(id);
    } else {
      accountId = body.accountId ?? (existing?.exchange === body.exchange ? existing.accountId : undefined) ?? legacyTradingAccountId(body.exchange);
      if (!body.accountId && accountId === legacyTradingAccountId(body.exchange)) ensureLegacyTradingAccount(body.exchange);
      const issue = tradingAccountBindingIssue({ id, exchange: body.exchange, accountId }, getTradingAccount(accountId));
      if (issue) {
        res.status(409).json({ error: issue.message, code: issue.code });
        return;
      }
    }
    const now = Date.now();
    const bot: BotConfig = {
      id,
      accountId,
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
      maxOrderQuote: body.maxOrderQuote,
      maxDailyLossQuote: body.maxDailyLossQuote,
      maxOpenOrders: body.maxOpenOrders,
      status: "stopped",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    upsertBot(bot);
    res.json({ bot: withStatus(bot) });
  });

  router.delete("/bots/:id", requireRole("admin"), async (req, res) => {
    const id = routeParam(req, "id");
    try {
      await engine.stopSafely(id);
      deleteBot(id);
      res.json({ ok: true });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : "Failed to stop bot before deletion" });
    }
  });

  router.post("/bots/:id/start", async (req, res) => {
    const id = routeParam(req, "id");
    const bot = resolveBotRouteIdentity(engine, listBots(), id);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    if (!ensureRole(res, roleForBot(bot))) return;
    // Live trading is double-gated: a global arm flag AND per-request confirmation.
    if (bot.exchange !== "paper") {
      if (!ensureSecureTradingOrigin(req, res)) return;
      const issue = tradingAccountBindingIssue(bot, getTradingAccount(botTradingAccountId(bot)));
      if (issue) {
        res.status(409).json({ error: issue.message, code: issue.code });
        return;
      }
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

  router.post("/bots/:id/stop", async (req, res) => {
    const id = routeParam(req, "id");
    const bot = resolveBotRouteIdentity(engine, listBots(), id);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    if (!ensureRole(res, roleForBot(bot))) return;
    try {
      await engine.stopSafely(id);
      res.json({ ok: true });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : "Failed to stop bot" });
    }
  });

  // Clear the pause set by the resume staleness gate (bot resumed with stale
  // open-position/counter state) and let it trade again.
  router.post("/bots/:id/confirm-resume", async (req, res) => {
    const id = routeParam(req, "id");
    const bot = resolveBotRouteIdentity(engine, listBots(), id);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    if (!ensureRole(res, roleForBot(bot))) return;
    if (bot.exchange !== "paper" && !ensureSecureTradingOrigin(req, res)) return;
    res.json({ ok: await engine.confirmResume(id) });
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
    const bot = resolveBotRouteIdentity(engine, listBots(), id);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    if (!ensureRole(res, roleForBot(bot))) return;
    if (bot.exchange !== "paper" && parsed.data.dryRun !== true && !ensureSecureTradingOrigin(req, res)) return;
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

  registerTradingAccountIntegrationRoutes(router, requireRole("admin"), uta);

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

  // A threshold crossing discovered by the public screener may be forwarded only by an
  // authenticated paper-trade operator. It remains a notification and never places orders.
  router.post("/notify-arbitrage", requireRole("paper-trade"), async (req, res) => {
    const parsed = z
      .object({
        symbol: z.string().regex(/^[A-Z0-9]{2,20}USDT$/),
        spotExchange: z.enum(["binance", "bybit"]),
        futuresExchange: z.enum(["binance", "bybit"]),
        netEdgeBps: z.number().finite().min(-10_000).max(10_000),
        minimumNetEdgeBps: z.number().finite().min(-10_000).max(10_000)
      })
      .refine((value) => value.spotExchange !== value.futuresExchange)
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const value = parsed.data;
    await notify({
      event: "signal",
      bot: "Arbitrage screener",
      symbol: value.symbol,
      text: `${value.spotExchange} spot → ${value.futuresExchange} perpetual · net ${(value.netEdgeBps / 100).toFixed(3)}% crossed ${(value.minimumNetEdgeBps / 100).toFixed(3)}%`
    });
    res.json({ ok: true });
  });

  registerArbitrageAlertRoutes(router, arbitrageAlerts, requireRole("paper-trade"));
  registerResearchAlertRoutes(router, options.researchAlerts, requireRole("paper-trade"));
  if (paperMultiLeg) router.use("/paper-multi-leg", requireRole("paper-trade"), createPaperMultiLegRouter(paperMultiLeg));

  return { router, wss, engine, telegramControl };
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

function routeParam(req: Request, key: string): string {
  return routeParamOptional(req, key) ?? "";
}

function routeParamOptional(req: Request, key: string): string | undefined {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] : value;
}
