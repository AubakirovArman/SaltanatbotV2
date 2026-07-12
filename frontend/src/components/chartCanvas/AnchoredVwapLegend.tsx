import { useMemo } from "react";
import { calculateAnchoredVwap } from "../../chart/anchoredVwap";
import type { DrawingObject } from "../../chart/drawings";
import type { Locale } from "../../i18n";
import { intlLocale } from "../../i18n/chart";
import { shellText } from "../../i18n/shell";
import type { Candle } from "../../types";

export function AnchoredVwapLegend({ drawings, candles, decimals, locale }: {
  drawings: DrawingObject[];
  candles: Candle[];
  decimals: number;
  locale: Locale;
}) {
  const entries = useMemo(() => drawings
    .filter((drawing) => drawing.tool === "anchored-vwap" && !drawing.hidden)
    .map((drawing, index) => ({ drawing, index, point: calculateAnchoredVwap(candles, drawing.points[0]?.time ?? Infinity).at(-1) })), [candles, drawings]);
  if (entries.length === 0) return null;
  const label = shellText(locale, "anchoredVwap");
  const date = new Intl.DateTimeFormat(intlLocale(locale), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    <aside className="anchored-vwap-legend" aria-label={label}>
      <strong>AVWAP · {entries.length}</strong>
      <ul>
        {entries.slice(-3).map(({ drawing, index, point }) => (
          <li key={drawing.id}>
            <span>#{index + 1} · {date.format(drawing.points[0].time)}</span>
            <b>{point ? point.vwap.toFixed(decimals) : "—"}</b>
            <small>{point ? `σ ${point.deviation.toFixed(decimals)}` : shellText(locale, "loading")}</small>
          </li>
        ))}
      </ul>
      {entries.length > 3 && <small>+{entries.length - 3}</small>}
    </aside>
  );
}
