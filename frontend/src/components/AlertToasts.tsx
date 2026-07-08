import { Bell, X } from "lucide-react";
import { useEffect } from "react";
import type { AlertToast } from "../hooks/usePriceAlerts";

interface AlertToastsProps {
  toasts: AlertToast[];
  decimalsFor: (symbol: string) => number;
  onDismiss: (id: string) => void;
}

/** Fixed-position stack of alert notifications; each auto-dismisses after a few seconds. */
export function AlertToasts({ toasts, decimalsFor, onDismiss }: AlertToastsProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="alert-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <AlertToastCard key={toast.id} toast={toast} decimals={decimalsFor(toast.symbol)} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function AlertToastCard({
  toast,
  decimals,
  onDismiss
}: {
  toast: AlertToast;
  decimals: number;
  onDismiss: (id: string) => void;
}) {
  useEffect(() => {
    const id = window.setTimeout(() => onDismiss(toast.id), 8000);
    return () => window.clearTimeout(id);
  }, [toast.id, onDismiss]);

  return (
    <div className={`alert-toast ${toast.direction}`}>
      <Bell size={15} strokeWidth={1.75} aria-hidden="true" />
      <div className="alert-toast-body">
        <strong>{toast.symbol}</strong>
        <span>
          {toast.direction === "above" ? "rose above" : "fell below"}{" "}
          <span className="num">{toast.price.toFixed(decimals)}</span> · now{" "}
          <span className="num">{toast.hitPrice.toFixed(decimals)}</span>
        </span>
      </div>
      <button type="button" aria-label="Dismiss alert" onClick={() => onDismiss(toast.id)}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
