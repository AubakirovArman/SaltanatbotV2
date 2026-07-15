import type { RequestHandler, Router } from "express";
import { z } from "zod";
import { getNotifyConfig, notify, testNotify, type NotifyConfig } from "./notifications.js";
import { tenantSettingKey, tradingOwnerFromResponse } from "./ownership.js";
import { setSetting } from "./store.js";
import type { TelegramControl } from "./telegramControl.js";
import type { AuthRole } from "./types.js";

const notifyBodySchema = z.object({
  telegram: z.object({
    enabled: z.boolean().optional(),
    token: z.string().max(256).optional(),
    chatId: z.string().max(64).optional(),
    control: z.boolean().optional()
  }).optional(),
  vk: z.object({ enabled: z.boolean().optional(), token: z.string().max(512).optional(), peerId: z.string().max(64).optional() }).optional()
});

type RoleMiddleware = (required: AuthRole) => RequestHandler;

export function registerNotificationRoutes(router: Router, requireRole: RoleMiddleware, telegramControl: TelegramControl): void {
  router.get("/notify", requireRole("paper-trade"), (_req, res) => {
    const config = getNotifyConfig(tradingOwnerFromResponse(res));
    res.json({
      telegram: { enabled: config.telegram.enabled, chatId: config.telegram.chatId, hasToken: !!config.telegram.token, control: config.telegram.control },
      vk: { enabled: config.vk.enabled, peerId: config.vk.peerId, hasToken: !!config.vk.token }
    });
  });

  router.post("/notify", requireRole("paper-trade"), (req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    const parsed = notifyBodySchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
    const body = parsed.data as Partial<NotifyConfig>;
    const current = getNotifyConfig(ownerUserId);
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
    setSetting(tenantSettingKey(ownerUserId, "notify"), next, true);
    telegramControl.refresh();
    res.json({ ok: true });
  });

  router.post("/notify/test", requireRole("paper-trade"), async (_req, res) => {
    res.json(await testNotify(tradingOwnerFromResponse(res)));
  });

  router.post("/notify-alert", requireRole("paper-trade"), async (req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    const parsed = z.object({
      symbol: z.string().min(1).max(30),
      price: z.number().finite(),
      direction: z.enum(["above", "below"]),
      hitPrice: z.number().finite().optional()
    }).safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
    const { symbol, price, direction, hitPrice } = parsed.data;
    await notify({ ownerUserId, event: "signal", bot: "Price alert", symbol, text: `crossed ${direction} ${price}${hitPrice !== undefined ? ` — now ${hitPrice}` : ""}` });
    res.json({ ok: true });
  });

  router.post("/notify-arbitrage", requireRole("paper-trade"), async (req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    const parsed = z.object({
      symbol: z.string().regex(/^[A-Z0-9]{2,20}USDT$/),
      spotExchange: z.enum(["binance", "bybit"]),
      futuresExchange: z.enum(["binance", "bybit"]),
      netEdgeBps: z.number().finite().min(-10_000).max(10_000),
      minimumNetEdgeBps: z.number().finite().min(-10_000).max(10_000)
    }).refine((value) => value.spotExchange !== value.futuresExchange).safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
    const value = parsed.data;
    await notify({
      ownerUserId,
      event: "signal",
      bot: "Arbitrage screener",
      symbol: value.symbol,
      text: `${value.spotExchange} spot → ${value.futuresExchange} perpetual · net ${(value.netEdgeBps / 100).toFixed(3)}% crossed ${(value.minimumNetEdgeBps / 100).toFixed(3)}%`
    });
    res.json({ ok: true });
  });
}
