import { randomUUID } from "node:crypto";
import type { Request, RequestHandler, Response, Router } from "express";
import { z } from "zod";
import { AccountTelemetryService, createAccountTelemetryHandler } from "../arbitrage/telemetry/index.js";
import { revalidateTradingAuthorization } from "../auth.js";
import { requireSecureTradingOrigin } from "../secureTradingOrigin.js";
import { createBybitUtaHandlers, type BybitUtaHandlers } from "./bybitUtaRoutes.js";
import type { ExchangeKeys } from "./exchange/binance.js";
import { DENY_SIGNED_REQUEST_AUTHORIZER } from "./exchange/signedRequestGate.js";
import {
  deleteTradingAccountCredentialsForOwner,
  deleteTradingAccountForOwner,
  getTradingAccountCredentialsForOwner,
  getTradingAccountForOwner,
  hasTradingAccountCredentialsForOwner,
  insertTradingAccountForOwner,
  listBotsForOwner,
  listTradingAccountsForOwner,
  setTradingAccountCredentialsForOwner,
  TradingAccountInUseError,
  updateTradingAccountForOwner
} from "./store.js";
import { botTradingAccountId, describeTradingAccount } from "./tradingAccounts.js";
import type { ExchangeId, TradingAccount } from "./types.js";
import { tradingOwnerFromResponse } from "./ownership.js";
import { isTradingResourceQuotaError } from "./resourceQuotas.js";
import { getRuntimePolicy, isPaperOnlyRuntime, paperOnlyErrorBody, type RuntimePolicy } from "../runtimeProfile.js";

const accountCreateSchema = z.object({
  label: z.string().trim().min(1).max(120),
  exchange: z.enum(["binance", "bybit"]),
  ownership: z.enum(["own", "managed"]).default("own"),
  enabled: z.boolean().default(true)
});

const accountUpdateSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    ownership: z.enum(["own", "managed"]).optional(),
    enabled: z.boolean().optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one account field is required."
  });

const keysBodySchema = z.object({
  apiKey: z.string().trim().min(8).max(256),
  apiSecret: z.string().trim().min(8).max(256)
});

export interface TradingAccountRegistryRouteOptions {
  isBotRunning?: (ownerUserId: string, botId: string) => boolean;
  maxAccountsPerOwner?: number;
  withAccountLifecycleLock?: <T>(ownerUserId: string, accountId: string, operation: () => Promise<T>) => Promise<T>;
  runtimePolicy?: RuntimePolicy;
}

/**
 * Registers the durable, non-secret account registry at its original position
 * in the authenticated trading route stack.
 */
