import { Minus } from "lucide-react";
import { useEffect, useRef, type CSSProperties } from "react";
import type { DrawingObject } from "../../chart/drawings";
import type { Locale } from "../../i18n";
import { shellText } from "../../i18n/shell";
import { handleMenuKeyboard } from "../menuKeyboard";

const DRAW_COLORS = ["#4db6ff", "#f7c948", "#23c97a", "#ef5350", "#bd58a4", "#8f9bb3"];
const STYLE_TOOLBAR: CSSProperties = {
  position: "absolute",
  zIndex: 30,
  insetBlockStart: 84,
  insetInlineStart: "max(8px, env(safe-area-inset-left))",
  insetInlineEnd: "max(var(--chart-axis-safe-inline), calc(env(safe-area-inset-right) + 8px))",
  translate: "none",
  maxWidth: "none",
  minHeight: 36,
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: 4,
  border: "1px solid var(--line)",
  borderRadius: "var(--radius)",
  background: "color-mix(in srgb, var(--panel) 96%, transparent)",
  boxShadow: "var(--shadow-pop)",
  overflowX: "auto"
};
const STYLE_BUTTON: CSSProperties = {
  flex: "0 0 auto",
  minWidth: 44,
  minHeight: 44,
  display: "inline-grid",
  placeContent: "center",
  padding: "0 6px",
  border: "1px solid transparent",
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  color: "var(--muted)"
};

