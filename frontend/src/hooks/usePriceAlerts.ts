import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { useAuth } from "../auth/AuthRoot";
import { alertCrossed, ensureNotificationPermission, loadAlerts, playAlertBeep, showAlertNotification, storeAlerts, type AlertDirection, type PriceAlert } from "../market/alerts";
import { getToken, notifyAlert } from "../trading/tradeClient";

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

interface AlertState {
  ownerId?: string;
  alerts: PriceAlert[];
}

function makeId() {
  return `alert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Manages price alerts: persists to localStorage, watches a live symbol→price map,
 * and fires a notification + beep + in-app toast when an alert crosses its threshold.
 */
export function usePriceAlerts(prices: Record<string, number>, decimalsFor: (symbol: string) => number) {
  const accountAuth = useAuth();
  const ownerId = accountAuth.authRequired ? (accountAuth.user?.id ?? "") : undefined;
  const [alertState, setAlertState] = useState<AlertState>(() => ({ ownerId, alerts: loadAlerts(ownerId) }));
  const [toasts, setToasts] = useState<AlertToast[]>([]);
  const decimalsRef = useRef(decimalsFor);
  decimalsRef.current = decimalsFor;

  // Keep the owner and snapshot atomic. If the authenticated account changes
  // in-place, stale state can never be persisted under the new account key.
  if (alertState.ownerId !== ownerId) {
    setAlertState({ ownerId, alerts: loadAlerts(ownerId) });
  }
  const alerts = alertState.ownerId === ownerId ? alertState.alerts : [];
  const setAlerts = useCallback(
    (action: SetStateAction<PriceAlert[]>) => {
      setAlertState((current) => {
        const currentAlerts = current.ownerId === ownerId ? current.alerts : loadAlerts(ownerId);
        const nextAlerts = typeof action === "function" ? action(currentAlerts) : action;
        if (current.ownerId === ownerId && nextAlerts === current.alerts) return current;
        return {
          ownerId,
          alerts: nextAlerts
        };
      });
    },
    [ownerId]
  );

  useEffect(() => {
    if (alertState.ownerId === ownerId) storeAlerts(alertState.alerts, ownerId);
  }, [alertState, ownerId]);

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
          triggered: false
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
      // Best-effort server delivery (Telegram) so a fired alert reaches the operator
      // even with the tab closed — only when a trade token is present.
      if (accountAuth.authRequired ? accountAuth.tradingAvailable : Boolean(getToken())) {
        for (const toast of fired) {
          void notifyAlert({ symbol: toast.symbol, price: toast.price, direction: toast.direction, hitPrice: toast.hitPrice }).catch(() => undefined);
        }
      }
    }
  }, [accountAuth.authRequired, accountAuth.tradingAvailable, prices, setAlerts]);

  const activeCount = useMemo(() => alerts.filter((alert) => !alert.triggered).length, [alerts]);

  return { alerts, toasts, activeCount, addAlert, removeAlert, resetAlert, dismissToast };
}
