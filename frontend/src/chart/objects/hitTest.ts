import { distanceToSegment, projectAnchors, type DrawingObject, type PixelPoint } from "../drawings";
import type { PlotArea, Viewport } from "../types";

export interface HitResult {
  id: string;
  /** Index of the anchor handle grabbed, or "body" for the whole object. */
  part: number | "body";
}

const HANDLE_RADIUS = 7;
const LINE_TOLERANCE = 6;

/** Top-most drawing under (x, y), preferring anchor handles of the selected one. */
export function hitTest(
  viewport: Viewport,
  drawings: DrawingObject[],
  x: number,
  y: number,
  selectedId?: string
): HitResult | null {
  // Handles of the selected object win, so you can always grab an endpoint.
  if (selectedId) {
    const selected = drawings.find((drawing) => drawing.id === selectedId);
    if (selected && !selected.locked && !selected.hidden) {
      const handle = handleHit(viewport, selected, x, y);
      if (handle) return handle;
    }
  }

  for (let index = drawings.length - 1; index >= 0; index -= 1) {
    const drawing = drawings[index];
    if (drawing.hidden || drawing.locked) continue;
    const handle = handleHit(viewport, drawing, x, y);
    if (handle) return handle;
    if (bodyHit(viewport, drawing, x, y)) return { id: drawing.id, part: "body" };
  }
  return null;
}

function handleHit(viewport: Viewport, drawing: DrawingObject, x: number, y: number): HitResult | null {
  const pts = projectAnchors(viewport, drawing.points);
  for (let i = 0; i < pts.length; i += 1) {
    if (Math.hypot(pts[i].x - x, pts[i].y - y) <= HANDLE_RADIUS) {
      return { id: drawing.id, part: i };
    }
  }
  return null;
}

function bodyHit(viewport: Viewport, drawing: DrawingObject, x: number, y: number): boolean {
  const { plot } = viewport;
  const pts = projectAnchors(viewport, drawing.points);
  switch (drawing.tool) {
    case "trendline":
    case "measure":
      return pts.length >= 2 && distanceToSegment(x, y, pts[0], pts[1]) <= LINE_TOLERANCE;
    case "ray":
      return pts.length >= 2 && distanceToSegment(x, y, pts[0], rayExit(pts[0], sub(pts[1], pts[0]), plot)) <= LINE_TOLERANCE;
    case "extended":
      return (
        pts.length >= 2 &&
        distanceToSegment(x, y, rayExit(pts[0], sub(pts[0], pts[1]), plot), rayExit(pts[1], sub(pts[1], pts[0]), plot)) <= LINE_TOLERANCE
      );
    case "hline":
      return Math.abs(y - pts[0].y) <= LINE_TOLERANCE;
    case "hray":
      return x >= pts[0].x - LINE_TOLERANCE && Math.abs(y - pts[0].y) <= LINE_TOLERANCE;
    case "vline":
      return Math.abs(x - pts[0].x) <= LINE_TOLERANCE;
    case "rectangle":
      return pts.length >= 2 && insideRect(x, y, pts[0], pts[1], 6);
    case "fib":
      return pts.length >= 2 && fibHit(x, y, pts[0], pts[1], drawing.style.levels ?? [], plot);
    case "long":
    case "short":
      return positionHit(x, y, viewport, drawing);
    default:
      return false;
  }
}

function fibHit(x: number, y: number, a: PixelPoint, b: PixelPoint, levels: number[], plot: PlotArea): boolean {
  const left = Math.min(a.x, b.x);
  if (x < left - LINE_TOLERANCE || x > plot.right) return false;
  return levels.some((level) => Math.abs(y - (a.y + (b.y - a.y) * level)) <= LINE_TOLERANCE);
}

function positionHit(x: number, y: number, viewport: Viewport, drawing: DrawingObject): boolean {
  const [entry, stop, target] = drawing.points;
  if (!entry || !stop || !target) return false;
  const xEntry = viewport.timeToX(entry.time);
  const xRight = viewport.timeToX(Math.max(entry.time, stop.time, target.time));
  const left = Math.min(xEntry, xRight);
  const right = Math.max(xEntry, xRight);
  const top = viewport.priceToY(Math.max(target.price, stop.price));
  const bottom = viewport.priceToY(Math.min(target.price, stop.price));
  return x >= left && x <= right && y >= top && y <= bottom;
}

function insideRect(x: number, y: number, a: PixelPoint, b: PixelPoint, pad: number): boolean {
  const left = Math.min(a.x, b.x) - pad;
  const right = Math.max(a.x, b.x) + pad;
  const top = Math.min(a.y, b.y) - pad;
  const bottom = Math.max(a.y, b.y) + pad;
  return x >= left && x <= right && y >= top && y <= bottom;
}

function sub(a: PixelPoint, b: PixelPoint): PixelPoint {
  return { x: a.x - b.x, y: a.y - b.y };
}

function rayExit(from: PixelPoint, dir: PixelPoint, plot: PlotArea): PixelPoint {
  let t = Infinity;
  if (dir.x > 0) t = Math.min(t, (plot.right - from.x) / dir.x);
  else if (dir.x < 0) t = Math.min(t, (plot.left - from.x) / dir.x);
  if (dir.y > 0) t = Math.min(t, (plot.bottom - from.y) / dir.y);
  else if (dir.y < 0) t = Math.min(t, (plot.top - from.y) / dir.y);
  if (!Number.isFinite(t) || t < 0) t = 0;
  return { x: from.x + dir.x * t, y: from.y + dir.y * t };
}