export function DrawingStyleBar({ locale, drawing, onChange }: { locale: Locale; drawing: DrawingObject; onChange: (patch: Partial<DrawingObject["style"]>) => void }) {
  const t = (key: Parameters<typeof shellText>[1]) => shellText(locale, key);
  return (
    <div className="drawing-style-toolbar" style={STYLE_TOOLBAR} role="toolbar" aria-label={t("drawingTools")}>
      <div className="drawing-colour-options" style={{ display: "flex", alignItems: "center", gap: 2 }} role="group" aria-label={t("colour")}>
        {DRAW_COLORS.map((colour) => {
          const selected = drawing.style.color === colour;
          return (
            <button
              key={colour}
              type="button"
              className={selected ? "active" : ""}
              style={{
                ...STYLE_BUTTON,
                width: 44,
                padding: 0,
                borderRadius: "50%",
                ...(selected ? { borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--text)" } : {})
              }}
              title={colour}
              aria-label={`${t("colour")} ${colour}`}
              aria-pressed={selected}
              onClick={() => onChange({ color: colour })}
            >
              <span className="drawing-colour-dot" style={{ width: 24, height: 24, display: "block", borderRadius: "50%", background: colour, outline: selected ? "2px solid var(--text)" : undefined, outlineOffset: selected ? 1 : undefined }} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <span className="drawing-style-divider" style={{ width: 1, height: 20, background: "var(--line)" }} aria-hidden="true" />
      <div className="drawing-width-options" style={{ display: "flex", alignItems: "center", gap: 2 }} role="group" aria-label={t("lineWidth")}>
        {[1, 2, 3].map((width) => {
          const selected = Math.round(drawing.style.width) === width;
          return (
            <button
              key={width}
              type="button"
              className={selected ? "active" : ""}
              style={{ ...STYLE_BUTTON, ...(selected ? { borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--text)" } : {}) }}
              aria-label={`${t("lineWidth")} ${width}px`}
              aria-pressed={selected}
              onClick={() => onChange({ width })}
            >
              {width}px
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className={drawing.style.dashed ? "active drawing-dash-toggle" : "drawing-dash-toggle"}
        style={{ ...STYLE_BUTTON, ...(drawing.style.dashed ? { borderColor: "var(--accent)", background: "var(--accent-soft)", color: "var(--text)" } : {}) }}
        title={t("dashedLine")}
        aria-label={t("dashedLine")}
        aria-pressed={Boolean(drawing.style.dashed)}
        onClick={() => onChange({ dashed: !drawing.style.dashed })}
      >
        <Minus size={18} style={{ strokeDasharray: "3 2" }} aria-hidden="true" />
      </button>
    </div>
  );
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={danger ? "danger" : ""}
      style={{ display: "block", width: "100%", minHeight: "var(--drawing-context-target, 32px)", padding: "6px 10px", border: 0, borderRadius: 6, background: "transparent", color: danger ? "var(--down)" : "inherit", fontSize: "var(--fs-sm)", textAlign: "start", cursor: "pointer" }}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function DrawingMenu({
  locale,
  x,
  y,
  drawing,
  hasLocked,
  alertPrice,
  onAddAlert,
  onClose,
  onDelete,
  onDuplicate,
  onEditNote,
  onToggleLock,
  onToggleHide,
  onResetView,
  onUnlockAll
}: {
  locale: Locale;
  x: number;
  y: number;
  drawing?: DrawingObject;
  hasLocked: boolean;
  alertPrice?: number;
  onAddAlert?: (price: number) => void;
  onClose: () => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onEditNote?: (id: string) => void;
  onToggleLock: (id: string) => void;
  onToggleHide: (id: string) => void;
  onResetView: () => void;
  onUnlockAll: () => void;
}) {
  const t = (key: Parameters<typeof shellText>[1]) => shellText(locale, key);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);

  return (
    <>
      <div
        className="chart-context-backdrop"
        aria-hidden="true"
        style={{ position: "fixed", inset: 0, zIndex: 40 }}
        onPointerDown={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        ref={menuRef}
        className="chart-context-menu"
        role="menu"
        aria-label={drawing ? t(drawing.locked ? "unlockDrawing" : "drawingObjects") : t("drawingTools")}
        onKeyDown={(event) => {
          if (event.key === "Tab") {
            onClose();
            return;
          }
          handleMenuKeyboard(event, onClose);
        }}
        style={{
          position: "absolute",
          zIndex: 41,
          left: `clamp(4px, ${x}px, calc(100% - 158px))`,
          top: `clamp(4px, ${y}px, calc(100% - 236px))`,
          minWidth: 150,
          maxWidth: "min(18rem, calc(100% - 8px))",
          padding: 4,
          border: "1px solid var(--line)",
          borderRadius: "var(--radius)",
          background: "var(--panel)",
          boxShadow: "var(--shadow-pop)",
          color: "var(--text)"
        }}
      >
        {drawing ? (
          <>
            {onAddAlert && (drawing.tool === "hline" || drawing.tool === "hray") && (
              <MenuItem
                label={t("alertAtLine")}
                onClick={() => {
                  onAddAlert(drawing.points[0].price);
                  onClose();
                }}
              />
            )}
            {onEditNote && drawing.tool === "text-note" && (
              <MenuItem
                label={t("editTextNote")}
                onClick={() => {
                  onEditNote(drawing.id);
                  onClose();
                }}
              />
            )}
            <MenuItem
              label={t("duplicate")}
              onClick={() => {
                onDuplicate(drawing.id);
                onClose();
              }}
            />
            <MenuItem
              label={t(drawing.locked ? "unlock" : "lock")}
              onClick={() => {
                onToggleLock(drawing.id);
                onClose();
              }}
            />
            <MenuItem
              label={t(drawing.hidden ? "show" : "hide")}
              onClick={() => {
                onToggleHide(drawing.id);
                onClose();
              }}
            />
            <MenuItem
              label={t("deleteDrawing")}
              onClick={() => {
                onDelete(drawing.id);
                onClose();
              }}
              danger
            />
          </>
        ) : (
          <>
            {alertPrice !== undefined && onAddAlert && (
              <MenuItem
                label={`${t("addAlertAt")} ${alertPrice.toPrecision(6)}`}
                onClick={() => {
                  onAddAlert(alertPrice);
                  onClose();
                }}
              />
            )}
            <MenuItem
              label={t("resetView")}
              onClick={() => {
                onResetView();
                onClose();
              }}
            />
            {hasLocked && (
              <MenuItem
                label={t("unlockAll")}
                onClick={() => {
                  onUnlockAll();
                  onClose();
                }}
              />
            )}
          </>
        )}
      </div>
    </>
  );
}
