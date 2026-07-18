import {
  DEFAULT_FIB_LEVELS,
  projectAnchors,
  type DrawingObject,
  type PixelPoint
} from "../drawings";
import type { DraftDrawing, PlotArea, Viewport } from "../types";
import type { AnchoredVwapSeries } from "../anchoredVwap";
import { drawAnchoredVwap } from "./anchoredVwap";
import { drawTextNote, type NotePalette } from "./drawingNotes";
import { drawMeasurement } from "./measurement";
import { drawParallelChannel } from "./parallelChannel";

interface DrawOptions {
  draft?: DraftDrawing;
  selectedId?: string;
  hoveredId?: string;
  decimals: number;
  /** Theme-aware label surface colors (dark defaults when omitted). */
  notePalette?: NotePalette;
}

export function drawDrawings(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  drawings: DrawingObject[],
  anchoredVwaps: AnchoredVwapSeries,
  options: DrawOptions
) {
  ctx.save();
  drawings.forEach((drawing) => {
    if (drawing.hidden) return;
    const selected = drawing.id === options.selectedId;
    const hovered = drawing.id === options.hoveredId;
    drawShape(ctx, viewport, drawing, anchoredVwaps, options.decimals, selected, hovered, options.notePalette);
  });

  if (options.draft) {
    const points = options.draft.points;
    if (points.length >= 1) {
      drawShape(
        ctx,
        viewport,
        {
          id: "__draft__",
          tool: options.draft.tool,
          points,
          style: { color: "rgba(255,255,255,0.85)", width: 1.4, dashed: true, levels: [...DEFAULT_FIB_LEVELS] }
        },
        anchoredVwaps,
        options.decimals,
        false,
        false,
        options.notePalette
      );
    }
  }
  ctx.restore();
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  drawing: DrawingObject,
  anchoredVwaps: AnchoredVwapSeries,
  decimals: number,
  selected: boolean,
  hovered: boolean,
  notePalette?: DrawOptions["notePalette"]
) {
  const { plot } = viewport;
  const pts = projectAnchors(viewport, drawing.points);
  const color = drawing.style.color;
  ctx.lineWidth = drawing.style.width * (hovered || selected ? 1.6 : 1);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.setLineDash(drawing.style.dashed ? [5, 4] : []);

  switch (drawing.tool) {
    case "trendline":
      if (pts.length >= 2) line(ctx, pts[0], pts[1]);
      break;
    case "ray":
      if (pts.length >= 2) line(ctx, pts[0], rayExit(pts[0], sub(pts[1], pts[0]), plot));
      break;
    case "extended":
      if (pts.length >= 2) {
        line(ctx, rayExit(pts[0], sub(pts[0], pts[1]), plot), rayExit(pts[1], sub(pts[1], pts[0]), plot));
      }
      break;
    case "hline":
      horizontal(ctx, plot, pts[0].y, plot.left, plot.right);
      priceTag(ctx, plot, pts[0].y, drawing.points[0].price, decimals, color);
      break;
    case "hray":
      horizontal(ctx, plot, pts[0].y, pts[0].x, plot.right);
      priceTag(ctx, plot, pts[0].y, drawing.points[0].price, decimals, color);
      break;
    case "vline":
      vertical(ctx, plot, pts[0].x);
      break;
    case "rectangle":
      if (pts.length >= 2) rectangle(ctx, pts[0], pts[1], drawing.style.fill);
      break;
    case "fib":
      if (pts.length >= 2) fib(ctx, plot, pts[0], pts[1], drawing.points[0].price, drawing.points[1].price, drawing.style.levels ?? DEFAULT_FIB_LEVELS, decimals, color);
      break;
    case "long":
    case "short":
      position(ctx, plot, viewport, drawing, decimals);
      break;
    case "parallel-channel":
      drawParallelChannel(ctx, viewport, drawing, decimals);
      break;
    case "measure":
      if (pts.length >= 2) drawMeasurement(ctx, viewport, pts, drawing, decimals);
      break;
    case "text-note":
      drawTextNote(ctx, pts[0], drawing, selected || hovered, notePalette);
      break;
    case "anchored-vwap":
      drawAnchoredVwap(ctx, viewport, drawing, anchoredVwaps[drawing.id] ?? [], decimals, selected || hovered);
      break;
  }
  ctx.setLineDash([]);

  if (selected) pts.forEach((point) => handle(ctx, point.x, point.y, color));
}

function line(ctx: CanvasRenderingContext2D, a: PixelPoint, b: PixelPoint) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function horizontal(ctx: CanvasRenderingContext2D, plot: PlotArea, y: number, x1: number, x2: number) {
  if (y < plot.top || y > plot.bottom) return;
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
}

function vertical(ctx: CanvasRenderingContext2D, plot: PlotArea, x: number) {
  if (x < plot.left || x > plot.right) return;
  ctx.beginPath();
  ctx.moveTo(x, plot.top);
  ctx.lineTo(x, plot.bottom);
  ctx.stroke();
}

