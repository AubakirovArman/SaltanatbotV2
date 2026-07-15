import type { DrawingObject } from "../../chart/drawings";
import type { Locale } from "../../i18n";
import { shellText } from "../../i18n/shell";

const DRAW_COLORS = ["#4db6ff", "#f7c948", "#23c97a", "#ef5350", "#bd58a4", "#8f9bb3"];

export function DrawingStyleBar({ locale, drawing, onChange }: { locale: Locale; drawing: DrawingObject; onChange: (patch: Partial<DrawingObject["style"]>) => void }) {
  const t = (key: Parameters<typeof shellText>[1]) => shellText(locale, key);
  return (
    <div style={{ position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)", zIndex: 30, display: "flex", gap: 6, alignItems: "center", padding: "5px 8px", background: "#12161f", border: "1px solid rgba(134,150,166,0.25)", borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.35)" }}>
      {DRAW_COLORS.map((c) => (
        <button key={c} type="button" title={c} aria-label={`${t("colour")} ${c}`} onClick={() => onChange({ color: c })} style={{ width: 24, height: 24, borderRadius: "50%", background: c, border: drawing.style.color === c ? "2px solid #fff" : "1px solid rgba(0,0,0,0.35)", cursor: "pointer", padding: 0 }} />
      ))}
      <span style={{ width: 1, height: 16, background: "rgba(134,150,166,0.3)" }} />
      {[1, 2, 3].map((w) => (
        <button key={w} type="button" title={`${w}px`} onClick={() => onChange({ width: w })} style={{ background: Math.round(drawing.style.width) === w ? "rgba(77,182,255,0.25)" : "transparent", border: "none", color: "inherit", cursor: "pointer", borderRadius: 4, padding: "2px 6px", fontSize: 11 }}>
          {w}px
        </button>
      ))}
      <button type="button" title={shellText(locale, "dashedLine")} onClick={() => onChange({ dashed: !drawing.style.dashed })} style={{ background: drawing.style.dashed ? "rgba(77,182,255,0.25)" : "transparent", border: "none", color: "inherit", cursor: "pointer", borderRadius: 4, padding: "2px 8px", fontSize: 11 }}>
        ┄
      </button>
    </div>
  );
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 10px", background: "transparent", border: "none", color: danger ? "#ef5350" : "inherit", cursor: "pointer", borderRadius: 6, fontSize: 12 }}>
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
  onToggleLock: (id: string) => void;
  onToggleHide: (id: string) => void;
  onResetView: () => void;
  onUnlockAll: () => void;
}) {
  const t = (key: Parameters<typeof shellText>[1]) => shellText(locale, key);
  return (
    <>
      {/* Click-away / right-click-away catcher. */}
      <div
        style={{ position: "fixed", inset: 0, zIndex: 40 }}
        onPointerDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div className="chart-context-menu" style={{ position: "absolute", left: x, top: y, zIndex: 41, background: "#12161f", border: "1px solid rgba(134,150,166,0.25)", borderRadius: 8, padding: 4, minWidth: 150, boxShadow: "0 6px 24px rgba(0,0,0,0.45)" }}>
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
