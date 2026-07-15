import { randomUUID } from "node:crypto";
import type { Response, Router } from "express";
import { z } from "zod";
import { isDemoMode, roleAllows } from "../auth.js";
import { timeframes } from "../market/timeframes.js";
import { ensureSecureTradingOrigin } from "../secureTradingOrigin.js";
import type { Timeframe } from "../types.js";
import { mutationAuthority, roleForBot } from "./botRouteIdentity.js";
import type { TradingEngine } from "./engine.js";
import { liveRiskValidationErrors } from "./liveRisk.js";
import { tradingOwnerFromResponse } from "./ownership.js";
import {
  deleteBotForOwner,
  deleteSetting,
  getBotForOwner,
  getBotOwnerUserId,
  getTradingAccountForOwner,
  upsertBotForOwner
} from "./store.js";
import { parseStrategyIR } from "./strategy/irSchema.js";
import { paperTradingAccountId, tradingAccountBindingIssue } from "./tradingAccounts.js";
import type { AuthRole, BotConfig, ExchangeId } from "./types.js";

const botBodySchema = z.object({
  id: z.string().optional(),
  accountId: z.string().trim().min(3).max(128).optional(),
  name: z.string().max(120).optional(),
  strategyName: z.string().max(120).optional(),
  ir: z.unknown(),
  symbol: z.string().min(1).max(30),
  timeframe: z.enum(timeframes as [Timeframe, ...Timeframe[]]),
  exchange: z.enum(["paper", "binance", "bybit"]).default("paper"),
  market: z.enum(["spot", "futures"]).default("spot"),
  sizeMode: z.enum(["quote", "base", "equity_pct", "risk_pct"]).default("quote"),
  sizeValue: z.coerce.number().positive().finite().max(1_000_000_000),
  leverage: z.coerce.number().int().min(1).max(125).default(1),
  bybitCrossCollateral: z.boolean().default(false),
  notifyMarkers: z.boolean().default(false),
  maxPositionQuote: z.coerce.number().nonnegative().finite().max(1_000_000_000).optional(),
  maxOrderQuote: z.coerce.number().nonnegative().finite().max(1_000_000_000).optional(),
  maxDailyLossQuote: z.coerce.number().nonnegative().finite().max(1_000_000_000).optional(),
  maxOpenOrders: z.coerce.number().int().nonnegative().max(10_000).optional()
});

interface BotLifecycleRouteOptions {
  view(ownerUserId: string, bot: BotConfig): Omit<BotConfig, "ownerUserId">;
}

