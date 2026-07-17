import type { IncomingMessage } from "node:http";
import { isDeepStrictEqual } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import type { Pool } from "pg";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { clearAuthSession, createAuthSession, isDatabaseAuthMode, issueWsTicketForRequest, requireAuth, revalidateTradingAuthorization, roleAllows, roleForToken } from "../auth.js";
import type { IdentityPrincipal } from "../identity/types.js";
import type { IdentityService } from "../identity/service.js";
import { PostgresExecutorCommandRepository } from "../database/index.js";
import type { ProviderRouter } from "../providers/router.js";
import { TradingEngine } from "./engine.js";
import type { TradeEvent } from "./engineEvents.js";
import type { ExchangeKeys } from "./exchange/binance.js";
import { BybitV5Client } from "./exchange/bybitClient.js";
import { DENY_SIGNED_REQUEST_AUTHORIZER } from "./exchange/signedRequestGate.js";
import { BybitUtaService } from "./bybitUta.js";
import { roleForBot } from "./botRouteIdentity.js";
import { TelegramControl } from "./telegramControl.js";
import {
  closeStore,
  disarmAllLiveTradingSettings,
  getBotForOwner,
  getTradingAccountCredentialsForOwner,
  getTradingAccountForOwner,
  getTradingOwnerAuthorityForOwner,
  initStore,
  LEGACY_TRADING_OWNER_ID,
  listAuditLogForOwner,
  listBotsForOwner,
  listFillsForOwner,
  listLogsForOwner,
  listOrderEventsForOwner,
  listOrderJournalForOwner,
  setTradingOwnerArmedForOwner
} from "./store.js";
import type { AuthRole, BotConfig, ExchangeId, ExecOrder } from "./types.js";
import type { ArbitrageAlertService } from "../arbitrage/alerts.js";
import { registerArbitrageAlertRoutes } from "../arbitrage/alertRoutes.js";
import { ensureSecureTradingOrigin, isSecureTradingOrigin, requireSecureTradingOrigin } from "../secureTradingOrigin.js";
import { ensureEmergencyCanRearm, registerEmergencyStopRoutes } from "./emergencyStopRoutes.js";
import { auditTradingMutation } from "./tradingRouteAudit.js";
import { createPaperMultiLegRouter, getPaperMultiLegRuntime, type PaperMultiLegService } from "../arbitrage/paperMultiLeg/index.js";
import { registerResearchAlertRoutes, type ResearchAlertService } from "../arbitrage/researchAlerts/index.js";
import { botTradingAccountId, tradingAccountBindingIssue } from "./tradingAccounts.js";
import { registerTradingAccountIntegrationRoutes, registerTradingAccountRegistryRoutes } from "./tradingAccountRoutes.js";
import { tradingOwnerFromResponse } from "./ownership.js";
import { TradeStreamHub } from "./tradeStreamHub.js";
import { registerNotificationRoutes } from "./notificationRoutes.js";
import { registerBotLifecycleMutationRoutes } from "./botLifecycleMutationRoutes.js";
import { isTradingResourceQuotaError, loadTradingResourceLimits, type TradingResourceLimits } from "./resourceQuotas.js";
import { pausedOrderAllowed } from "./managedExecution.js";
import { getRuntimePolicy, isPaperOnlyRuntime, paperOnlyErrorBody, runtimeProfilePublicState, type RuntimePolicy } from "../runtimeProfile.js";
import { createPaperPortfolioRuntime } from "./paperPortfolioRuntime.js";
import { registerPaperPortfolioRoutes } from "./paperPortfolioRoutes.js";
import { formatMicros } from "./paperPortfolioProjectionStore.js";

const commandBodySchema = z.object({
  command: z.string().min(1).max(2000),
  dryRun: z.boolean().optional()
});

const sessionBodySchema = z.object({
  token: z.string().trim().min(1).max(512)
});

