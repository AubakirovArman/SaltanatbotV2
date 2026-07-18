import { Activity, Anchor as AnchorIcon, BookOpen, Equal, Layers3, Magnet, MousePointer2, Move, MoveDiagonal, MoveHorizontal, MoveVertical, Ratio, RectangleHorizontal, Ruler, Scaling, StickyNote, Trash2, TrendingDown, TrendingUp, type LucideIcon } from "lucide-react";
import type { DrawingTool } from "../../chart/drawings";
import type { ShellMessageKey } from "../../i18n/shell";

export type DrawingToolbarAction = "magnet" | "volume" | "order-book" | "trade-footprint" | "objects" | "delete-all";
export type DrawingToolbarItemId = DrawingTool | DrawingToolbarAction;
export type DrawingToolbarGroup = "navigation" | "lines" | "shapes" | "positions" | "measure" | "view" | "manage";

interface DrawingToolbarItemBase {
  group: DrawingToolbarGroup;
  labelKey: ShellMessageKey;
  Icon: LucideIcon;
  iconClassName?: string;
}

export type DrawingToolbarItem = (DrawingToolbarItemBase & { id: DrawingTool; kind: "tool" }) | (DrawingToolbarItemBase & { id: DrawingToolbarAction; kind: "action" });

export const DRAWING_TOOL_CATALOG: readonly DrawingToolbarItem[] = [
  { id: "cursor", kind: "tool", group: "navigation", labelKey: "cursor", Icon: MousePointer2 },
  { id: "trendline", kind: "tool", group: "lines", labelKey: "trendLine", Icon: TrendingUp },
  { id: "ray", kind: "tool", group: "lines", labelKey: "ray", Icon: Move },
  { id: "extended", kind: "tool", group: "lines", labelKey: "extendedLine", Icon: MoveDiagonal },
  { id: "parallel-channel", kind: "tool", group: "lines", labelKey: "parallelChannel", Icon: Equal },
  { id: "hline", kind: "tool", group: "lines", labelKey: "horizontalLine", Icon: MoveHorizontal },
  { id: "hray", kind: "tool", group: "lines", labelKey: "horizontalRay", Icon: MoveHorizontal, iconClassName: "ic-ray" },
  { id: "vline", kind: "tool", group: "lines", labelKey: "verticalLine", Icon: MoveVertical },
  { id: "rectangle", kind: "tool", group: "shapes", labelKey: "rectangle", Icon: RectangleHorizontal },
  { id: "fib", kind: "tool", group: "shapes", labelKey: "fibonacci", Icon: Ratio },
  { id: "anchored-vwap", kind: "tool", group: "shapes", labelKey: "anchoredVwap", Icon: AnchorIcon },
  { id: "long", kind: "tool", group: "positions", labelKey: "longPosition", Icon: TrendingUp, iconClassName: "ic-up" },
  { id: "short", kind: "tool", group: "positions", labelKey: "shortPosition", Icon: TrendingDown, iconClassName: "ic-down" },
  { id: "measure", kind: "tool", group: "measure", labelKey: "measure", Icon: Ruler },
  { id: "text-note", kind: "tool", group: "measure", labelKey: "textNote", Icon: StickyNote },
  { id: "magnet", kind: "action", group: "view", labelKey: "magnet", Icon: Magnet },
  { id: "volume", kind: "action", group: "view", labelKey: "toggleVolume", Icon: Scaling },
  { id: "order-book", kind: "action", group: "view", labelKey: "toggleOrderBookHeatmap", Icon: BookOpen },
  { id: "trade-footprint", kind: "action", group: "view", labelKey: "toggleTradeFootprint", Icon: Activity },
  { id: "objects", kind: "action", group: "manage", labelKey: "drawingObjects", Icon: Layers3 },
  { id: "delete-all", kind: "action", group: "manage", labelKey: "deleteDrawings", Icon: Trash2 }
] as const;

// Derived by kind/group rather than positional slices so catalog growth cannot skew the rail.
export const DRAWING_TOOL_ITEMS = DRAWING_TOOL_CATALOG.filter((item) => item.kind === "tool");
export const DRAWING_VIEW_ITEMS = DRAWING_TOOL_CATALOG.filter((item) => item.kind === "action" && item.group === "view");
export const DRAWING_MANAGE_ITEMS = DRAWING_TOOL_CATALOG.filter((item) => item.kind === "action" && item.group === "manage");

export const DRAWING_GROUP_ORDER: readonly DrawingToolbarGroup[] = ["navigation", "lines", "shapes", "positions", "measure", "view", "manage"];

export const DRAWING_GROUP_LABEL_KEYS: Record<DrawingToolbarGroup, ShellMessageKey> = {
  navigation: "cursor",
  lines: "drawingLines",
  shapes: "drawingShapes",
  positions: "drawingPositions",
  measure: "measure",
  view: "view",
  manage: "drawingObjects"
};

export function drawingToolLabelKey(tool: DrawingTool): ShellMessageKey {
  return DRAWING_TOOL_CATALOG.find((item) => item.id === tool)?.labelKey ?? "drawingTools";
}
