import type { TradeFlowTrade } from "../types";
import type { FootprintInsights, ImbalanceSide } from "./footprintInsights";
import type { TradeFootprint } from "./tradeFootprint";

export type MicrostructureAlertKind = "stacked_imbalance" | "potential_absorption" | "cvd_spike" | "large_print";

export interface MicrostructureAlertSettings {
  enabled: boolean;
  stackedImbalance: boolean;
  potentialAbsorption: boolean;
  cvdSpike: boolean;
  largePrint: boolean;
  largePrintNotional: number;
  cvdDeltaPercent: number;
  cvdMinimumNotional: number;
  sound: boolean;
  desktopNotifications: boolean;
}

export interface MicrostructureAlertEvent {
  id: string;
  kind: MicrostructureAlertKind;
  symbol: string;
  time: number;
  side?: ImbalanceSide;
  price?: number;
  value: number;
}

export const DEFAULT_MICROSTRUCTURE_ALERT_SETTINGS: MicrostructureAlertSettings = {
  enabled: true,
  stackedImbalance: true,
  potentialAbsorption: true,
  cvdSpike: true,
  largePrint: true,
  largePrintNotional: 100_000,
  cvdDeltaPercent: 70,
  cvdMinimumNotional: 50_000,
  sound: false,
  desktopNotifications: false
};

export function evaluateMicrostructureAlerts({
  symbol,
  trades,
  footprint,
  insights,
  settings
}: {
  symbol: string;
  trades: Iterable<TradeFlowTrade>;
  footprint: TradeFootprint;
  insights: FootprintInsights;
  settings: MicrostructureAlertSettings;
}): MicrostructureAlertEvent[] {
  if (!settings.enabled) return [];
  const events: MicrostructureAlertEvent[] = [];
  if (settings.stackedImbalance) {
    for (const stack of insights.stacks) {
      events.push({
        id: `${symbol}:stack:${stack.time}:${stack.side}:${stack.cells[0].row}-${stack.cells.at(-1)!.row}`,
        kind: "stacked_imbalance",
        symbol,
        time: stack.time,
        side: stack.side,
        value: stack.cells.length
      });
    }
  }
  if (settings.potentialAbsorption) {
    for (const absorption of insights.absorptions) {
      events.push({
        id: `${symbol}:absorption:${absorption.time}:${absorption.absorbedSide}`,
        kind: "potential_absorption",
        symbol,
        time: absorption.time,
        side: absorption.absorbedSide,
        price: absorption.price,
        value: Math.abs(absorption.deltaPercent)
      });
    }
  }
  if (settings.cvdSpike) {
    for (const bar of footprint.bars) {
      const total = bar.buyNotional + bar.sellNotional;
      if (bar.prints < 20 || total < settings.cvdMinimumNotional) continue;
      const deltaPercent = total > 0 ? (bar.delta / total) * 100 : 0;
      if (Math.abs(deltaPercent) < settings.cvdDeltaPercent) continue;
      events.push({
        id: `${symbol}:cvd:${bar.time}:${deltaPercent >= 0 ? "buy" : "sell"}`,
        kind: "cvd_spike",
        symbol,
        time: bar.time,
        side: deltaPercent >= 0 ? "buy" : "sell",
        value: Math.abs(deltaPercent)
      });
    }
  }
  if (settings.largePrint) {
    const large: TradeFlowTrade[] = [];
    for (const trade of trades) {
      if (trade.price * trade.size < settings.largePrintNotional) continue;
      if (large.length === 20) large.shift();
      large.push(trade);
    }
    for (const trade of large) {
      events.push({
        id: `${symbol}:print:${trade.id}`,
        kind: "large_print",
        symbol,
        time: trade.exchangeTs,
        side: trade.side,
        price: trade.price,
        value: trade.price * trade.size
      });
    }
  }
  return events.sort((left, right) => left.time - right.time);
}

export function parseMicrostructureAlertSettings(value: unknown): MicrostructureAlertSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_MICROSTRUCTURE_ALERT_SETTINGS;
  const input = value as Record<string, unknown>;
  return {
    enabled: bool(input.enabled, true),
    stackedImbalance: bool(input.stackedImbalance, true),
    potentialAbsorption: bool(input.potentialAbsorption, true),
    cvdSpike: bool(input.cvdSpike, true),
    largePrint: bool(input.largePrint, true),
    largePrintNotional: bounded(input.largePrintNotional, 100_000, 100, 1_000_000_000),
    cvdDeltaPercent: bounded(input.cvdDeltaPercent, 70, 10, 100),
    cvdMinimumNotional: bounded(input.cvdMinimumNotional, 50_000, 100, 1_000_000_000),
    sound: bool(input.sound, false),
    desktopNotifications: bool(input.desktopNotifications, false)
  };
}

function bool(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function bounded(value: unknown, fallback: number, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}
