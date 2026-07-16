import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/AuthRoot";
import { DEFAULT_PRICE_ALERT_ROUTE, ensureNotificationPermission, evaluateAlertPrices, loadAlerts, playAlertBeep, showAlertNotification, storeAlerts, type AlertDirection, type PriceAlert, type TriggeredPriceAlert } from "../market/alerts";
import { getToken, notifyAlert } from "../trading/tradeClient";
import type { ChartDataRoute } from "../types";

export interface AlertToast {
  id: string;
  symbol: string;
  price: number;
  direction: AlertDirection;
  hitPrice: number;
}

export interface NewAlertInput extends ChartDataRoute {
  symbol: string;
  price: number;
  direction: AlertDirection;
}

interface AlertState {
  ownerId?: string;
  alerts: PriceAlert[];
}

interface AlertDelivery {
  id: number;
  ownerId?: string;
  fired: TriggeredPriceAlert[];
}

function makeId() {
  return `alert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Manages price alerts and exposes an imperative price evaluator.
 *
 * Keeping the alert state separate from its market-data feed lets the application
 * subscribe only to symbols that actually have armed alerts. It also prevents a
 * quote tick from rerendering the root application merely to evaluate a crossing.
 */
export function usePriceAlerts(decimalsFor: (symbol: string) => number, legacyRoute: ChartDataRoute = DEFAULT_PRICE_ALERT_ROUTE) {
  const accountAuth = useAuth();
  const ownerId = accountAuth.authRequired ? (accountAuth.user?.id ?? "") : undefined;
  const [alertState, setAlertState] = useState<AlertState>(() => ({ ownerId, alerts: loadAlerts(ownerId, legacyRoute) }));
  const [toasts, setToasts] = useState<AlertToast[]>([]);
  const [deliveries, setDeliveries] = useState<AlertDelivery[]>([]);
  const deliverySequence = useRef(0);
  const processedDeliveries = useRef(new Set<number>());
  const decimalsRef = useRef(decimalsFor);
  decimalsRef.current = decimalsFor;
  const legacyRouteRef = useRef(legacyRoute);
  legacyRouteRef.current = legacyRoute;
  const ownerRef = useRef(ownerId);
  ownerRef.current = ownerId;

  // Keep the owner and snapshot atomic. If the authenticated account changes
  // in-place, stale state can never be persisted under the new account key.
  let alerts = alertState.alerts;
  if (alertState.ownerId !== ownerId) {
    alerts = loadAlerts(ownerId, legacyRouteRef.current);
    setAlertState({ ownerId, alerts });
  }
  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;
  const setAlerts = useCallback(
    (action: PriceAlert[] | ((alerts: PriceAlert[]) => PriceAlert[])) => {
      if (ownerRef.current !== ownerId) return;
      const current = alertsRef.current;
      const next = typeof action === "function" ? action(current) : action;
      if (next === current) return;
      alertsRef.current = next;
      setAlertState({ ownerId, alerts: next });
    },
    [ownerId]
  );

  useEffect(() => {
    if (alertState.ownerId === ownerId) storeAlerts(alertState.alerts, ownerId);
  }, [alertState, ownerId]);
  useEffect(() => {
    setToasts([]);
    setDeliveries([]);
    processedDeliveries.current.clear();
  }, [ownerId]);

  const addAlert = useCallback(
    (input: NewAlertInput) => {
      void ensureNotificationPermission();
      setAlerts((current) => [
        ...current,
        {
          id: makeId(),
          symbol: input.symbol,
          price: input.price,
          direction: input.direction,
          createdAt: Date.now(),
          triggered: false,
          exchange: input.exchange,
          marketType: input.marketType,
          priceType: input.priceType
        }
      ]);
    },
    [setAlerts]
  );

  const removeAlert = useCallback(
    (id: string) => {
      setAlerts((current) => current.filter((alert) => alert.id !== id));
    },
    [setAlerts]
  );

  const resetAlert = useCallback(
    (id: string) => {
      setAlerts((current) => current.map((alert) => (alert.id === id ? { ...alert, triggered: false } : alert)));
    },
    [setAlerts]
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  // A triggered alert won't re-fire until reset. The caller may invoke this for
  // a compact alert-only quote feed without coupling those ticks to App state.
  const evaluatePrices = useCallback(
    (route: ChartDataRoute, prices: Record<string, number>) => {
      if (ownerRef.current !== ownerId) return;
      const result = evaluateAlertPrices(alertsRef.current, route, prices);
      if (result.fired.length === 0) return;
      setAlerts(result.alerts);
      deliverySequence.current += 1;
      setDeliveries((current) => [...current, { id: deliverySequence.current, ownerId, fired: result.fired }]);
    },
    [ownerId, setAlerts]
  );

  useEffect(() => {
    if (deliveries.length === 0) {
      processedDeliveries.current.clear();
      return;
    }
    const pending = deliveries.filter((delivery) => !processedDeliveries.current.has(delivery.id));
    if (pending.length === 0) return;
    for (const delivery of pending) processedDeliveries.current.add(delivery.id);
    const fired = pending.filter((delivery) => delivery.ownerId === ownerId).flatMap((delivery) => delivery.fired);
    if (fired.length > 0) {
      for (const hit of fired) showAlertNotification(hit.alert, hit.hitPrice, decimalsRef.current(hit.alert.symbol));
      playAlertBeep();
      setToasts((current) => [
        ...current,
        ...fired.map(({ alert, hitPrice }) => ({ id: alert.id, symbol: alert.symbol, price: alert.price, direction: alert.direction, hitPrice }))
      ]);
      // Best-effort server delivery (Telegram) so a fired alert reaches the operator
      // even with the tab closed — only when the current account may use trading.
      if (accountAuth.authRequired ? accountAuth.tradingAvailable : Boolean(getToken())) {
        for (const { alert, hitPrice } of fired) {
          void notifyAlert({ symbol: alert.symbol, price: alert.price, direction: alert.direction, hitPrice }).catch(() => undefined);
        }
      }
    }
    const deliveredIds = new Set(pending.map((delivery) => delivery.id));
    setDeliveries((current) => current.filter((delivery) => !deliveredIds.has(delivery.id)));
  }, [accountAuth.authRequired, accountAuth.tradingAvailable, deliveries, ownerId]);

  const activeCount = useMemo(() => alerts.filter((alert) => !alert.triggered).length, [alerts]);

  return { alerts, toasts, activeCount, addAlert, removeAlert, resetAlert, dismissToast, evaluatePrices };
}