export interface TradingApi {
  router: Router;
  wss: WebSocketServer;
  engine: TradingEngine;
  /** Inbound Telegram control channel — start()/stop() from the server lifecycle. */
  telegramControl: TelegramControl;
  /** Revoke every private stream for a tenant after disable/role change. */
  disconnectOwner(ownerUserId: string, reason?: string): void;
  /** Revoke private streams issued by one logged-out browser session. */
  disconnectSession(sessionIdHash: string, reason?: string): void;
  /** Disconnect, disarm live trading and quiesce only this owner's runtimes. */
  revokeOwnerAccess(ownerUserId: string): Promise<void>;
  /** Allow starts again after an explicit trading grant. */
  restoreOwnerAccess(ownerUserId: string): void;
  /** Release the process-lifetime SQLite store and coordination lock. */
  start(): Promise<void>;
  quiesce(): void;
  executorReady(): boolean;
  close(): Promise<void>;
}

export interface TradingApiOptions {
  emergencyAdapters?: (ownerUserId: string) => Iterable<import("./types.js").ExchangeAdapter>;
  paperMultiLeg?: PaperMultiLegService | false;
  researchAlerts?: ResearchAlertService;
  /** Concrete database user that receives pre-tenant SQLite rows. */
  legacyOwnerUserId?: string;
  /** Inbound Telegram commands are single-operator only until the poller is tenant/session aware. */
  telegramControlEnabled?: boolean;
  /** Per-owner hard caps. Environment defaults are loaded when omitted. */
  resourceLimits?: TradingResourceLimits;
  /** Immutable process execution boundary; production resolves it once at boot. */
  runtimePolicy?: RuntimePolicy;
  /** PostgreSQL control plane for durable cross-store paper commands. */
  executorCommandPool?: Pool;
  identityService?: IdentityService;
}

interface OwnerAccessRevocationOperations {
  disconnect(): void;
  stopAndSuspend(): Promise<unknown>;
  disarm(): void;
}

