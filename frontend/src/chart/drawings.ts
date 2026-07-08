import type { Viewport } from "./types";

export type DrawingTool =
  | "cursor"
  | "trendline"
  | "ray"
  | "extended"
  | "hline"
  | "hray"
  | "vline"
  | "rectangle"
  | "fib"
  | "long"
  | "short";

export type ShapeTool = Exclude<DrawingTool, "cursor">;

/** A drawing anchor lives in data space so it stays put under zoom/pan. */
export interface Anchor {
  time: number;
  price: number;
}

export interface DrawingStyle {
  color: string;
  width: number;
  dashed?: boolean;
  fill?: string;
  extendLeft?: boolean;
  extendRight?: boolean;
  levels?: number[];
}

export interface DrawingObject {
  id: string;
  tool: ShapeTool;
  points: Anchor[];
  style: DrawingStyle;
  locked?: boolean;
  hidden?: boolean;
}

/** How many clicks/anchors each tool needs to be complete. */
export const TOOL_POINT_COUNT: Record<ShapeTool, number> = {
  trendline: 2,
  ray: 2,
  extended: 2,
  hline: 1,
  hray: 1,
  vline: 1,
  rectangle: 2,
  fib: 2,
  long: 3,
  short: 3
};

export const DEFAULT_FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

const TOOL_COLORS: Record<ShapeTool, string> = {
  trendline: "#4db6ff",
  ray: "#4db6ff",
  extended: "#4db6ff",
  hline: "#f7c948",
  hray: "#f7c948",
  vline: "#8f9bb3",
  rectangle: "#4db6ff",
  fib: "#f7c948",
  long: "#23c97a",
  short: "#ef5350"
};

export function defaultStyle(tool: ShapeTool): DrawingStyle {
  const style: DrawingStyle = { color: TOOL_COLORS[tool], width: 1.5 };
  if (tool === "fib") style.levels = [...DEFAULT_FIB_LEVELS];
  if (tool === "ray" || tool === "hray") style.extendRight = true;
  if (tool === "extended") {
    style.extendLeft = true;
    style.extendRight = true;
  }
  if (tool === "rectangle") style.fill = "rgba(77, 182, 255, 0.10)";
  return style;
}

export function createDrawing(tool: ShapeTool, points: Anchor[], style?: Partial<DrawingStyle>): DrawingObject {
  return {
    id: `${tool}-${Date.now().toString(36)}-${Math.floor(performance.now() % 1000)}`,
    tool,
    points,
    style: { ...defaultStyle(tool), ...style }
  };
}

export interface PixelPoint {
  x: number;
  y: number;
}

/** Project every anchor of a drawing to device pixels for the current frame. */
export function projectAnchors(viewport: Viewport, points: Anchor[]): PixelPoint[] {
  return points.map((point) => ({ x: viewport.timeToX(point.time), y: viewport.priceToY(point.price) }));
}

export function anchorFromPixel(viewport: Viewport, x: number, y: number): Anchor {
  return { time: viewport.xToTime(x), price: viewport.yToPrice(y) };
}

/** Distance from point (px,py) to segment (a,b) in pixels. */
export function distanceToSegment(px: number, py: number, a: PixelPoint, b: PixelPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - a.x, py - a.y);
  let t = ((px - a.x) * dx + (py - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}
