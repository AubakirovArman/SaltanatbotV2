import { randomUUID } from "node:crypto";
import { z } from "zod";
import { notify } from "../trading/notifications.js";
import { getSetting, setSetting } from "../trading/store.js";
import type { ArbitrageStreamHub } from "./stream.js";
import type { ArbitrageOpportunity, ArbitrageScanResponse } from "./types.js";

const STORE_KEY = "arbitrage:alert-rules:v1";

export const arbitrageAlertInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    symbol: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{2,20}USDT$/)
      .optional(),
    spotExchange: z.enum(["binance", "bybit"]).optional(),
    futuresExchange: z.enum(["binance", "bybit"]).optional(),
    minimumNetEdgeBps: z.number().finite().min(-10_000).max(10_000),
    minimumCapacityUsd: z.number().finite().min(0).max(1_000_000_000).default(0),
    estimatedNonFundingCostBps: z.number().finite().min(0).max(2_000).default(0),
    holdingHours: z
      .number()
      .finite()
      .min(0)
      .max(24 * 30)
      .default(8),
    cooldownSeconds: z.number().int().min(60).max(86_400).default(300),
    enabled: z.boolean().default(true)
  })
  .refine((value) => !value.spotExchange || !value.futuresExchange || value.spotExchange !== value.futuresExchange, {
    message: "Spot and perpetual exchanges must differ"
  });

export type ArbitrageAlertInput = z.infer<typeof arbitrageAlertInputSchema>;
export interface ArbitrageAlertRule extends ArbitrageAlertInput {
  id: string;
  createdAt: number;
  updatedAt: number;
  lastTriggeredAt?: number;
}

export class ArbitrageAlertService {
  private hub?: ArbitrageStreamHub;
  private detach?: () => void;
  private eligible = new Map<string, boolean>();

  attach(hub: ArbitrageStreamHub) {
    this.detach?.();
    this.hub = hub;
    this.detach = hub.subscribe((scan) => {
      void this.evaluate(scan);
    });
    this.syncBackgroundState();
  }

  close() {
    this.detach?.();
    this.detach = undefined;
    this.hub?.setBackgroundActive(false);
  }

  list(): ArbitrageAlertRule[] {
    return getSetting<ArbitrageAlertRule[]>(STORE_KEY) ?? [];
  }

  save(input: ArbitrageAlertInput, now = Date.now()) {
    const rules = this.list();
    const current = input.id ? rules.find((rule) => rule.id === input.id) : undefined;
    const rule: ArbitrageAlertRule = {
      ...input,
      id: current?.id ?? randomUUID(),
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      ...(current?.lastTriggeredAt ? { lastTriggeredAt: current.lastTriggeredAt } : {})
    };
    const next = [rule, ...rules.filter((value) => value.id !== rule.id)].slice(0, 50);
    setSetting(STORE_KEY, next);
    this.eligible.delete(rule.id);
    this.syncBackgroundState(next);
    return rule;
  }

  remove(id: string) {
    const next = this.list().filter((rule) => rule.id !== id);
    setSetting(STORE_KEY, next);
    this.eligible.delete(id);
    this.syncBackgroundState(next);
    return next;
  }

  async evaluate(scan: ArbitrageScanResponse, now = Date.now()) {
    const rules = this.list();
    let changed = false;
    for (const rule of rules) {
      if (!rule.enabled) {
        this.eligible.set(rule.id, false);
        continue;
      }
      const match = bestMatch(scan.opportunities, rule);
      const isEligible = !!match && effectiveNetEdgeBps(match, rule) >= rule.minimumNetEdgeBps && match.topBookCapacityUsd >= rule.minimumCapacityUsd;
      const previous = this.eligible.get(rule.id);
      this.eligible.set(rule.id, isEligible);
      if (previous === undefined || previous || !isEligible || !match) continue;
      if (rule.lastTriggeredAt && now - rule.lastTriggeredAt < rule.cooldownSeconds * 1_000) continue;
      const net = effectiveNetEdgeBps(match, rule);
      await notify({
        event: "signal",
        bot: "Persistent arbitrage alert",
        symbol: match.symbol,
        text: `${match.spotExchange} spot → ${match.futuresExchange} perpetual · estimated net ${(net / 100).toFixed(3)}% crossed ${(rule.minimumNetEdgeBps / 100).toFixed(3)}%`
      });
      rule.lastTriggeredAt = now;
      rule.updatedAt = now;
      changed = true;
    }
    if (changed) setSetting(STORE_KEY, rules);
  }

  private syncBackgroundState(rules = this.list()) {
    this.hub?.setBackgroundActive(rules.some((rule) => rule.enabled));
  }
}

export function effectiveNetEdgeBps(row: ArbitrageOpportunity, rule: Pick<ArbitrageAlertRule, "estimatedNonFundingCostBps" | "holdingHours">) {
  const expectedFundingPayments = rule.holdingHours / 8;
  return row.grossSpreadBps - rule.estimatedNonFundingCostBps + row.fundingRate * expectedFundingPayments * 10_000;
}

function bestMatch(rows: ArbitrageOpportunity[], rule: ArbitrageAlertRule) {
  return rows.filter((row) => (!rule.symbol || row.symbol === rule.symbol) && (!rule.spotExchange || row.spotExchange === rule.spotExchange) && (!rule.futuresExchange || row.futuresExchange === rule.futuresExchange)).sort((left, right) => effectiveNetEdgeBps(right, rule) - effectiveNetEdgeBps(left, rule))[0];
}