/** Run every fail-closed revocation step even when durable disarm persistence fails. */
export async function revokeTradingOwnerAccess(ownerUserId: string, operations: OwnerAccessRevocationOperations): Promise<void> {
  const failures: unknown[] = [];
  try {
    operations.disconnect();
  } catch (error) {
    failures.push(error);
  }
  let stopping: Promise<unknown> | undefined;
  try {
    // The engine implementation suspends starts synchronously before returning.
    stopping = operations.stopAndSuspend();
  } catch (error) {
    failures.push(error);
  }
  try {
    operations.disarm();
  } catch (error) {
    failures.push(error);
  }
  if (stopping) {
    try {
      await stopping;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, `Could not fully revoke trading access for ${ownerUserId}`);
}

export function createTradingApi(provider: ProviderRouter, arbitrageAlerts?: ArbitrageAlertService, options: TradingApiOptions = {}): TradingApi {
  const tradingDatabase = initStore({ legacyOwnerUserId: options.legacyOwnerUserId });
  const runtimePolicy = options.runtimePolicy ?? getRuntimePolicy();
  if (isPaperOnlyRuntime(runtimePolicy)) disarmAllLiveTradingSettings();
  const resourceLimits = options.resourceLimits ?? loadTradingResourceLimits();

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const tradeStream = new TradeStreamHub();
  wss.on("connection", (socket, request) => {
    const principal = (request as IncomingMessage & { authPrincipal?: IdentityPrincipal }).authPrincipal;
    if (isDatabaseAuthMode() && !principal) {
      socket.close(1008, "Authenticated trading principal is required");
      return;
    }
    tradeStream.attach(socket, principal?.user.id ?? LEGACY_TRADING_OWNER_ID, principal?.expiresAt.getTime(), principal?.sessionIdHash);
  });

  const engine = new TradingEngine(provider, (event: TradeEvent) => tradeStream.publish(event), options.emergencyAdapters, resourceLimits, runtimePolicy);
  const paperPortfolios = createPaperPortfolioRuntime({
    database: tradingDatabase,
    engine,
    ...(options.executorCommandPool ? { executorCommands: new PostgresExecutorCommandRepository(options.executorCommandPool) } : {}),
    ...(options.identityService ? { identityService: options.identityService } : {})
  });
  const telegramControl = new TelegramControl(engine, options.legacyOwnerUserId ?? LEGACY_TRADING_OWNER_ID, options.telegramControlEnabled ?? !isDatabaseAuthMode(), runtimePolicy);
  const router = Router();

  const withStatus = (ownerUserId: string, bot: BotConfig) => {
    const { ownerUserId: _privateOwner, paperAllocationMicros, ...publicBot } = bot;
    return {
      ...publicBot,
      ...(paperAllocationMicros === undefined ? {} : { paperAllocation: formatMicros(paperAllocationMicros) }),
      status: engine.isRunningForOwner(ownerUserId, bot.id) ? "running" as const : "stopped" as const
    };
  };

  const liveEnabled = (ownerUserId: string) => runtimePolicy.liveBotConfigsAllowed && getTradingOwnerAuthorityForOwner(ownerUserId).armed;
  const runtimeState = runtimeProfilePublicState(runtimePolicy);
  const paperMultiLeg = options.paperMultiLeg === false ? undefined : (options.paperMultiLeg ?? (process.env.NODE_ENV === "test" ? undefined : getPaperMultiLegRuntime()));

  router.post("/session", (req, res) => {
    if (isDatabaseAuthMode()) {
      res.status(404).json({ error: "Token login is disabled. Use /api/auth/login.", code: "token_login_disabled" });
      return;
    }
    const parsed = sessionBodySchema.safeParse(req.body);
    const role = parsed.success ? roleForToken(parsed.data.token) : undefined;
    if (!parsed.success || !role) {
      res.status(401).json({ error: "Unauthorized — a valid access token is required." });
      return;
    }
    const session = createAuthSession(res, role);
    res.json({ ok: true, demo: isPaperOnlyRuntime(runtimePolicy), ...runtimeState, liveTradingEnabled: liveEnabled(LEGACY_TRADING_OWNER_ID), secureTradingOrigin: isSecureTradingOrigin(req), role: session.role, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
  });

  // Public status probe for the Trade tab. It avoids a noisy browser-console 401
  // on first load, while every actual trading endpoint below remains gated.
  router.get("/auth", (req, res) => {
    if (!req.headers.authorization && !req.headers.cookie) {
      res.json({ ok: false, demo: isPaperOnlyRuntime(runtimePolicy), ...runtimeState, liveTradingEnabled: false, secureTradingOrigin: isSecureTradingOrigin(req) });
      return;
    }
    requireAuth(req, res, () => {
      const ownerUserId = tradingOwnerFromResponse(res);
      res.json({ ok: true, demo: isPaperOnlyRuntime(runtimePolicy), ...runtimeState, liveTradingEnabled: liveEnabled(ownerUserId), secureTradingOrigin: isSecureTradingOrigin(req), role: res.locals.authRole, csrfToken: res.locals.csrfToken });
    });
  });

  router.use(requireAuth);
  router.use(auditTradingMutation);

  router.delete("/session", async (req, res) => {
    await clearAuthSession(req, res);
    res.json({ ok: true });
  });

  router.post("/ws-ticket", async (req, res, next) => {
    try {
      res.json(await issueWsTicketForRequest(req, res));
    } catch (error) {
      next(error);
    }
  });

  router.get("/settings", (req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    res.json({ demo: isPaperOnlyRuntime(runtimePolicy), ...runtimeState, liveTradingEnabled: liveEnabled(ownerUserId), secureTradingOrigin: isSecureTradingOrigin(req), role: res.locals.authRole });
  });

  registerPaperPortfolioRoutes(router, paperPortfolios.reads, paperPortfolios.commands);
  registerTradingAccountRegistryRoutes(router, requireRole("live-trade"), {
    isBotRunning: (ownerUserId, botId) => engine.isRunningForOwner(ownerUserId, botId),
    maxAccountsPerOwner: resourceLimits.maxAccountsPerOwner,
    withAccountLifecycleLock: (ownerUserId, accountId, operation) => engine.withAccountLifecycleLock(ownerUserId, accountId, operation),
    runtimePolicy
  });

  router.post("/settings", requireRole("live-trade"), (req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    const parsed = z.object({ liveTradingEnabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    if (parsed.data.liveTradingEnabled && isPaperOnlyRuntime(runtimePolicy)) return void rejectPaperOnly(res, "live trading arm");
    if (parsed.data.liveTradingEnabled && !ensureSecureTradingOrigin(req, res)) return;
    if (parsed.data.liveTradingEnabled && !ensureEmergencyCanRearm(engine, res, ownerUserId)) return;
    const authority = setTradingOwnerArmedForOwner(ownerUserId, parsed.data.liveTradingEnabled);
    res.json({ liveTradingEnabled: authority.armed });
  });

  registerEmergencyStopRoutes(router, engine, requireRole("live-trade"));

  router.get("/bots", (_req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    res.json({ bots: listBotsForOwner(ownerUserId).map((bot) => withStatus(ownerUserId, bot)) });
  });

  // Cross-bot portfolio: live account equity/positions/orders (deduped by
  // account+market) plus today's realized PnL. Fail-safe — never throws.
  router.get("/portfolio", async (_req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    try {
      res.json(await engine.portfolio(ownerUserId));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "portfolio failed" });
    }
  });

  registerBotLifecycleMutationRoutes(router, engine, {
    view: withStatus,
    maxBotsPerOwner: resourceLimits.maxBotsPerOwner,
    runtimePolicy,
    paperPortfolioCommands: paperPortfolios.commands
  });

  router.post("/bots/:id/start", async (req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    const id = routeParam(req, "id");
    const bot = ownedBot(engine, ownerUserId, id);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    const requiredRole = roleForBot(bot);
    if (!ensureRole(res, requiredRole)) return;
    if (!canonicalPaperMutationRoute(res, bot)) return;
    // Live trading is double-gated: a global arm flag AND per-request confirmation.
    if (bot.exchange !== "paper") {
      if (isPaperOnlyRuntime(runtimePolicy)) return void rejectPaperOnly(res, "live bot start");
      if (!ensureSecureTradingOrigin(req, res)) return;
      const issue = tradingAccountBindingIssue(bot, getTradingAccountForOwner(ownerUserId, botTradingAccountId(bot)));
      if (issue) {
        res.status(409).json({ error: issue.message, code: issue.code });
        return;
      }
      if (!liveEnabled(ownerUserId)) {
        res.status(403).json({ error: "Live trading is not armed. Enable it in Trade settings first." });
        return;
      }
      if ((req.body as { confirmLive?: boolean })?.confirmLive !== true) {
        res.status(428).json({ error: "Live start requires confirmLive:true.", needsConfirm: true });
        return;
      }
    }
    const authorization = await revalidateTradingAuthorization(res, requiredRole);
    if (!authorization) return;
    try {
      const preflight = async () => {
        if (bot.exchange === "bybit" && bot.market === "futures" && bot.bybitCrossCollateral) {
          const snapshot = await bybitUta(ownerUserId, botTradingAccountId(bot)).snapshot();
          if (!snapshot.risk.entryAllowed) throw new Error(`Bybit UTA risk guard blocked start: ${snapshot.risk.reasons.join("; ")}`);
          if (!snapshot.assets.some((asset) => asset.collateralEnabled && asset.usdValue > 0)) {
            throw new Error("Bybit cross-collateral mode requires a funded collateral asset to be enabled.");
          }
        }
        if (!authorization.assertCurrent()) throw new Error("Trading authorization changed while the bot start was queued.");
      };
      const override = (req.body as { override?: boolean })?.override === true;
      const validateCurrent = () => {
        if (!isDeepStrictEqual(getBotForOwner(ownerUserId, id), bot)) throw new Error("Bot configuration changed while start was queued. Retry with the current configuration.");
        if (!authorization.assertCurrent()) throw new Error("Trading authorization changed while the bot start was queued.");
      };
      await engine.startForOwner(ownerUserId, bot, { override, preflight, validateCurrent });
      res.json({ ok: true, bot: withStatus(ownerUserId, bot) });
    } catch (error) {
      if (res.headersSent) return;
      if (isTradingResourceQuotaError(error)) {
        res.status(429).json({ error: error.message, code: error.code, limit: error.limit });
        return;
      }
      res.status(400).json({ error: error instanceof Error ? error.message : "Failed to start" });
    }
  });

  router.post("/bots/:id/stop", async (req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    const id = routeParam(req, "id");
    const bot = ownedBot(engine, ownerUserId, id);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    if (!ensureRole(res, roleForBot(bot))) return;
    if (!canonicalPaperMutationRoute(res, bot)) return;
    try {
      await engine.stopSafelyForOwner(ownerUserId, id);
      res.json({ ok: true });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : "Failed to stop bot" });
    }
  });

  // Clear the pause set by the resume staleness gate (bot resumed with stale
  // open-position/counter state) and let it trade again.
  router.post("/bots/:id/confirm-resume", async (req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    const id = routeParam(req, "id");
    const bot = ownedBot(engine, ownerUserId, id);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    const requiredRole = roleForBot(bot);
    if (!ensureRole(res, requiredRole)) return;
    if (!canonicalPaperMutationRoute(res, bot)) return;
    if (bot.exchange !== "paper" && isPaperOnlyRuntime(runtimePolicy)) return void rejectPaperOnly(res, "live bot resume");
    if (bot.exchange !== "paper" && !ensureSecureTradingOrigin(req, res)) return;
    const authorization = await revalidateTradingAuthorization(res, requiredRole);
    if (!authorization) return;
    const ok = await engine.confirmResumeForOwner(ownerUserId, id, () => authorization.assertCurrent());
    if (!res.headersSent) res.json({ ok });
  });

  router.post("/bots/:id/command", async (req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    const parsed = commandBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const id = routeParam(req, "id");
    const bot = ownedBot(engine, ownerUserId, id);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    const requiredRole = roleForBot(bot);
    if (!ensureRole(res, requiredRole)) return;
    const dryRun = parsed.data.dryRun === true;
    if (!dryRun && !canonicalPaperMutationRoute(res, bot)) return;
    if (bot.exchange !== "paper" && !dryRun && isPaperOnlyRuntime(runtimePolicy)) return void rejectPaperOnly(res, "live bot command");
    if (bot.exchange !== "paper" && !dryRun && !ensureSecureTradingOrigin(req, res)) return;
    const authorization = dryRun ? undefined : await revalidateTradingAuthorization(res, requiredRole);
    if (!dryRun && !authorization) return;
    const authorize = authorization ? (order: ExecOrder) => pausedOrderAllowed(order) || authorization.assertCurrent() : undefined;
    const result = await engine.manualCommandForOwner(ownerUserId, id, parsed.data.command, dryRun, authorize);
    if (!res.headersSent) res.json(result);
  });

  router.get("/bots/:id/fills", (req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    const id = routeParam(req, "id");
    if (!ownedBot(engine, ownerUserId, id)) return void res.status(404).json({ error: "Bot not found" });
    res.json({ fills: listFillsForOwner(ownerUserId, id, 200) });
  });

  router.get("/bots/:id/logs", (req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    const id = routeParam(req, "id");
    if (!ownedBot(engine, ownerUserId, id)) return void res.status(404).json({ error: "Bot not found" });
    res.json({ logs: listLogsForOwner(ownerUserId, id, 200) });
  });

  router.get("/bots/:id/live", async (req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    const id = routeParam(req, "id");
    if (!ownedBot(engine, ownerUserId, id)) return void res.status(404).json({ error: "Bot not found" });
    res.json((await engine.liveStateForOwner(ownerUserId, id)) ?? { price: 0 });
  });

  router.get("/bots/:id/orders", async (req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    const id = routeParam(req, "id");
    if (!ownedBot(engine, ownerUserId, id)) return void res.status(404).json({ error: "Bot not found" });
    res.json({ orders: await engine.ordersForOwner(ownerUserId, id) });
  });

  router.get("/bots/:id/order-journal", (req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    const id = routeParam(req, "id");
    if (!ownedBot(engine, ownerUserId, id)) return void res.status(404).json({ error: "Bot not found" });
    res.json({ orders: listOrderJournalForOwner(ownerUserId, id, 200) });
  });

  router.get("/bots/:id/order-journal/:orderId/events", (req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    const botId = routeParam(req, "id");
    if (!ownedBot(engine, ownerUserId, botId)) return void res.status(404).json({ error: "Bot not found" });
    res.json({ events: listOrderEventsForOwner(ownerUserId, botId, routeParam(req, "orderId"), 500) });
  });

  router.get("/audit", (req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    const limit = z.coerce.number().int().min(1).max(500).default(200).parse(req.query.limit);
    res.json({ events: listAuditLogForOwner(ownerUserId, limit) });
  });

  registerTradingAccountIntegrationRoutes(router, requireRole("live-trade"), { liveEnabled, runtimePolicy });

  registerNotificationRoutes(router, requireRole, telegramControl);

  const requireLegacyOperatorResearch = requireLegacyOperatorRole("admin", options.legacyOwnerUserId);
  registerArbitrageAlertRoutes(router, arbitrageAlerts, requireLegacyOperatorResearch);
  registerResearchAlertRoutes(router, options.researchAlerts, requireLegacyOperatorResearch);
  if (paperMultiLeg) router.use("/paper-multi-leg", requireLegacyOperatorResearch, createPaperMultiLegRouter(paperMultiLeg));

  return {
    router,
    wss,
    engine,
    telegramControl,
    disconnectOwner: (ownerUserId, reason) => tradeStream.disconnectOwner(ownerUserId, reason),
    disconnectSession: (sessionIdHash, reason) => tradeStream.disconnectSession(sessionIdHash, reason),
    revokeOwnerAccess: (ownerUserId) =>
      revokeTradingOwnerAccess(ownerUserId, {
        disconnect: () => tradeStream.disconnectOwner(ownerUserId),
        stopAndSuspend: () => engine.stopOwnerSafely(ownerUserId),
        disarm: () => setTradingOwnerArmedForOwner(ownerUserId, false)
      }),
    restoreOwnerAccess: (ownerUserId) => engine.resumeOwnerStarts(ownerUserId),
    start: () => paperPortfolios.start(),
    quiesce: () => paperPortfolios.quiesce(),
    executorReady: () => paperPortfolios.ready(),
    close: async () => {
      paperPortfolios.quiesce();
      const executor = await paperPortfolios.close();
      if (!executor.drained) throw new Error("Paper executor did not stop; refusing to close its engine or SQLite store");
      try { engine.shutdown(); } finally { closeStore(); }
    }
  };
}

function rejectPaperOnly(res: Response, operation: string): void {
  res.status(403).json(paperOnlyErrorBody(operation));
}

function requireLegacyOperatorRole(required: AuthRole, legacyOwnerUserId?: string) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (!ensureRole(res, required)) return;
    const ownerUserId = tradingOwnerFromResponse(res);
    if (legacyOperatorSurfaceAllowed(isDatabaseAuthMode(), ownerUserId, legacyOwnerUserId)) {
      next();
      return;
    }
    res.status(403).json({
      error: "This legacy research surface is available only to its migrated owner until tenant-scoped storage is delivered.",
      code: "owner_scoped_surface_pending"
    });
  };
}

