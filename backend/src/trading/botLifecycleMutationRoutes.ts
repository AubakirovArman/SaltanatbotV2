import { randomUUID } from "node:crypto";
import type { Response, Router } from "express";
import { z } from "zod";
import { isDatabaseAuthMode, revalidateTradingAuthorization, roleAllows } from "../auth.js";
import { timeframes } from "../market/timeframes.js";
import { ensureSecureTradingOrigin } from "../secureTradingOrigin.js";
import type { Timeframe } from "../types.js";
import { mutationAuthority, roleForBot } from "./botRouteIdentity.js";
import type { TradingEngine } from "./engine.js";
import { liveRiskValidationErrors } from "./liveRisk.js";
import { tradingOwnerFromResponse } from "./ownership.js";
import { deleteBotForOwner, deleteSetting, getBotForOwner, getBotOwnerUserId, getTradingAccountForOwner, upsertBotForOwner } from "./store.js";
import { parseStrategyIR } from "./strategy/irSchema.js";
import { paperTradingAccountId, tradingAccountBindingIssue } from "./tradingAccounts.js";
import type { AuthRole, BotConfig, ExchangeId } from "./types.js";
import { isTradingResourceQuotaError } from "./resourceQuotas.js";
import { getRuntimePolicy, isPaperOnlyRuntime, paperOnlyErrorBody, type RuntimePolicy } from "../runtimeProfile.js";
import {
  PAPER_PORTFOLIO_COMMAND_VERSION,
  PaperPortfolioCommandInputError,
  deterministicPaperRobotId,
  paperPortfolioRequestHash,
  parseCanonicalPaperMoneyMicros,
  parsePaperPortfolioExecutorPayload
} from "./paperPortfolioCommandContract.js";
import {
  PaperPortfolioHttpError,
  type PaperPortfolioMutationGateway
} from "./paperPortfolioGatewayTypes.js";
import {
  assertExpectedPaperOwner,
  paperCommandPrincipal,
  paperIdempotencyKey
} from "./paperPortfolioHttpContext.js";

const botBodySchema = z.object({
  id: z.string().optional(),
  accountId: z.string().trim().min(3).max(128).optional(),
  name: z.string().max(120).optional(),
  strategyName: z.string().max(120).optional(),
  ir: z.unknown(),
  symbol: z.string().min(1).max(30),
  timeframe: z.enum(timeframes as [Timeframe, ...Timeframe[]]),
  exchange: z.enum(["paper", "binance", "bybit"]).default("paper"),
  dataExchange: z.enum(["binance", "bybit", "hyperliquid"]).optional(),
  market: z.enum(["spot", "futures"]).default("spot"),
  sizeMode: z.enum(["quote", "base", "equity_pct", "risk_pct"]).default("quote"),
  sizeValue: z.coerce.number().positive().finite().max(1_000_000_000),
  leverage: z.coerce.number().int().min(1).max(125).default(1),
  bybitCrossCollateral: z.boolean().default(false),
  notifyMarkers: z.boolean().default(false),
  maxPositionQuote: z.coerce.number().nonnegative().finite().max(1_000_000_000).optional(),
  maxOrderQuote: z.coerce.number().nonnegative().finite().max(1_000_000_000).optional(),
  maxDailyLossQuote: z.coerce.number().nonnegative().finite().max(1_000_000_000).optional(),
  maxOpenOrders: z.coerce.number().int().nonnegative().max(10_000).optional(),
  paperPortfolioId: z.string().trim().min(1).max(200).optional(),
  paperAllocation: z.string().trim().regex(/^(?:0|[1-9]\d*)\.\d{6}$/).optional(),
  expectedPortfolioRevision: z.coerce.number().int().positive().safe().optional(),
  expectedLedgerEpoch: z.coerce.number().int().positive().safe().optional()
});

interface BotLifecycleRouteOptions {
  view(ownerUserId: string, bot: BotConfig): Omit<BotConfig, "ownerUserId">;
  maxBotsPerOwner: number;
  runtimePolicy?: RuntimePolicy;
  paperPortfolioCommands?: PaperPortfolioMutationGateway;
}

