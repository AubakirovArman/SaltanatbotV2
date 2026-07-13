import { useEffect, useMemo, useState } from "react";
import type { Locale } from "../i18n";
import { fetchArbitrageHistory, type ArbitrageHistoryPoint } from "./client";
import { arbitrageText } from "./text";

export function ArbitrageHistoryChart({ routeId, locale }: { routeId: string; locale: Locale }) {
  const [points, setPoints] = useState<ArbitrageHistoryPoint[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    void fetchArbitrageHistory(routeId, 24, controller.signal)
      .then(setPoints)
      .catch(() => setPoints([]));
    return () => controller.abort();
  }, [routeId]);
  const path = useMemo(() => chartPath(points), [points]);
  if (points.length < 2) return <span className="arb-history-empty">{arbitrageText(locale, "historyEmpty")}</span>;
  const minimum = Math.min(...points.map((point) => point.grossSpreadBps));
  const maximum = Math.max(...points.map((point) => point.grossSpreadBps));
  return (
    <figure className="arb-history">
      <svg viewBox="0 0 320 72" role="img" aria-labelledby={`arb-history-${routeId.replaceAll(":", "-")}`} preserveAspectRatio="none">
        <title id={`arb-history-${routeId.replaceAll(":", "-")}`}>{arbitrageText(locale, "opportunityHistory")}</title>
        <path d={path} vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption>
        {arbitrageText(locale, "opportunityHistory")} · {formatBps(minimum)} — {formatBps(maximum)}
      </figcaption>
    </figure>
  );
}

function formatBps(value: number) {
  return `${value >= 0 ? "+" : ""}${(value / 100).toFixed(3)}%`;
}

export function chartPath(points: Pick<ArbitrageHistoryPoint, "grossSpreadBps">[]) {
  if (points.length < 2) return "";
  const values = points.map((point) => point.grossSpreadBps);
  const min = Math.min(...values);
  const range = Math.max(1, Math.max(...values) - min);
  return points.map((point, index) => `${index ? "L" : "M"}${((index / (points.length - 1)) * 320).toFixed(2)},${(66 - ((point.grossSpreadBps - min) / range) * 60).toFixed(2)}`).join(" ");
}
