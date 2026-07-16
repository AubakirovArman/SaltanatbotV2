import { ChevronUp, Layers3, Redo2, Trash2, Undo2 } from "lucide-react";
import { useEffect, useId, useState, type CSSProperties } from "react";
import type { DrawingTool } from "../../chart/drawings";
import { MOBILE_SHELL_MEDIA_QUERY, useMediaQuery } from "../../hooks/useMediaQuery";
import type { Locale } from "../../i18n";
import { shellText } from "../../i18n/shell";
import { MobilePanelDialog } from "../MobilePanelDialog";
import { DRAWING_GROUP_LABEL_KEYS, DRAWING_GROUP_ORDER, DRAWING_MANAGE_ITEMS, DRAWING_TOOL_CATALOG, DRAWING_TOOL_ITEMS, DRAWING_VIEW_ITEMS, drawingToolLabelKey, type DrawingToolbarAction, type DrawingToolbarItem } from "./drawingToolCatalog";

export interface ChartDrawingToolbarProps {
  locale: Locale;
  tool: DrawingTool;
  magnet: boolean;
  showVolume: boolean;
  showOrderBookHeatmap: boolean;
  showTradeFootprint: boolean;
  orderBookAvailable: boolean;
  showObjects: boolean;
  hasDrawings: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  hasSelectedDrawing?: boolean;
  onTool: (tool: DrawingTool) => void;
  onToggleMagnet: () => void;
  onToggleVolume: () => void;
  onToggleOrderBookHeatmap: () => void;
  onToggleTradeFootprint: () => void;
  onToggleObjects: () => void;
  onDeleteAll: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onDeleteSelected?: () => void;
}

interface ResolvedToolbarItem {
  pressed?: boolean;
  disabled: boolean;
  label: string;
  run: () => void;
}

const MOBILE_TOOLBAR_STYLE: CSSProperties = {
  minHeight: 52,
  alignItems: "center",
  gap: 4,
  paddingBlock: 4,
  paddingInline: "max(8px, env(safe-area-inset-left)) max(8px, env(safe-area-inset-right))",
  borderBlockEnd: "1px solid var(--line)",
  background: "var(--panel)",
  overflowX: "auto"
};
const MOBILE_BUTTON_STYLE: CSSProperties = {
  minHeight: 44,
  border: "1px solid var(--line-soft)",
  borderRadius: "var(--radius)",
  background: "var(--panel-soft)",
  color: "var(--muted)"
};
const MOBILE_SHEET_STYLE: CSSProperties = { height: "100%", minHeight: 0, display: "grid", gridTemplateRows: "auto minmax(0, 1fr)", gap: 10, padding: "8px 10px max(10px, env(safe-area-inset-bottom))" };
const MOBILE_GROUPS_STYLE: CSSProperties = { minHeight: 0, width: "100%", maxWidth: "none" };