export function registerBotLifecycleMutationRoutes(router: Router, engine: TradingEngine, options: BotLifecycleRouteOptions): void {
  const runtimePolicy = options.runtimePolicy ?? getRuntimePolicy();
  router.post("/bots", async (req, res) => {
    const parsed = botBodySchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
    const ownerUserId = tradingOwnerFromResponse(res);
    const body = parsed.data;
    let paperCommandKey: string | undefined;
    try {
      if (body.exchange === "paper" && !body.id && isDatabaseAuthMode()) {
        assertExpectedPaperOwner(req, ownerUserId);
        paperCommandKey = paperIdempotencyKey(req);
      }
    } catch (error) {
      if (error instanceof PaperPortfolioHttpError) {
        return void res.status(error.status).json({ error: error.message, code: error.code });
      }
      throw error;
    }
    const id = body.id ?? (paperCommandKey ? deterministicPaperRobotId(ownerUserId, paperCommandKey) : randomUUID());
    const mutation = async () => {
      const persistedOwner = body.id ? getBotOwnerUserId(id) : undefined;
      if (persistedOwner && persistedOwner !== ownerUserId) return void res.status(404).json({ error: "Bot not found" });
      const existing = body.id ? getBotForOwner(ownerUserId, id) : undefined;
      if (body.id && !existing) return void res.status(400).json({ error: "Bot ids are assigned by the server.", code: "BOT_ID_SERVER_MANAGED" });
      if (existing?.exchange === "paper" && existing.paperPortfolioId) {
        return void res.status(409).json({
          error: "A bound paper robot is immutable. Create a new robot revision instead.",
          code: "PAPER_BOT_BINDING_IMMUTABLE"
        });
      }
      if (body.exchange !== "paper" && isPaperOnlyRuntime(runtimePolicy)) {
        return void res.status(403).json(paperOnlyErrorBody("live bot configuration"));
      }
      if (body.exchange === "paper" && body.dataExchange === "hyperliquid" && body.market !== "futures") {
        return void res.status(400).json({ error: "Hyperliquid paper robots currently require the futures market.", code: "HYPERLIQUID_PERPETUAL_REQUIRED" });
      }
      const { runtime, role, secureOrigin } = mutationAuthority(engine, ownerUserId, existing, body.id, body.exchange);
      if (!ensureRole(res, role) || (secureOrigin && !ensureSecureTradingOrigin(req, res))) return;
      if (runtime) return void res.status(409).json({ error: "Stop the running bot before changing its configuration." });
      const liveRiskErrors = liveRiskValidationErrors(body);
      if (liveRiskErrors.length) return void res.status(400).json({ error: `Live risk limits are incomplete: ${liveRiskErrors.join("; ")}` });
      const irResult = parseStrategyIR(body.ir);
      if (!irResult.ok) return void res.status(400).json({ error: `Invalid strategy IR: ${irResult.error}` });
      const persist = async () => {
        const authorization = await revalidateTradingAuthorization(res, role);
        if (!authorization?.assertCurrent()) return;
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
          dataExchange: body.exchange === "paper" ? (body.dataExchange ?? "binance") : body.exchange,
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
        if (paperCommandKey) {
          if (
            !options.paperPortfolioCommands
            || !body.paperPortfolioId
            || !body.paperAllocation
            || !body.expectedPortfolioRevision
            || !body.expectedLedgerEpoch
          ) {
            return void res.status(409).json({
              error: "Choose an active paper portfolio and allocation before creating the robot.",
              code: "PAPER_PORTFOLIO_BINDING_REQUIRED"
            });
          }
          const {
            ownerUserId: _owner,
            revision: _revision,
            paperPortfolioId: _portfolio,
            paperAllocationMicros: _allocation,
            paperLedgerEpoch: _epoch,
            status: _status,
            createdAt: _createdAt,
            updatedAt: _updatedAt,
            ...publicConfig
          } = bot;
          const payload = parsePaperPortfolioExecutorPayload(JSON.parse(JSON.stringify({
            version: PAPER_PORTFOLIO_COMMAND_VERSION,
            kind: "paper-robot.create",
            portfolioId: body.paperPortfolioId,
            expectedPortfolioRevision: body.expectedPortfolioRevision,
            expectedLedgerEpoch: body.expectedLedgerEpoch,
            botId: id,
            expectedBotRevision: 1,
            allocationMicros: parseCanonicalPaperMoneyMicros(body.paperAllocation),
            maxBots: options.maxBotsPerOwner,
            bot: publicConfig
          })));
          await options.paperPortfolioCommands.execute({
            principal: paperCommandPrincipal(res, ownerUserId),
            idempotencyKey: paperCommandKey,
            requestHash: paperPortfolioRequestHash(ownerUserId, payload),
            payload
          });
          const persisted = getBotForOwner(ownerUserId, id);
          if (!persisted) throw new Error("Paper robot command applied without a durable bot");
          return void res.json({ bot: options.view(ownerUserId, persisted) });
        }
        upsertBotForOwner(ownerUserId, bot, { maxBots: options.maxBotsPerOwner });
        res.json({ bot: options.view(ownerUserId, bot) });
      };
      const targetAccountId = body.exchange === "paper" ? undefined : (body.accountId ?? (existing?.exchange === body.exchange ? existing.accountId : undefined));
      if (targetAccountId) await engine.withAccountLifecycleLock(ownerUserId, targetAccountId, persist);
      else await persist();
    };
    try {
      if (body.id) await engine.withBotLifecycleLock(ownerUserId, id, mutation);
      else await mutation();
    } catch (error) {
      if (error instanceof PaperPortfolioHttpError) {
        return void res.status(error.status).json({ error: error.message, code: error.code });
      }
      if (error instanceof PaperPortfolioCommandInputError) {
        return void res.status(400).json({ error: error.message, code: error.code });
      }
      if (!isTradingResourceQuotaError(error)) throw error;
      res.status(429).json({ error: error.message, code: error.code, limit: error.limit });
    }
  });

  router.delete("/bots/:id", async (req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    const id = routeParam(req.params.id);
    const initial = ownedBot(engine, ownerUserId, id);
    if (!initial) return void res.status(404).json({ error: "Bot not found" });
    if (!ensureRole(res, roleForBot(initial))) return;
    if (isDatabaseAuthMode() && initial.exchange === "paper") {
      return void res.status(409).json({
        error: "Paper robot deletion requires the canonical flat-release workflow.",
        code: "PAPER_DELETE_COMMAND_REQUIRED"
      });
    }
    try {
      await engine.deleteSafelyForOwner(ownerUserId, id, async () => {
        const current = getBotForOwner(ownerUserId, id);
        if (!current) return void res.status(404).json({ error: "Bot not found" });
        const role = roleForBot(current);
        if (!ensureRole(res, role)) return;
        const authorization = await revalidateTradingAuthorization(res, role);
        if (!authorization?.assertCurrent()) return;
        deleteBotForOwner(ownerUserId, id, {
          expectedRevision: current.revision,
          reason: "legacy-token-delete",
          deletedAt: Date.now(),
          releaseLegacyFlatAllocation: current.exchange === "paper"
        });
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
      const role = roleForBot(bot);
      if (!ensureRole(res, role)) return;
      if (isDatabaseAuthMode() && bot.exchange === "paper") {
        return void res.status(409).json({
          error: "Reset the canonical paper portfolio to start a new immutable ledger epoch.",
          code: "PAPER_PORTFOLIO_RESET_REQUIRED"
        });
      }
      if (engine.isRunningForOwner(ownerUserId, id)) return void res.status(409).json({ error: "Stop the bot before resetting its state." });
      const authorization = await revalidateTradingAuthorization(res, role);
      if (!authorization?.assertCurrent()) return;
      deleteSetting(`state:${id}`);
      res.json({ ok: true });
    });
  });
}

function resolveAccountId(res: Response, ownerUserId: string, id: string, body: z.infer<typeof botBodySchema>, existing: BotConfig | undefined): string | undefined {
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