export function registerTradingAccountRegistryRoutes(router: Router, requireLiveRole: RequestHandler, options: TradingAccountRegistryRouteOptions = {}): void {
  const runtimePolicy = options.runtimePolicy ?? getRuntimePolicy();
  router.get("/accounts", (_req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    res.json({ accounts: listTradingAccountsForOwner(ownerUserId).map((account) => accountView(ownerUserId, account)) });
  });

  router.get("/accounts/:id", (req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    const account = getTradingAccountForOwner(ownerUserId, routeParam(req, "id"));
    if (!account) {
      res.status(404).json({
        error: "Trading account not found.",
        code: "TRADING_ACCOUNT_NOT_FOUND"
      });
      return;
    }
    res.json({ account: accountView(ownerUserId, account) });
  });

  router.post("/accounts", requireLiveRole, requirePaperModeCapability(runtimePolicy, "live trading account creation"), requireSecureTradingOrigin, (req, res) => {
    const parsed = accountCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const now = Date.now();
    const ownerUserId = tradingOwnerFromResponse(res);
    const account: TradingAccount = {
      id: randomUUID(),
      ownerUserId,
      label: parsed.data.label,
      exchange: parsed.data.exchange,
      ownership: parsed.data.ownership,
      enabled: parsed.data.enabled,
      createdAt: now,
      updatedAt: now
    };
    try {
      insertTradingAccountForOwner(ownerUserId, account, options.maxAccountsPerOwner);
      res.status(201).json({ account: accountView(ownerUserId, account) });
    } catch (error) {
      if (!isTradingResourceQuotaError(error)) throw error;
      res.status(429).json({ error: error.message, code: error.code, limit: error.limit });
    }
  });

  router.patch("/accounts/:id", requireLiveRole, requireSecureTradingOrigin, (req, res, next) => {
    const parsed = accountUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const ownerUserId = tradingOwnerFromResponse(res);
    const accountId = routeParam(req, "id");
    void withAccountLifecycleLock(options, ownerUserId, accountId, async () => {
      const authorization = await revalidateTradingAuthorization(res, "live-trade");
      if (!authorization?.assertCurrent()) return;
      const current = getTradingAccountForOwner(ownerUserId, accountId);
      if (!current) return accountNotFound(res);
      const botIds = boundBotIds(ownerUserId, current.id);
      if (parsed.data.enabled === false && botIds.length > 0) {
        res.status(409).json({
          error: `Trading account ${current.id} is used by ${botIds.length} bot(s). Unbind or delete them before disabling the account.`,
          code: "TRADING_ACCOUNT_IN_USE",
          botIds
        });
        return;
      }
      const account: TradingAccount = {
        ...current,
        label: parsed.data.label ?? current.label,
        ownership: parsed.data.ownership ?? current.ownership,
        enabled: parsed.data.enabled ?? current.enabled,
        updatedAt: Date.now()
      };
      updateTradingAccountForOwner(ownerUserId, account);
      res.json({ account: accountView(ownerUserId, account) });
    }).catch(next);
  });

  router.delete("/accounts/:id", requireLiveRole, requireSecureTradingOrigin, (req, res, next) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    const id = routeParam(req, "id");
    void withAccountLifecycleLock(options, ownerUserId, id, async () => {
      const authorization = await revalidateTradingAuthorization(res, "live-trade");
      if (!authorization?.assertCurrent()) return;
      const current = getTradingAccountForOwner(ownerUserId, id);
      if (!current) return accountNotFound(res);
      const botIds = boundBotIds(ownerUserId, current.id);
      if (botIds.length > 0) {
        res.status(409).json({
          error: `Trading account ${current.id} is used by ${botIds.length} bot(s).`,
          code: "TRADING_ACCOUNT_IN_USE",
          botIds
        });
        return;
      }
      if (hasCredentials(ownerUserId, current.id)) {
        res.status(409).json({ error: "Remove the account credentials before deleting its metadata.", code: "TRADING_ACCOUNT_HAS_CREDENTIALS" });
        return;
      }
      try {
        deleteTradingAccountForOwner(ownerUserId, id);
        res.json({ ok: true });
      } catch (error) {
        if (error instanceof TradingAccountInUseError) {
          res.status(409).json({ error: error.message, code: "TRADING_ACCOUNT_IN_USE", botIds: error.botIds });
          return;
        }
        throw error;
      }
    }).catch(next);
  });

  router.put("/accounts/:id/credentials", requireLiveRole, requirePaperModeCapability(runtimePolicy, "exchange credential storage"), requireSecureTradingOrigin, (req, res, next) => {
    const parsed = keysBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const ownerUserId = tradingOwnerFromResponse(res);
    const accountId = routeParam(req, "id");
    void withAccountLifecycleLock(options, ownerUserId, accountId, async () => {
      const authorization = await revalidateTradingAuthorization(res, "live-trade");
      if (!authorization?.assertCurrent()) return;
      const account = getTradingAccountForOwner(ownerUserId, accountId);
      if (!account) return accountNotFound(res);
      const runningBotIds = boundBotIds(ownerUserId, account.id).filter((botId) => options.isBotRunning?.(ownerUserId, botId));
      if (runningBotIds.length > 0) {
        res.status(409).json({
          error: "Stop every robot using this account before rotating its credentials.",
          code: "TRADING_ACCOUNT_RUNNING",
          botIds: runningBotIds
        });
        return;
      }
      setTradingAccountCredentialsForOwner(ownerUserId, account.id, parsed.data);
      res.json({ account: accountView(ownerUserId, account) });
    }).catch(next);
  });

  router.delete("/accounts/:id/credentials", requireLiveRole, requireSecureTradingOrigin, (req, res, next) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    const accountId = routeParam(req, "id");
    void withAccountLifecycleLock(options, ownerUserId, accountId, async () => {
      const authorization = await revalidateTradingAuthorization(res, "live-trade");
      if (!authorization?.assertCurrent()) return;
      const account = getTradingAccountForOwner(ownerUserId, accountId);
      if (!account) return accountNotFound(res);
      const botIds = boundBotIds(ownerUserId, account.id);
      if (botIds.length > 0) {
        res.status(409).json({
          error: "Unbind or delete robots before removing account credentials.",
          code: "TRADING_ACCOUNT_IN_USE",
          botIds
        });
        return;
      }
      deleteTradingAccountCredentialsForOwner(ownerUserId, account.id);
      res.json({ account: accountView(ownerUserId, account) });
    }).catch(next);
  });
}

/**
 * Registers credential status, signed account telemetry and manual Bybit UTA
 * controls at their original position in the authenticated trading route stack.
 */
export interface TradingAccountIntegrationRouteOptions {
  liveEnabled(ownerUserId: string): boolean;
  runtimePolicy?: RuntimePolicy;
}