export function ChartDrawingToolbar({
  locale,
  tool,
  magnet,
  showVolume,
  showOrderBookHeatmap,
  showTradeFootprint,
  orderBookAvailable,
  showObjects,
  hasDrawings,
  canUndo = false,
  canRedo = false,
  hasSelectedDrawing = false,
  onTool,
  onToggleMagnet,
  onToggleVolume,
  onToggleOrderBookHeatmap,
  onToggleTradeFootprint,
  onToggleObjects,
  onDeleteAll,
  onUndo,
  onRedo,
  onDeleteSelected
}: ChartDrawingToolbarProps) {
  const t = (key: Parameters<typeof shellText>[1]) => shellText(locale, key);
  const sheetId = useId();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [query, setQuery] = useState("");
  const mobileShell = useMediaQuery(MOBILE_SHELL_MEDIA_QUERY);

  useEffect(() => {
    if (!mobileShell) setSheetOpen(false);
  }, [mobileShell]);

  const resolveItem = (item: DrawingToolbarItem): ResolvedToolbarItem => {
    const label = t(item.labelKey);
    if (item.kind === "tool") {
      return {
        pressed: tool === item.id,
        disabled: false,
        label,
        run: () => onTool(item.id)
      };
    }

    const action = resolveAction(item.id, {
      magnet,
      showVolume,
      showOrderBookHeatmap,
      showTradeFootprint,
      orderBookAvailable,
      showObjects,
      hasDrawings,
      onToggleMagnet,
      onToggleVolume,
      onToggleOrderBookHeatmap,
      onToggleTradeFootprint,
      onToggleObjects,
      onDeleteAll
    });
    return { ...action, label };
  };

  const normalizedQuery = query.trim().toLowerCase();
  const visibleGroups = DRAWING_GROUP_ORDER.map((group) => {
    const groupLabel = t(DRAWING_GROUP_LABEL_KEYS[group]);
    const items = DRAWING_TOOL_CATALOG.filter((item) => {
      if (item.group !== group) return false;
      if (!normalizedQuery) return true;
      return `${t(item.labelKey)} ${groupLabel}`.toLowerCase().includes(normalizedQuery);
    });
    return { group, groupLabel, items };
  }).filter(({ items }) => items.length > 0);

  const activeTool = DRAWING_TOOL_CATALOG.find((item) => item.id === tool) ?? DRAWING_TOOL_CATALOG[0];
  const ActiveToolIcon = activeTool.Icon;

  const runMobileItem = (item: DrawingToolbarItem) => {
    resolveItem(item).run();
    setSheetOpen(false);
  };

  return (
    <>
      <div className="tool-rail" role="toolbar" aria-orientation="vertical" aria-label={t("drawingTools")}>
        {DRAWING_TOOL_ITEMS.map((item) => (
          <CatalogButton key={item.id} item={item} state={resolveItem(item)} />
        ))}
        <span className="rail-divider" aria-hidden="true" />
        {DRAWING_VIEW_ITEMS.slice(0, 1).map((item) => (
          <CatalogButton key={item.id} item={item} state={resolveItem(item)} />
        ))}
        <span className="rail-spacer" aria-hidden="true" />
        {DRAWING_VIEW_ITEMS.slice(1).map((item) => (
          <CatalogButton key={item.id} item={item} state={resolveItem(item)} />
        ))}
        {DRAWING_MANAGE_ITEMS.map((item) => (
          <CatalogButton key={item.id} item={item} state={resolveItem(item)} />
        ))}
      </div>

      <div className="mobile-drawing-toolbar" style={MOBILE_TOOLBAR_STYLE} role="toolbar" aria-label={t("drawingTools")}>
        <button
          type="button"
          className={`mobile-drawing-tools-trigger ${tool !== "cursor" ? "active" : ""}`}
          style={{
            ...MOBILE_BUTTON_STYLE,
            flex: "1 1 7rem",
            minWidth: "6rem",
            display: "flex",
            alignItems: "center",
            gap: 7,
            paddingInline: 9,
            textAlign: "start",
            ...(tool !== "cursor" ? { borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" } : {})
          }}
          aria-controls={sheetId}
          aria-expanded={sheetOpen}
          aria-haspopup="dialog"
          onClick={() => {
            setQuery("");
            setSheetOpen(true);
          }}
        >
          <ActiveToolIcon size={18} className={activeTool.iconClassName} aria-hidden="true" />
          <span className="mobile-drawing-trigger-copy" style={{ minWidth: 0, display: "grid", flex: 1, lineHeight: 1.05 }}>
            <small style={{ overflow: "hidden", color: "var(--dim)", fontSize: 9, textOverflow: "ellipsis", textTransform: "uppercase", whiteSpace: "nowrap" }}>{t("drawingTools")}</small>
            <strong style={{ overflow: "hidden", fontSize: "var(--fs-xs)", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t(drawingToolLabelKey(tool))}</strong>
          </span>
          <ChevronUp size={15} aria-hidden="true" />
        </button>
        <QuickAction label={t("undoDrawing")} disabled={!canUndo || !onUndo} onClick={onUndo}>
          <Undo2 size={18} aria-hidden="true" />
        </QuickAction>
        <QuickAction label={t("redoDrawing")} disabled={!canRedo || !onRedo} onClick={onRedo}>
          <Redo2 size={18} aria-hidden="true" />
        </QuickAction>
        <QuickAction label={t("deleteDrawing")} disabled={!hasSelectedDrawing || !onDeleteSelected} onClick={onDeleteSelected}>
          <Trash2 size={18} aria-hidden="true" />
        </QuickAction>
        <QuickAction label={t("drawingObjects")} pressed={showObjects} onClick={onToggleObjects}>
          <Layers3 size={18} aria-hidden="true" />
        </QuickAction>
      </div>

      <MobilePanelDialog id={sheetId} open={sheetOpen} label={t("drawingTools")} closeLabel={t("closeHint")} initialFocus=".mobile-drawing-search" onClose={() => setSheetOpen(false)}>
        <section className="mobile-drawing-tools-sheet" style={MOBILE_SHEET_STYLE}>
          <label className="market-search">
            <span className="sr-only">{t("searchDrawingTools")}</span>
            <input className="mobile-drawing-search" type="search" value={query} placeholder={t("searchDrawingTools")} autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
          </label>
          <div className="mobile-drawing-groups indicator-menu" style={MOBILE_GROUPS_STYLE}>
            {visibleGroups.map(({ group, groupLabel, items }) => (
              <section key={group} style={{ display: "contents" }} aria-labelledby={`${sheetId}-${group}`}>
                <strong id={`${sheetId}-${group}`} className="menu-group-title">
                  {groupLabel}
                </strong>
                {items.map((item) => {
                  const state = resolveItem(item);
                  const Icon = item.Icon;
                  return (
                    <button key={item.id} type="button" className={state.pressed ? "active" : ""} style={state.pressed ? { background: "var(--accent-soft)", color: "var(--accent)" } : undefined} disabled={state.disabled} aria-label={state.label} aria-pressed={state.pressed} onClick={() => runMobileItem(item)}>
                      <Icon size={14} className={item.iconClassName} aria-hidden="true" />
                      <strong>{state.label}</strong>
                    </button>
                  );
                })}
              </section>
            ))}
            {visibleGroups.length === 0 && (
              <p className="mobile-drawing-empty" style={{ margin: 0, padding: 18, color: "var(--dim)", textAlign: "center" }} role="status">
                {t("noMatches")}
              </p>
            )}
          </div>
        </section>
      </MobilePanelDialog>
    </>
  );
}

function CatalogButton({ item, state }: { item: DrawingToolbarItem; state: ResolvedToolbarItem }) {
  const Icon = item.Icon;
  return (
    <button type="button" className={`${state.pressed ? "active " : ""}${item.id === "delete-all" ? "rail-trash" : ""}`.trim()} disabled={state.disabled} aria-pressed={state.pressed} aria-label={state.label} title={state.label} onClick={state.run}>
      <Icon size={15} className={item.iconClassName} aria-hidden="true" />
    </button>
  );
}

function QuickAction({
  children,
  disabled = false,
  label,
  onClick,
  pressed
}: {
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  onClick?: () => void;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      className="mobile-drawing-quick"
      style={{
        ...MOBILE_BUTTON_STYLE,
        flex: "0 0 44px",
        width: 44,
        display: "inline-grid",
        placeContent: "center",
        padding: 0,
        opacity: disabled ? 0.35 : 1,
        ...(pressed ? { borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--accent)" } : {})
      }}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function resolveAction(
  id: DrawingToolbarAction,
  state: {
    magnet: boolean;
    showVolume: boolean;
    showOrderBookHeatmap: boolean;
    showTradeFootprint: boolean;
    orderBookAvailable: boolean;
    showObjects: boolean;
    hasDrawings: boolean;
    onToggleMagnet: () => void;
    onToggleVolume: () => void;
    onToggleOrderBookHeatmap: () => void;
    onToggleTradeFootprint: () => void;
    onToggleObjects: () => void;
    onDeleteAll: () => void;
  }
): Omit<ResolvedToolbarItem, "label"> {
  switch (id) {
    case "magnet":
      return { pressed: state.magnet, disabled: false, run: state.onToggleMagnet };
    case "volume":
      return { pressed: state.showVolume, disabled: false, run: state.onToggleVolume };
    case "order-book":
      return { pressed: state.showOrderBookHeatmap, disabled: !state.orderBookAvailable, run: state.onToggleOrderBookHeatmap };
    case "trade-footprint":
      return { pressed: state.showTradeFootprint, disabled: !state.orderBookAvailable, run: state.onToggleTradeFootprint };
    case "objects":
      return { pressed: state.showObjects, disabled: false, run: state.onToggleObjects };
    case "delete-all":
      return { disabled: !state.hasDrawings, run: state.onDeleteAll };
  }
}