export function legacyOperatorSurfaceAllowed(
  databaseAuth: boolean,
  ownerUserId: string,
  legacyOwnerUserId?: string
): boolean {
  return !databaseAuth || ownerUserId === (legacyOwnerUserId ?? LEGACY_TRADING_OWNER_ID);
}

function bybitUta(ownerUserId: string, accountId: string): BybitUtaService {
  const keys = getTradingAccountCredentialsForOwner<ExchangeKeys>(ownerUserId, accountId);
  if (!keys?.apiKey || !keys.apiSecret) throw new Error("Bybit API keys are not configured.");
  return new BybitUtaService(new BybitV5Client(keys, "futures", DENY_SIGNED_REQUEST_AUTHORIZER));
}

function ownedBot(engine: TradingEngine, ownerUserId: string, id: string): BotConfig | undefined {
  return engine.runtimeConfigForOwner(ownerUserId, id) ?? getBotForOwner(ownerUserId, id);
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

function canonicalPaperMutationRoute(res: Response, bot: BotConfig): boolean {
  if (!isDatabaseAuthMode() || bot.exchange !== "paper") return true;
  res.status(409).json({
    error: "Use the canonical paper portfolio action endpoint for this robot.",
    code: "paper_portfolio_command_required"
  });
  return false;
}

function routeParam(req: Request, key: string): string {
  return routeParamOptional(req, key) ?? "";
}

function routeParamOptional(req: Request, key: string): string | undefined {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] : value;
}
