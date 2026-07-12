import type { DraftDrawing, Viewport } from "../../chart/types";
import { formatMeasurementDuration, measureAnchors, signed } from "../../chart/measurement";
import { localized, type Locale } from "../../i18n";

export function QuickMeasureSummary({ active, decimals, locale, measurement, viewport }: {
  active: boolean;
  decimals: number;
  locale: Locale;
  measurement?: DraftDrawing;
  viewport?: Viewport;
}) {
  if (!measurement || measurement.points.length < 2 || !viewport) return null;
  const metrics = measureAnchors(measurement.points[0], measurement.points[1], viewport);
  const bars = localized(locale, { en: "bars", ru: "свеч.", kk: "шам" });
  const status = localized(locale, { en: active ? "Measuring" : "Measurement result", ru: active ? "Измерение" : "Результат измерения", kk: active ? "Өлшеу" : "Өлшеу нәтижесі" });
  return (
    <output className={`quick-measure-summary ${metrics.priceDelta >= 0 ? "up" : "down"}`} aria-live={active ? "off" : "polite"}>
      <strong>{status}</strong>
      <span>{signed(metrics.priceDelta, decimals)} · {signed(metrics.percentDelta, 2)}%</span>
      <span>{metrics.bars} {bars} · {formatMeasurementDuration(metrics.durationMs)}</span>
    </output>
  );
}