export function registerBotLifecycleMutationRoutes(router: Router, engine: TradingEngine, options: BotLifecycleRouteOptions): void {
  router.post("/bots", async (req, res) => {
    const parsed = botBodySchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
    const ownerUserId = tradingOwnerFromResponse(res);
    const body = parsed.data;
    const id = body.id ?? randomUUID();
    const mutation = async () => {
      const persistedOwner = body.id ? getBotOwnerUserId(id) : undefined;
      if (persistedOwner && persistedOwner !== ownerUserId) return void res.status(404).json({ error: "Bot not found" });
      const existing = body.id ? getBotForOwner(ownerUserId, id) : undefined;
      if (body.id && !existing) return void res.status(400).json({ error: "Bot ids are assigned by the server.", code: "BOT_ID_SERVER_MANAGED" });
      const { runtime, role, secureOrigin } = mutationAuthority(engine, ownerUserId, existing, body.id, body.exchange);
      if (!ensureRole(res, role) || (secureOrigin && !ensureSecureTradingOrigin(req, res))) return;
      if (runtime) return void res.status(409).json({ error: "Stop the running bot before changing its configuration." });
      if (isDemoMode() && body.exchange !== "paper") return void res.status(403).json({ error: "Only paper trading is available in DEMO_MODE." });
      const liveRiskErrors = liveRiskValidationErrors(body);
      if (liveRiskErrors.length) return void res.status(400).json({ error: `Live risk limits are incomplete: ${liveRiskErrors.join("; ")}` });
      const irResult = parseStrategyIR(body.ir);
      if (!irResult.ok) return void res.status(400).json({ error: `Invalid strategy IR: ${irResult.error}` });
      const persist = async () => {
        const accountId = resolveAccountId(res, ownerUserId, id, body, existing);
        if (!accountId) return;
        const now = Date.now();
        const bot: BotConfig = {
          id,
          ownerUserId,
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
          updatedAt: Math.max(now, (existing?.updatedAt ?? 0) + 1)
        };
        upsertBotForOwner(ownerUserId, bot);
        res.json({ bot: options.view(ownerUserId, bot) });
      };
      const targetAccountId = body.exchange === "paper" ? undefined : (body.accountId ?? (existing?.exchange === body.exchange ? existing.accountId : undefined));
      if (targetAccountId) await engine.withAccountLifecycleLock(ownerUserId, targetAccountId, persist);
      else await persist();
    };
    if (body.id) await engine.withBotLifecycleLock(ownerUserId, id, mutation);
    else await mutation();
  });

  router.delete("/bots/:id", async (req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    const id = routeParam(req.params.id);
    const initial = ownedBot(engine, ownerUserId, id);
    if (!initial) return void res.status(404).json({ error: "Bot not found" });
    if (!ensureRole(res, roleForBot(initial))) return;
    try {
      await engine.deleteSafelyForOwner(ownerUserId, id, () => {
        const current = getBotForOwner(ownerUserId, id);
        if (!current) return void res.status(404).json({ error: "Bot not found" });
        if (!ensureRole(res, roleForBot(current))) return;
        deleteBotForOwner(ownerUserId, id);
        res.json({ ok: true });
      });
    } catch (error) {
      if (!res.headersSent) res.status(409).json({ error: error instanceof Error ? error.message : "Failed to stop bot before deletion" });
    }
  });

  router.post("/bots/:id/reset-state", async (req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    const id = routeParam(req.params.id);
    await engine.withBotLifecycleLock(ownerUserId, id, async () => {
      const bot = ownedBot(engine, ownerUserId, id);
      if (!bot) return void res.status(404).json({ error: "Bot not found" });
      if (!ensureRole(res, roleForBot(bot))) return;
      if (engine.isRunningForOwner(ownerUserId, id)) return void res.status(409).json({ error: "Stop the bot before resetting its state." });
      deleteSetting(`state:${id}`);
      res.json({ ok: true });
    });
  });
}

function resolveAccountId(
  res: Response,
  ownerUserId: string,
  id: string,
  body: z.infer<typeof botBodySchema>,
  existing: BotConfig | undefined
): string | undefined {
  if (body.exchange === "paper") return paperTradingAccountId(id);
  const accountId = body.accountId ?? (existing?.exchange === body.exchange ? existing.accountId : undefined);
  if (!accountId) {
    res.status(400).json({ error: "Choose a trading account before creating a live bot.", code: "TRADING_ACCOUNT_REQUIRED" });
    return undefined;
  }
  const issue = tradingAccountBindingIssue({ id, exchange: body.exchange, accountId }, getTradingAccountForOwner(ownerUserId, accountId));
  if (issue) {
    res.status(409).json({ error: issue.message, code: issue.code });
    return undefined;
  }
  return accountId;
}

function ownedBot(engine: TradingEngine, ownerUserId: string, id: string): BotConfig | undefined {
  return engine.runtimeConfigForOwner(ownerUserId, id) ?? getBotForOwner(ownerUserId, id);
}

function ensureRole(res: Response, required: AuthRole): boolean {
  if (roleAllows(res.locals.authRole as AuthRole | undefined, required)) return true;
  res.status(403).json({ error: `Forbidden — requires ${required} access.` });
  return false;
}

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
