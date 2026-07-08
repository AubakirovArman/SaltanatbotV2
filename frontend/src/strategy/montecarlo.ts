import type { BacktestConfig, Trade } from "./backtest";

/**
 * Monte Carlo robustness for a backtest's per-trade PnL sequence.
 *
 * We bootstrap-resample the realised trade PnLs (sample WITH replacement and in
 * random order), rebuild an equity path from `initialCapital`, and report the
 * spread of outcomes across many synthetic paths. This exposes how much of a
 * result is luck-of-ordering vs. genuine edge, and how close the strategy came
 * to ruin on unlucky draws.
 *
 * Determinism: the PRNG is seeded from a fixed constant XORed with the trade
 * count, so the same trades always produce the same percentiles (important for
 * tests). `Math.random` is never used.
 */

/** mulberry32 — tiny, fast, well-distributed seeded PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MonteCarloStats {
  runs: number;
  tradesPerRun: number;
  netProfit: { p5: number; p50: number; p95: number };
  maxDrawdownPct: { p5: number; p50: number; p95: number };
  /** Fraction of paths whose equity ever hit <= 0. */
  riskOfRuin: number;
  /** Fraction of paths whose equity ever dropped >= 50% below initial capital. */
  riskOfHalf: number;
  /** p5 / p50 / p95 final-equity paths for optional percentile bands (aligned to trade index 0..tradesPerRun). */
  bands?: { p5: number[]; p50: number[]; p95: number[] };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

export function monteCarlo(
  trades: Trade[],
  config: Pick<BacktestConfig, "initialCapital">,
  runs = 1000
): MonteCarloStats | null {
  const pnls = trades.map((trade) => trade.pnl);
  if (pnls.length < 2 || runs < 1) return null;

  const seed = (0x9e3779b9 ^ (pnls.length * 2654435761)) >>> 0;
  const rand = mulberry32(seed);
  const initial = config.initialCapital;

  const netProfits: number[] = [];
  const maxDrawdowns: number[] = [];
  let ruinCount = 0;
  let halfCount = 0;

  // Collect terminal equity across paths at each trade step for percentile bands.
  const stepEquities: number[][] = Array.from({ length: pnls.length }, () => []);

  for (let run = 0; run < runs; run += 1) {
    let equity = initial;
    let peak = initial;
    let maxDdPct = 0;
    let hitRuin = false;
    let hitHalf = false;
    for (let t = 0; t < pnls.length; t += 1) {
      const pick = pnls[Math.floor(rand() * pnls.length)];
      equity += pick;
      stepEquities[t].push(equity);
      if (equity <= 0) hitRuin = true;
      if (equity <= initial * 0.5) hitHalf = true;
      peak = Math.max(peak, equity);
      const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
      if (dd > maxDdPct) maxDdPct = dd;
    }
    netProfits.push(equity - initial);
    maxDrawdowns.push(maxDdPct);
    if (hitRuin) ruinCount += 1;
    if (hitHalf) halfCount += 1;
  }

  netProfits.sort((a, b) => a - b);
  maxDrawdowns.sort((a, b) => a - b);

  const p5Band = stepEquities.map((step) => {
    const s = [...step].sort((a, b) => a - b);
    return percentile(s, 5);
  });
  const p50Band = stepEquities.map((step) => {
    const s = [...step].sort((a, b) => a - b);
    return percentile(s, 50);
  });
  const p95Band = stepEquities.map((step) => {
    const s = [...step].sort((a, b) => a - b);
    return percentile(s, 95);
  });

  return {
    runs,
    tradesPerRun: pnls.length,
    netProfit: {
      p5: percentile(netProfits, 5),
      p50: percentile(netProfits, 50),
      p95: percentile(netProfits, 95)
    },
    maxDrawdownPct: {
      p5: percentile(maxDrawdowns, 5),
      p50: percentile(maxDrawdowns, 50),
      p95: percentile(maxDrawdowns, 95)
    },
    riskOfRuin: ruinCount / runs,
    riskOfHalf: halfCount / runs,
    bands: { p5: p5Band, p50: p50Band, p95: p95Band }
  };
}