export function registerTradingAccountIntegrationRoutes(router: Router, requireLiveRole: RequestHandler, options: TradingAccountIntegrationRouteOptions): void {
  const runtimePolicy = options.runtimePolicy ?? getRuntimePolicy();
  // Compatibility status contains booleans only and is scoped to the current
  // tenant. New clients manage credentials on a concrete account resource.
  router.get("/keys", requireLiveRole, (_req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    res.json({
      binance: firstAccountWithStoredCredentials(ownerUserId, "binance") !== undefined,
      bybit: firstAccountWithStoredCredentials(ownerUserId, "bybit") !== undefined
    });
  });

  router.post("/keys", requireLiveRole, requireSecureTradingOrigin, (_req, res) => {
    res.status(410).json({
      error: "Choose a trading account and store credentials on that account.",
      code: "ACCOUNT_CREDENTIAL_ENDPOINT_REQUIRED"
    });
  });

  router.get("/account-telemetry", requireLiveRole, requirePaperModeCapability(runtimePolicy, "private account telemetry"), (req, res, next) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    const accountTelemetry = new AccountTelemetryService({
      keys: (venue) => firstConfiguredAccount(ownerUserId, venue)?.keys
    });
    return createAccountTelemetryHandler(accountTelemetry)(req, res, next);
  });

  const uta =
    (kind: keyof BybitUtaHandlers): RequestHandler =>
    (req, res, next) => {
      const ownerUserId = tradingOwnerFromResponse(res);
      const selected = selectedAccountCredentials(req, ownerUserId, "bybit");
      if (selected === "not-found") return accountNotFound(res);
      if (selected === "disabled") return accountDisabled(res);
      const handlers = createBybitUtaHandlers({
        demo: () => isPaperOnlyRuntime(runtimePolicy),
        liveEnabled: () => options.liveEnabled(ownerUserId),
        keys: () => selected?.keys,
        signedRequestAuthorizer: DENY_SIGNED_REQUEST_AUTHORIZER,
        authorizeMutation: () => revalidateTradingAuthorization(res, "live-trade")
      });
      return handlers[kind](req, res, next);
    };

  router.get("/bybit/uta", requireLiveRole, requirePaperModeCapability(runtimePolicy, "private Bybit UTA telemetry"), uta("status"));
  router.post("/bybit/uta/borrow", requireLiveRole, requirePaperModeCapability(runtimePolicy, "private Bybit UTA mutation"), requireSecureTradingOrigin, uta("borrow"));
  router.post("/bybit/uta/repay", requireLiveRole, requirePaperModeCapability(runtimePolicy, "private Bybit UTA mutation"), requireSecureTradingOrigin, uta("repay"));
  router.post("/bybit/uta/collateral", requireLiveRole, requirePaperModeCapability(runtimePolicy, "private Bybit UTA mutation"), requireSecureTradingOrigin, uta("collateral"));
}

function hasCredentials(ownerUserId: string, accountId: string): boolean {
  return hasTradingAccountCredentialsForOwner(ownerUserId, accountId);
}

function accountView(ownerUserId: string, account: TradingAccount) {
  return describeTradingAccount(account, hasCredentials(ownerUserId, account.id), boundBotIds(ownerUserId, account.id));
}

function boundBotIds(ownerUserId: string, accountId: string): string[] {
  return listBotsForOwner(ownerUserId)
    .filter((bot) => bot.exchange !== "paper" && botTradingAccountId(bot) === accountId)
    .map((bot) => bot.id);
}

function withAccountLifecycleLock<T>(options: TradingAccountRegistryRouteOptions, ownerUserId: string, accountId: string, operation: () => Promise<T>): Promise<T> {
  return options.withAccountLifecycleLock ? options.withAccountLifecycleLock(ownerUserId, accountId, operation) : operation();
}

function firstConfiguredAccount(ownerUserId: string, exchange: Exclude<ExchangeId, "paper">) {
  for (const account of listTradingAccountsForOwner(ownerUserId)) {
    if (!account.enabled || account.exchange !== exchange) continue;
    const keys = getTradingAccountCredentialsForOwner<ExchangeKeys>(ownerUserId, account.id);
    if (keys?.apiKey && keys.apiSecret) return { account, keys };
  }
  return undefined;
}

function firstAccountWithStoredCredentials(ownerUserId: string, exchange: Exclude<ExchangeId, "paper">): TradingAccount | undefined {
  return listTradingAccountsForOwner(ownerUserId).find((account) => account.enabled && account.exchange === exchange && hasCredentials(ownerUserId, account.id));
}

function requirePaperModeCapability(runtimePolicy: RuntimePolicy, operation: string): RequestHandler {
  return (_req, res, next) => {
    if (!isPaperOnlyRuntime(runtimePolicy)) return next();
    res.status(403).json(paperOnlyErrorBody(operation));
  };
}

function selectedAccountCredentials(req: Request, ownerUserId: string, exchange: Exclude<ExchangeId, "paper">): ReturnType<typeof firstConfiguredAccount> | "not-found" | "disabled" {
  const requested = queryParam(req, "accountId");
  if (!requested) return firstConfiguredAccount(ownerUserId, exchange);
  const account = getTradingAccountForOwner(ownerUserId, requested);
  if (!account || account.exchange !== exchange) return "not-found";
  if (!account.enabled) return "disabled";
  const keys = getTradingAccountCredentialsForOwner<ExchangeKeys>(ownerUserId, account.id);
  return keys?.apiKey && keys.apiSecret ? { account, keys } : undefined;
}

function accountNotFound(res: Response): void {
  res.status(404).json({ error: "Trading account not found.", code: "TRADING_ACCOUNT_NOT_FOUND" });
}

function accountDisabled(res: Response): void {
  res.status(409).json({
    error: "Trading account is disabled.",
    code: "TRADING_ACCOUNT_DISABLED"
  });
}

function routeParam(req: Request, key: string): string {
  const value = req.params[key];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function queryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
