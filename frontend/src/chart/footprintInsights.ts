import type { Candle } from "../types";
import type { FootprintCell, TradeFootprint } from "./tradeFootprint";

export type ImbalanceSide = "buy" | "sell";

export interface FootprintImbalance {
  key: string;
  time: number;
  row: number;
  x: number;
  y: number;
  side: ImbalanceSide;
  ratio: number;
}

export interface StackedImbalance {
  time: number;
  side: ImbalanceSide;
  cells: FootprintImbalance[];
}

export interface PotentialAbsorption {
  time: number;
  x: number;
  price: number;
  absorbedSide: ImbalanceSide;
  deltaPercent: number;
}

export interface FootprintInsights {
  imbalances: FootprintImbalance[];
  stacks: StackedImbalance[];
  absorptions: PotentialAbsorption[];
}

export interface FootprintInsightOptions {
  imbalanceRatio?: number;
  stackRows?: number;
  minimumDominantFraction?: number;
  absorptionDeltaPercent?: number;
  minimumBarFraction?: number;
  minimumAbsorptionPrints?: number;
}

export interface FootprintCandleLookup {
  get(time: number): Candle | undefined;
}

export function indexFootprintCandles(candles: readonly Candle[]): ReadonlyMap<number, Candle> {
  const indexed = new Map<number, Candle>();
  for (const candle of candles) indexed.set(candle.time, candle);
  return indexed;
}

/**
 * Derive transparent live-only cluster heuristics from already aggregated public prints.
 * Buy rows compare against sells one screen row below; sell rows compare against buys
 * one row above. Absorption is deliberately labelled potential: it requires strong
 * observed delta while the candle fails to close in the aggressor's half of its range.
 */
export function detectFootprintInsights(
  footprint: TradeFootprint,
  candles: readonly Candle[] | FootprintCandleLookup,
  options: FootprintInsightOptions = {}
): FootprintInsights {
  const ratioThreshold = options.imbalanceRatio ?? 3;
  const stackRows = options.stackRows ?? 3;
  const minimumDominantFraction = options.minimumDominantFraction ?? 0.08;
  const absorptionDeltaPercent = options.absorptionDeltaPercent ?? 35;
  const minimumBarFraction = options.minimumBarFraction ?? 0.15;
  const minimumAbsorptionPrints = options.minimumAbsorptionPrints ?? 20;
  const byTime = new Map<number, FootprintCell[]>();
  for (const cell of footprint.cells) {
    const rows = byTime.get(cell.time) ?? [];
    rows.push(cell);
    byTime.set(cell.time, rows);
  }

  const imbalances: FootprintImbalance[] = [];
  for (const [time, cells] of byTime) {
    const rows = new Map(cells.map((cell) => [cell.row, cell]));
    const maximum = Math.max(...cells.flatMap((cell) => [cell.buyNotional, cell.sellNotional]), 0);
    const minimumDominant = maximum * minimumDominantFraction;
    for (const cell of cells) {
      const lowerSell = rows.get(cell.row + 1)?.sellNotional ?? 0;
      const upperBuy = rows.get(cell.row - 1)?.buyNotional ?? 0;
      addImbalance(imbalances, cell, "buy", cell.buyNotional, lowerSell, minimumDominant, ratioThreshold);
      addImbalance(imbalances, cell, "sell", cell.sellNotional, upperBuy, minimumDominant, ratioThreshold);
    }
  }

  const stacks = buildStacks(imbalances, stackRows);
  const candleByTime: FootprintCandleLookup = "get" in candles ? candles : indexFootprintCandles(candles);
  const maximumBarNotional = Math.max(...footprint.bars.map((bar) => bar.buyNotional + bar.sellNotional), 0);
  const absorptions: PotentialAbsorption[] = [];
  for (const bar of footprint.bars) {
    const candle = candleByTime.get(bar.time);
    const total = bar.buyNotional + bar.sellNotional;
    if (!candle || bar.prints < minimumAbsorptionPrints || total <= 0 || total < maximumBarNotional * minimumBarFraction) continue;
    const range = candle.high - candle.low;
    if (range <= 0) continue;
    const deltaPercent = (bar.delta / total) * 100;
    const closeLocation = (candle.close - candle.low) / range;
    if (deltaPercent >= absorptionDeltaPercent && closeLocation <= 0.5) {
      absorptions.push({ time: bar.time, x: bar.x, price: candle.high, absorbedSide: "buy", deltaPercent });
    } else if (deltaPercent <= -absorptionDeltaPercent && closeLocation >= 0.5) {
      absorptions.push({ time: bar.time, x: bar.x, price: candle.low, absorbedSide: "sell", deltaPercent });
    }
  }
  return { imbalances, stacks, absorptions };
}

function addImbalance(
  output: FootprintImbalance[],
  cell: FootprintCell,
  side: ImbalanceSide,
  dominant: number,
  opposing: number,
  minimumDominant: number,
  ratioThreshold: number
) {
  if (dominant <= 0 || dominant < minimumDominant) return;
  const ratio = opposing > 0 ? dominant / opposing : Number.POSITIVE_INFINITY;
  if (ratio < ratioThreshold) return;
  output.push({ key: `${cell.time}:${cell.row}:${side}`, time: cell.time, row: cell.row, x: cell.x, y: cell.y, side, ratio });
}

function buildStacks(imbalances: FootprintImbalance[], minimumRows: number) {
  const stacks: StackedImbalance[] = [];
  const groups = new Map<string, FootprintImbalance[]>();
  for (const imbalance of imbalances) {
    const key = `${imbalance.time}:${imbalance.side}`;
    const group = groups.get(key) ?? [];
    group.push(imbalance);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.row - b.row);
    let run: FootprintImbalance[] = [];
    for (const imbalance of group) {
      if (run.length === 0 || imbalance.row === run.at(-1)!.row + 1) run.push(imbalance);
      else {
        if (run.length >= minimumRows) stacks.push({ time: run[0].time, side: run[0].side, cells: run });
        run = [imbalance];
      }
    }
    if (run.length >= minimumRows) stacks.push({ time: run[0].time, side: run[0].side, cells: run });
  }
  return stacks;
}
