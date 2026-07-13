import type { RequestHandler, Response } from "express";
import { z } from "zod";
import type { ExchangeKeys } from "./exchange/binance.js";
import { BybitV5Client } from "./exchange/bybitClient.js";
import { BybitUtaService } from "./bybitUta.js";

const coinSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,15}$/);
const borrowSchema = z.object({
  coin: coinSchema,
  amount: z.coerce.number().positive().finite().max(1_000_000_000),
  confirm: z.literal(true)
});
const repaySchema = z.object({
  coin: coinSchema,
  amount: z.coerce.number().positive().finite().max(1_000_000_000).optional(),
  repaymentType: z.enum(["ALL", "FIXED", "FLEXIBLE"]).default("FLEXIBLE"),
  convertCollateral: z.boolean().default(false),
  confirm: z.literal(true),
  confirmConversion: z.boolean().optional()
});
const collateralSchema = z.object({ coin: coinSchema, enabled: z.boolean(), confirm: z.literal(true) });

interface Dependencies {
  demo: () => boolean;
  liveEnabled: () => boolean;
  keys: () => ExchangeKeys | undefined;
}

export interface BybitUtaHandlers {
  status: RequestHandler;
  borrow: RequestHandler;
  repay: RequestHandler;
  collateral: RequestHandler;
}

export function createBybitUtaHandlers(deps: Dependencies): BybitUtaHandlers {
  const service = () => {
    const keys = deps.keys();
    if (!keys?.apiKey || !keys.apiSecret) throw new Error("Bybit API keys are not configured.");
    return new BybitUtaService(new BybitV5Client(keys));
  };
  const allowMutation = (response: Response, requiresLiveArm: boolean) => {
    if (deps.demo()) {
      response.status(403).json({ error: "Bybit UTA mutations are disabled in DEMO_MODE." });
      return false;
    }
    const keys = deps.keys();
    if (!keys?.apiKey || !keys.apiSecret) {
      response.status(409).json({ error: "Bybit API keys are not configured." });
      return false;
    }
    if (requiresLiveArm && !deps.liveEnabled()) {
      response.status(403).json({ error: "Live trading must be armed before increasing Bybit UTA risk." });
      return false;
    }
    return true;
  };

  return {
    status: async (_request, response) => {
      const keys = deps.keys();
      if (!keys?.apiKey || !keys.apiSecret) {
        response.json({ configured: false });
        return;
      }
      try {
        response.json({ configured: true, snapshot: await service().snapshot() });
      } catch (error) {
        response.status(502).json({ error: message(error) });
      }
    },
    borrow: async (request, response) => {
      if (!allowMutation(response, true)) return;
      const parsed = borrowSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: parsed.error.flatten() });
        return;
      }
      try {
        response.json(await service().borrow(parsed.data.coin, parsed.data.amount));
      } catch (error) {
        response.status(400).json({ error: message(error) });
      }
    },
    repay: async (request, response) => {
      if (!allowMutation(response, false)) return;
      const parsed = repaySchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: parsed.error.flatten() });
        return;
      }
      if (parsed.data.convertCollateral && parsed.data.confirmConversion !== true) {
        response.status(428).json({ error: "Collateral conversion repayment requires confirmConversion:true.", needsConfirm: true });
        return;
      }
      try {
        response.json(await service().repay(parsed.data));
      } catch (error) {
        response.status(400).json({ error: message(error) });
      }
    },
    collateral: async (request, response) => {
      const parsed = collateralSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: parsed.error.flatten() });
        return;
      }
      if (!allowMutation(response, parsed.data.enabled)) return;
      try {
        response.json(await service().setCollateral(parsed.data.coin, parsed.data.enabled));
      } catch (error) {
        response.status(400).json({ error: message(error) });
      }
    }
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Bybit UTA request failed";
}
