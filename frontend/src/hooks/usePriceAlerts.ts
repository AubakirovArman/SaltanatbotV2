import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  alertCrossed,
  ensureNotificationPermission,
  loadAlerts,
  playAlertBeep,
  showAlertNotification,
  storeAlerts,
  type AlertDirection,
  type PriceAlert
} from "../market/alerts";

export interface AlertToast {
  id: string;
  symbol: string;
  price: number;
  direction: AlertDirection;
  hitPrice: number;
}

export interface NewAlertInput {
  symbol: string;
  price: number;
  direction: AlertDirection;
}

function makeId() {
  return `alert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Manages price alerts: persists to localStorage, watches a live symbol→price map,
 * and fires a notification + beep + in-app toast when an alert crosses its threshold.
 */
export function usePriceAlerts(prices: Record<string, number>, decimalsFor: (symbol: string) => number) {
  const [alerts, setAlerts] = useState<PriceAlert[]>(() => loadAlerts());
  const [toasts, setToasts] = useState<AlertToast[]>([]);
  const decimalsRef = useRef(decimalsFor);
  decimalsRef.current = decimalsFor;

  useEffect(() => {
    storeAlerts(alerts);
  }, [alerts]);

  const addAlert = useCallback((input: NewAlertInput) => {
    void ensureNotificationPermission();
    setAlerts((current) => [
      ...current,
      {
        id: makeId(),
        symbol: input.symbol,
        price: input.price,
        direction: input.direction,
        createdAt: Date.now(),
        triggered: false
      }
    ]);
  }, []);

  const removeAlert = useCallback((id: string) => {
    setAlerts((current) => current.filter((alert) => alert.id !== id));
  }, []);

  const resetAlert = useCallback((id: string) => {
    setAlerts((current) => current.map((alert) => (alert.id === id ? { ...alert, triggered: false } : alert)));
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  // Detect crossings whenever prices update. A triggered alert won't re-fire until reset.
  useEffect(() => {
    const fired: AlertToast[] = [];
    setAlerts((current) => {
      let changed = false;
      const next = current.map((alert) => {
        if (alert.triggered) return alert;
        const price = prices[alert.symbol];
        if (price === undefined || !Number.isFinite(price)) return alert;
        if (!alertCrossed(alert, price)) return alert;
        changed = true;
        fired.push({
          id: alert.id,
          symbol: alert.symbol,
          price: alert.price,
          direction: alert.direction,
          hitPrice: price
        });
        const decimals = decimalsRef.current(alert.symbol);
        showAlertNotification(alert, price, decimals);
        return { ...alert, triggered: true };
      });
      return changed ? next : current;
    });
    if (fired.length > 0) {
      playAlertBeep();
      setToasts((current) => [...current, ...fired]);
    }
  }, [prices]);

  const activeCount = useMemo(() => alerts.filter((alert) => !alert.triggered).length, [alerts]);

  return { alerts, toasts, activeCount, addAlert, removeAlert, resetAlert, dismissToast };
}
