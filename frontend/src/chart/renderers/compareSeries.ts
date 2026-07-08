import type { Candle } from "../../types";
import type { ChartTheme, CompareLegendSnapshot, CompareSeries, PlotArea, Viewport } from "../types";

interface CompareInput {
  /** The base chart's visible candles (already sliced to [start, end)). */
  baseVisible: Candle[];
  baseSymbol: string;
  baseColor: string;
  series: CompareSeries[];
  theme: ChartTheme;
}

interface NormalizedLine {
  symbol: string;
  color: string;
  /** % change from the first visible bar, indexed to match `baseVisible`. */
  values: Array<number | undefined>;
  /** Latest defined % over the visible window (for the legend). */
  currentPct?: number;
}

/**
 * Overlays one or more compare symbols on the price pane, normalized to %
 * change from the FIRST VISIBLE BAR so the comparison re-bases as you scroll.
 *
 * Because compare lines share the price pane but live on a % scale, we compute a
 * shared min/max % across the base symbol + every compare series over the
 * visible window and map % -> pixel Y into the pane's vertical space. A compact
 * right-side "%" axis and a legend (symbol · %change · swatch) describe the
 * scale.
 *
 * Alignment: compare bars are matched to the base window BY TIMESTAMP via a
 * lookup map (compare and base share timeframe + exchange, so bar cadence
 * matches). Base timestamps with no compare bar are left as gaps rather than
 * interpolated — simple and correct for aligned feeds; occasional missing bars
 * just break the line briefly.
 */
export function drawCompareSeries(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  input: CompareInput
): CompareLegendSnapshot[] {
  const { plot } = viewport;
  const base = input.baseVisible;
  if (base.length === 0 || input.series.length === 0) return [];

  const baseFirst = base[0]?.close;
  if (!Number.isFinite(baseFirst) || baseFirst === 0) return [];

  // Base symbol itself, normalized, so the % axis frames all lines together.
  const baseLine: NormalizedLine = {
    symbol: input.baseSymbol,
    color: input.baseColor,
    values: base.map((candle) => (candle.close / baseFirst - 1) * 100)
  };
  baseLine.currentPct = lastDefined(baseLine.values);

  const compareLines: NormalizedLine[] = input.series.map((entry) =>
    normalize(entry, base)
  );

  // Shared % range across base + compares over the visible window.
  const allValues = [baseLine, ...compareLines].flatMap((line) => line.values);
  const finite = allValues.filter(
    (value): value is number => value !== undefined && Number.isFinite(value)
  );
  if (finite.length === 0) return [];
  let min = Math.min(...finite, 0);
  let max = Math.max(...finite, 0);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.08;
  min -= pad;
  max += pad;
  const span = max - min || 1;
  const pctToY = (pct: number) => plot.top + ((max - pct) / span) * plot.height;
  const step = viewport.barSpacing;

  ctx.save();

  // Faint 0% baseline so relative moves read against a fixed reference.
  const zeroY = pctToY(0);
  if (zeroY >= plot.top && zeroY <= plot.bottom) {
    ctx.strokeStyle = input.theme.grid;
    ctx.setLineDash([2, 4]);
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(plot.left, zeroY);
    ctx.lineTo(plot.right, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // Only the compare lines are drawn as overlays — the base symbol keeps its
  // native candles/price line and is included purely for scaling + legend.
  for (const line of compareLines) {
    ctx.strokeStyle = line.color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let started = false;
    line.values.forEach((value, index) => {
      if (value === undefined || !Number.isFinite(value)) {
        started = false;
        return;
      }
      const x = plot.left + index * step + step / 2;
      const y = pctToY(value);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  }

  drawPercentAxis(ctx, plot, min, max, pctToY, input.theme);
  ctx.restore();
  ctx.lineWidth = 1;

  // Legend entries flow back to the React overlay (interactive remove ✕).
  return [
    { symbol: baseLine.symbol, color: baseLine.color, pct: baseLine.currentPct, base: true },
    ...compareLines.map((line) => ({
      symbol: line.symbol,
      color: line.color,
      pct: line.currentPct,
      base: false
    }))
  ];
}

/** Normalize a compare series onto the base visible window, aligned by time. */
function normalize(entry: CompareSeries, base: Candle[]): NormalizedLine {
  const closeByTime = new Map<number, number>();
  for (const candle of entry.candles) closeByTime.set(candle.time, candle.close);

  // Baseline = the compare close at (or nearest before) the first visible base bar.
  const firstTime = base[0].time;
  let first = closeByTime.get(firstTime);
  if (first === undefined) first = nearestBefore(entry.candles, firstTime);

  const values: Array<number | undefined> = base.map((candle) => {
    if (first === undefined || first === 0) return undefined;
    let close = closeByTime.get(candle.time);
    if (close === undefined) close = nearestBefore(entry.candles, candle.time);
    if (close === undefined) return undefined;
    return (close / first - 1) * 100;
  });

  return {
    symbol: entry.symbol,
    color: entry.color,
    values,
    currentPct: lastDefined(values)
  };
}

/** Latest candle close at or before `time` (candles assumed time-ascending). */
function nearestBefore(candles: Candle[], time: number): number | undefined {
  let result: number | undefined;
  for (const candle of candles) {
    if (candle.time > time) break;
    result = candle.close;
  }
  return result;
}

function lastDefined(values: Array<number | undefined>): number | undefined {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (values[i] !== undefined && Number.isFinite(values[i] as number)) return values[i];
  }
  return undefined;
}

/** Compact right-edge % axis for the compare scale (distinct from the price axis). */
function drawPercentAxis(
  ctx: CanvasRenderingContext2D,
  plot: PlotArea,
  min: number,
  max: number,
  pctToY: (pct: number) => number,
  theme: ChartTheme
) {
  const ticks = percentTicks(min, max);
  ctx.font = '9px "SF Mono", SFMono-Regular, ui-monospace, Menlo, Consolas, monospace';
  ctx.textBaseline = "middle";
  // Right-align just INSIDE the plot's right edge so the compare % scale never
  // collides with the native price axis that owns the right gutter.
  ctx.textAlign = "right";
  for (const pct of ticks) {
    const y = pctToY(pct);
    if (y < plot.top - 1 || y > plot.bottom + 1) continue;
    ctx.fillStyle = theme.muted;
    ctx.globalAlpha = 0.75;
    const label = `${pct > 0 ? "+" : ""}${pct.toFixed(pct % 1 === 0 ? 0 : 1)}%`;
    ctx.fillText(label, plot.right - 4, y);
    ctx.globalAlpha = 1;
  }
  ctx.textAlign = "left";
}

/** A few rounded % gridline values across [min, max]. */
function percentTicks(min: number, max: number): number[] {
  const rough = (max - min) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(Math.abs(rough) || 1));
  const normalized = rough / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = nice * magnitude || 1;
  const ticks: number[] = [];
  const first = Math.ceil(min / step) * step;
  for (let value = first; value <= max + step * 0.001; value += step) {
    ticks.push(Number(value.toFixed(6)));
  }
  return ticks;
}
