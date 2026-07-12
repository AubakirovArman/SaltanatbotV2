import { Columns2, Grid2X2, Rows2, Shuffle, Square } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { Locale } from "../../i18n";
import { shellText } from "../../i18n/shell";
import type { ChartLayoutPreset } from "../../workspace/workspaces";

const layoutOptions: Array<{ id: ChartLayoutPreset; icon: typeof Square; label: "singleChart" | "verticalSplit" | "horizontalSplit" | "fourChartGrid" }> = [
  { id: "single", icon: Square, label: "singleChart" },
  { id: "split-vertical", icon: Columns2, label: "verticalSplit" },
  { id: "split-horizontal", icon: Rows2, label: "horizontalSplit" },
  { id: "grid-4", icon: Grid2X2, label: "fourChartGrid" }
];

export function LayoutMenu({ locale, preset, canUseDistinctMarkets, onChange, onDistinctMarkets }: { locale: Locale; preset: ChartLayoutPreset; canUseDistinctMarkets: boolean; onChange: (preset: ChartLayoutPreset) => void; onDistinctMarkets: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const Current = layoutOptions.find((item) => item.id === preset)?.icon ?? Square;
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!wrapRef.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", close);
    window.requestAnimationFrame(() => wrapRef.current?.querySelector<HTMLElement>("[role='menuitemradio'][aria-checked='true']")?.focus());
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  const closeAndFocus = () => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };
  return (
    <div className="charttype-menu-wrap" ref={wrapRef} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <button ref={triggerRef} type="button" className="icon-button" aria-label={shellText(locale, "chartLayout")} title={shellText(locale, "chartLayout")} aria-haspopup="menu" aria-controls={open ? menuId : undefined} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Current size={15} aria-hidden="true" />
      </button>
      {open && (
        <div id={menuId} className="charttype-menu layout-menu" role="menu" onKeyDown={(event) => {
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          if (event.key === "Escape") { event.preventDefault(); closeAndFocus(); return; }
          const target = event.key === "Home" ? items[0] : event.key === "End" ? items.at(-1) : event.key === "ArrowDown" ? items[(current + 1) % items.length] : event.key === "ArrowUp" ? items[(current - 1 + items.length) % items.length] : undefined;
          if (target) { event.preventDefault(); target.focus(); }
        }}>
          {layoutOptions.map((item) => {
            const Icon = item.icon;
            return <button type="button" role="menuitemradio" aria-checked={item.id === preset} className={item.id === preset ? "active" : ""} key={item.id} onClick={() => { onChange(item.id); closeAndFocus(); }}><Icon size={14} aria-hidden="true" /> {shellText(locale, item.label)}</button>;
          })}
          <div className="layout-menu-separator" role="separator" />
          <button type="button" role="menuitem" disabled={!canUseDistinctMarkets} title={shellText(locale, "fourDistinctMarketsHint")} onClick={() => { onDistinctMarkets(); closeAndFocus(); }}><Shuffle size={14} aria-hidden="true" /> {shellText(locale, "fourDistinctMarkets")}</button>
        </div>
      )}
    </div>
  );
}
