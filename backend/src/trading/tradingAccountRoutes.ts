import { randomUUID } from "node:crypto";
import type { Request, RequestHandler, Router } from "express";
import { z } from "zod";
import { AccountTelemetryService, createAccountTelemetryHandler } from "../arbitrage/telemetry/index.js";
import { isDemoMode } from "../auth.js";
import { requireSecureTradingOrigin } from "../secureTradingOrigin.js";
import type { BybitUtaHandlers } from "./bybitUtaRoutes.js";
import type { ExchangeKeys } from "./exchange/binance.js";
import { deleteTradingAccount, ensureLegacyTradingAccount, getSetting, getTradingAccount, insertTradingAccount, listBots, listTradingAccounts, setSetting, TradingAccountInUseError, updateTradingAccount } from "./store.js";
import { botTradingAccountId, describeTradingAccount, isLegacyTradingAccount } from "./tradingAccounts.js";
import type { ExchangeId, TradingAccount } from "./types.js";

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
  exchange: z.enum(["binance", "bybit"]),
  apiKey: z.string().trim().min(8).max(256),
  apiSecret: z.string().trim().min(8).max(256)
});

/**
 * Registers the durable, non-secret account registry at its original position
 * in the authenticated trading route stack.
 */
export function registerTradingAccountRegistryRoutes(router: Router, requireAdmin: RequestHandler): void {
  // Credential storage is still one encrypted key pair per exchange. The
  // response states that limitation instead of presenting extra metadata rows
  // as independently executable accounts.
  router.get("/accounts", requireAdmin, (_req, res) => {
    res.json({ accounts: listTradingAccounts().map(accountView) });
  });

  router.get("/accounts/:id", requireAdmin, (req, res) => {
    const account = getTradingAccount(routeParam(req, "id"));
    if (!account) {
      res.status(404).json({
        error: "Trading account not found.",
        code: "TRADING_ACCOUNT_NOT_FOUND"
      });
      return;
    }
    res.json({ account: accountView(account) });
  });

  router.post("/accounts", requireAdmin, requireSecureTradingOrigin, (req, res) => {
    const parsed = accountCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const now = Date.now();
    const account: TradingAccount = {
      id: randomUUID(),
      label: parsed.data.label,
      exchange: parsed.data.exchange,
      ownership: parsed.data.ownership,
      enabled: parsed.data.enabled,
      createdAt: now,
      updatedAt: now
    };
    insertTradingAccount(account);
    res.status(201).json({ account: accountView(account) });
  });

  router.patch("/accounts/:id", requireAdmin, requireSecureTradingOrigin, (req, res) => {
    const parsed = accountUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const current = getTradingAccount(routeParam(req, "id"));
    if (!current) {
      res.status(404).json({
        error: "Trading account not found.",
        code: "TRADING_ACCOUNT_NOT_FOUND"
      });
      return;
    }
    const botIds = boundBotIds(current.id);
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
    updateTradingAccount(account);
    res.json({ account: accountView(account) });
  });

  router.delete("/accounts/:id", requireAdmin, requireSecureTradingOrigin, (req, res) => {
    const id = routeParam(req, "id");
    const current = getTradingAccount(id);
    if (!current) {
      res.status(404).json({
        error: "Trading account not found.",
        code: "TRADING_ACCOUNT_NOT_FOUND"
      });
      return;
    }
    const botIds = boundBotIds(current.id);
    if (botIds.length > 0) {
      res.status(409).json({
        error: `Trading account ${current.id} is used by ${botIds.length} bot(s).`,
        code: "TRADING_ACCOUNT_IN_USE",
        botIds
      });
      return;
    }
    if (isLegacyTradingAccount(current) && hasKeys(current.exchange)) {
      res.status(409).json({
        error: "Remove or replace the exchange credentials before deleting its default account metadata.",
        code: "TRADING_ACCOUNT_HAS_CREDENTIALS"
      });
      return;
    }
    try {
      deleteTradingAccount(id);
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof TradingAccountInUseError) {
        res.status(409).json({
          error: error.message,
          code: "TRADING_ACCOUNT_IN_USE",
          botIds: error.botIds
        });
        return;
      }
      throw error;
    }
  });
}

/**
 * Registers credential status, signed account telemetry and manual Bybit UTA
 * controls at their original position in the authenticated trading route stack.
 */
export function registerTradingAccountIntegrationRoutes(router: Router, requireAdmin: RequestHandler, uta: BybitUtaHandlers): void {
  const accountTelemetry = new AccountTelemetryService({
    keys: (venue) => getSetting<ExchangeKeys>(`keys:${venue}`)
  });

  // Exchange keys are never returned in plaintext.
  router.get("/keys", requireAdmin, (_req, res) => {
    res.json({
      binance: hasKeys("binance"),
      bybit: hasKeys("bybit")
    });
  });

  router.post("/keys", requireAdmin, requireSecureTradingOrigin, (req, res) => {
    if (isDemoMode()) {
      res.status(403).json({ error: "Exchange keys cannot be stored in DEMO_MODE." });
      return;
    }
    const parsed = keysBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    ensureLegacyTradingAccount(parsed.data.exchange);
    setSetting(`keys:${parsed.data.exchange}`, { apiKey: parsed.data.apiKey, apiSecret: parsed.data.apiSecret }, true);
    res.json({ ok: true });
  });

  // Signed account-derived economics evidence. This GET remains behind the
  // existing authenticated admin session and never returns credential data.
  router.get("/account-telemetry", requireAdmin, createAccountTelemetryHandler(accountTelemetry));

  // Bybit Unified Trading Account collateral + manual debt.
  router.get("/bybit/uta", requireAdmin, uta.status);
  router.post("/bybit/uta/borrow", requireAdmin, requireSecureTradingOrigin, uta.borrow);
  router.post("/bybit/uta/repay", requireAdmin, requireSecureTradingOrigin, uta.repay);
  router.post("/bybit/uta/collateral", requireAdmin, requireSecureTradingOrigin, uta.collateral);
}

function hasKeys(exchange: ExchangeId): boolean {
  const keys = getSetting<ExchangeKeys>(`keys:${exchange}`);
  return !!(keys?.apiKey && keys.apiSecret);
}

function accountView(account: TradingAccount) {
  return describeTradingAccount(account, hasKeys(account.exchange), boundBotIds(account.id));
}

function boundBotIds(accountId: string): string[] {
  return listBots()
    .filter((bot) => bot.exchange !== "paper" && botTradingAccountId(bot) === accountId)
    .map((bot) => bot.id);
}

function routeParam(req: Request, key: string): string {
  const value = req.params[key];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}