function rectangle(ctx: CanvasRenderingContext2D, a: PixelPoint, b: PixelPoint, fill?: string) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  if (fill) {
    ctx.save();
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
  ctx.strokeRect(x, y, w, h);
}

function fib(
  ctx: CanvasRenderingContext2D,
  plot: PlotArea,
  a: PixelPoint,
  b: PixelPoint,
  priceA: number,
  priceB: number,
  levels: number[],
  decimals: number,
  color: string
) {
  const left = Math.min(a.x, b.x);
  ctx.save();
  ctx.font = "11px Inter, system-ui, sans-serif";
  levels.forEach((level) => {
    const y = a.y + (b.y - a.y) * level;
    const price = priceA + (priceB - priceA) * level;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = level === 0 || level === 1 ? 0.9 : 0.5;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();
    ctx.globalAlpha = 0.85;
    ctx.fillText(`${(level * 100).toFixed(1)}%  ${price.toFixed(decimals)}`, left + 6, y - 4);
  });
  ctx.restore();
}

function position(
  ctx: CanvasRenderingContext2D,
  plot: PlotArea,
  viewport: Viewport,
  drawing: DrawingObject,
  decimals: number
) {
  const [entry, stop, target] = drawing.points;
  if (!entry || !stop || !target) return;
  const xEntry = viewport.timeToX(entry.time);
  const rightTime = Math.max(entry.time, stop.time, target.time);
  const xRight = Math.min(plot.right, viewport.timeToX(rightTime));
  const yEntry = viewport.priceToY(entry.price);
  const yStop = viewport.priceToY(stop.price);
  const yTarget = viewport.priceToY(target.price);
  const left = Math.min(xEntry, xRight);
  const width = Math.abs(xRight - xEntry);

  ctx.save();
  // Target (profit) zone.
  ctx.fillStyle = "rgba(35, 201, 122, 0.16)";
  ctx.fillRect(left, Math.min(yEntry, yTarget), width, Math.abs(yTarget - yEntry));
  // Stop (loss) zone.
  ctx.fillStyle = "rgba(239, 83, 80, 0.16)";
  ctx.fillRect(left, Math.min(yEntry, yStop), width, Math.abs(yStop - yEntry));

  ctx.strokeStyle = "#c9d4de";
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(left, yEntry);
  ctx.lineTo(left + width, yEntry);
  ctx.stroke();
  ctx.setLineDash([]);

  const risk = Math.abs(entry.price - stop.price);
  const reward = Math.abs(target.price - entry.price);
  const rr = risk > 0 ? (reward / risk).toFixed(2) : "∞";
  ctx.fillStyle = "#e5edf4";
  ctx.font = "600 11px Inter, system-ui, sans-serif";
  ctx.fillText(
    `${drawing.tool === "long" ? "Long" : "Short"}  R:R ${rr}  •  T ${target.price.toFixed(decimals)} / S ${stop.price.toFixed(decimals)}`,
    left + 6,
    Math.min(yEntry, yTarget) - 6
  );
  ctx.restore();
}

function priceTag(
  ctx: CanvasRenderingContext2D,
  plot: PlotArea,
  y: number,
  price: number,
  decimals: number,
  color: string
) {
  if (y < plot.top || y > plot.bottom) return;
  const label = price.toFixed(decimals);
  ctx.save();
  ctx.font = "600 11px Inter, system-ui, sans-serif";
  const w = ctx.measureText(label).width + 10;
  ctx.fillStyle = color;
  ctx.fillRect(plot.right + 4, y - 8, w, 16);
  ctx.fillStyle = "#0b0d10";
  ctx.textBaseline = "middle";
  ctx.fillText(label, plot.right + 9, y);
  ctx.restore();
}

function handle(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.save();
  ctx.fillStyle = "#0b0d10";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.rect(x - 3.5, y - 3.5, 7, 7);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function sub(a: PixelPoint, b: PixelPoint): PixelPoint {
  return { x: a.x - b.x, y: a.y - b.y };
}

/** Point where a ray from `from` in direction `dir` exits the plot rect. */
function rayExit(from: PixelPoint, dir: PixelPoint, plot: PlotArea): PixelPoint {
  let t = Infinity;
  if (dir.x > 0) t = Math.min(t, (plot.right - from.x) / dir.x);
  else if (dir.x < 0) t = Math.min(t, (plot.left - from.x) / dir.x);
  if (dir.y > 0) t = Math.min(t, (plot.bottom - from.y) / dir.y);
  else if (dir.y < 0) t = Math.min(t, (plot.top - from.y) / dir.y);
  if (!Number.isFinite(t) || t < 0) t = 0;
  return { x: from.x + dir.x * t, y: from.y + dir.y * t };
}
