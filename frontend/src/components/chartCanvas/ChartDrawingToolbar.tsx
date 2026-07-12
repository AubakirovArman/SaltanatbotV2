import { BarChart3, Layers3, Magnet, MousePointer2, Move, MoveDiagonal, MoveHorizontal, MoveVertical, Ratio, RectangleHorizontal, Ruler, Scaling, TrendingDown, TrendingUp, Trash2 } from "lucide-react";
import type { DrawingTool } from "../../chart/drawings";
import type { Locale } from "../../i18n";
import { shellText } from "../../i18n/shell";

export function ChartDrawingToolbar({
  locale,
  tool,
  magnet,
  showVolume,
  showVolumeProfile,
  showObjects,
  hasDrawings,
  onTool,
  onToggleMagnet,
  onToggleVolume,
  onToggleVolumeProfile,
  onToggleObjects,
  onDeleteAll
}: {
  locale: Locale;
  tool: DrawingTool;
  magnet: boolean;
  showVolume: boolean;
  showVolumeProfile: boolean;
  showObjects: boolean;
  hasDrawings: boolean;
  onTool: (tool: DrawingTool) => void;
  onToggleMagnet: () => void;
  onToggleVolume: () => void;
  onToggleVolumeProfile: () => void;
  onToggleObjects: () => void;
  onDeleteAll: () => void;
}) {
  const t = (key: Parameters<typeof shellText>[1]) => shellText(locale, key);
  return (
    <div className="tool-rail" aria-label={t("drawingTools")}>
      <Tool active={tool === "cursor"} label={t("cursor")} onClick={() => onTool("cursor")}>
        <MousePointer2 size={15} aria-hidden="true" />
      </Tool>
      <Tool active={tool === "trendline"} label={t("trendLine")} onClick={() => onTool("trendline")}>
        <TrendingUp size={15} aria-hidden="true" />
      </Tool>
      <Tool active={tool === "ray"} label={t("ray")} onClick={() => onTool("ray")}>
        <Move size={15} aria-hidden="true" />
      </Tool>
      <Tool active={tool === "extended"} label={t("extendedLine")} onClick={() => onTool("extended")}>
        <MoveDiagonal size={15} aria-hidden="true" />
      </Tool>
      <Tool active={tool === "hline"} label={t("horizontalLine")} onClick={() => onTool("hline")}>
        <MoveHorizontal size={15} aria-hidden="true" />
      </Tool>
      <Tool active={tool === "hray"} label={t("horizontalRay")} onClick={() => onTool("hray")}>
        <MoveHorizontal size={15} aria-hidden="true" className="ic-ray" />
      </Tool>
      <Tool active={tool === "vline"} label={t("verticalLine")} onClick={() => onTool("vline")}>
        <MoveVertical size={15} aria-hidden="true" />
      </Tool>
      <Tool active={tool === "rectangle"} label={t("rectangle")} onClick={() => onTool("rectangle")}>
        <RectangleHorizontal size={15} aria-hidden="true" />
      </Tool>
      <Tool active={tool === "fib"} label={t("fibonacci")} onClick={() => onTool("fib")}>
        <Ratio size={15} aria-hidden="true" />
      </Tool>
      <Tool active={tool === "long"} label={t("longPosition")} onClick={() => onTool("long")}>
        <TrendingUp size={15} aria-hidden="true" className="ic-up" />
      </Tool>
      <Tool active={tool === "short"} label={t("shortPosition")} onClick={() => onTool("short")}>
        <TrendingDown size={15} aria-hidden="true" className="ic-down" />
      </Tool>
      <Tool active={tool === "measure"} label={t("measure")} onClick={() => onTool("measure")}>
        <Ruler size={15} aria-hidden="true" />
      </Tool>
      <span className="rail-divider" aria-hidden="true" />
      <Tool active={magnet} label={t("magnet")} onClick={onToggleMagnet}>
        <Magnet size={15} aria-hidden="true" />
      </Tool>
      <span className="rail-spacer" aria-hidden="true" />
      <Tool active={showVolume} label={t("toggleVolume")} onClick={onToggleVolume}>
        <Scaling size={15} aria-hidden="true" />
      </Tool>
      <Tool active={showVolumeProfile} label={t("toggleVolumeProfile")} onClick={onToggleVolumeProfile}>
        <BarChart3 size={15} aria-hidden="true" />
      </Tool>
      <Tool active={showObjects} label={t("drawingObjects")} onClick={onToggleObjects}>
        <Layers3 size={15} aria-hidden="true" />
      </Tool>
      <button type="button" className="rail-trash" disabled={!hasDrawings} aria-label={t("deleteDrawings")} title={t("deleteDrawings")} onClick={onDeleteAll}>
        <Trash2 size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

function Tool({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={active ? "active" : ""} aria-pressed={active} aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}
