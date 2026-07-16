import { useEffect, useMemo } from "react";
import { useSparklines } from "../hooks/useSparklines";
import type { ChartDataRoute } from "../types";
import { priceAlertRouteKey, type PriceAlert } from "./alerts";

interface PriceAlertFeedProps {
  alerts: PriceAlert[];
  evaluatePrices: (route: ChartDataRoute, prices: Record<string, number>) => void;
}

export interface PriceAlertSubscriptionBatch {
  key: string;
  route: ChartDataRoute;
  symbols: string[];
}

/**
 * Runs the lightweight client-side alert feed outside the application shell.
 * Only armed alert symbols are subscribed; an empty alert set opens no socket.
 */
export function PriceAlertFeed({ alerts, evaluatePrices }: PriceAlertFeedProps) {
  const batches = useMemo(() => groupPriceAlertSubscriptions(alerts), [alerts]);
  return batches.map((batch) => <PriceAlertFeedBatch key={batch.key} batch={batch} evaluatePrices={evaluatePrices} />);
}

function PriceAlertFeedBatch({ batch, evaluatePrices }: { batch: PriceAlertSubscriptionBatch; evaluatePrices: PriceAlertFeedProps["evaluatePrices"] }) {
  const { route, symbols } = batch;
  const sparklines = useSparklines(symbols, "1m", route.exchange, {
    enabled: symbols.length > 0,
    marketType: route.marketType,
    priceType: route.priceType,
    strict: true,
    streaming: route.priceType === "last"
  });
  const prices = useMemo(() => {
    const next: Record<string, number> = {};
    for (const [symbol, series] of Object.entries(sparklines)) {
      if (series?.last != null && Number.isFinite(series.last)) next[symbol] = series.last;
    }
    return next;
  }, [sparklines]);

  useEffect(() => {
    if (Object.keys(prices).length > 0) evaluatePrices(route, prices);
  }, [evaluatePrices, prices, route]);

  return null;
}

export function groupPriceAlertSubscriptions(alerts: PriceAlert[], batchSize = 40): PriceAlertSubscriptionBatch[] {
  const limit = Math.max(1, Math.min(40, Math.floor(batchSize)));
  const groups = new Map<string, { route: ChartDataRoute; symbols: Set<string> }>();
  for (const alert of alerts) {
    if (alert.triggered) continue;
    const route: ChartDataRoute = { exchange: alert.exchange, marketType: alert.marketType, priceType: alert.priceType };
    const routeKey = priceAlertRouteKey(route);
    const group = groups.get(routeKey) ?? { route, symbols: new Set<string>() };
    group.symbols.add(alert.symbol);
    groups.set(routeKey, group);
  }

  const batches: PriceAlertSubscriptionBatch[] = [];
  for (const [routeKey, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const symbols = [...group.symbols].sort();
    for (let offset = 0; offset < symbols.length; offset += limit) {
      batches.push({ key: `${routeKey}:${offset / limit}`, route: group.route, symbols: symbols.slice(offset, offset + limit) });
    }
  }
  return batches;
}
