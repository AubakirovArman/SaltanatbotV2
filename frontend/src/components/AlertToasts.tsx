import { Bell, X } from "lucide-react";
import { useEffect } from "react";
import type { AlertToast } from "../hooks/usePriceAlerts";
import type { Locale } from "../i18n";
import { shellText } from "../i18n/shell";

interface AlertToastsProps {
  locale: Locale;
  toasts: AlertToast[];
  decimalsFor: (symbol: string) => number;
  onDismiss: (id: string) => void;
}

/** Fixed-position stack of alert notifications; each auto-dismisses after a few seconds. */
export function AlertToasts({ locale, toasts, decimalsFor, onDismiss }: AlertToastsProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="alert-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <AlertToastCard locale={locale} key={toast.id} toast={toast} decimals={toast.source === "server" ? 0 : decimalsFor(toast.symbol)} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function AlertToastCard({
  locale,
  toast,
  decimals,
  onDismiss
}: {
  locale: Locale;
  toast: AlertToast;
  decimals: number;
  onDismiss: (id: string) => void;
}) {
  useEffect(() => {
    const id = window.setTimeout(() => onDismiss(toast.id), 8000);
    return () => window.clearTimeout(id);
  }, [toast.id, onDismiss]);

  return (
    <div className={`alert-toast ${toast.source === "server" ? "server" : toast.direction}`}>
      <Bell size={15} strokeWidth={1.75} aria-hidden="true" />
      <div className="alert-toast-body">
        {toast.source === "server" ? (
          // Rule kinds without a single symbol (e.g. screener) carry the
          // delivery-envelope title/body instead of a price sentence.
          <>
            <strong>{toast.title ?? toast.symbol ?? shellText(locale, "alerts")}</strong>
            <span title={toast.summary}>{toast.body ?? shellText(locale, "alertServerTriggered")}</span>
          </>
        ) : (
          <>
            <strong>{toast.symbol}</strong>
            <span>
              {shellText(locale, toast.direction === "above" ? "roseAbove" : "fellBelow")}{" "}
              <span className="num">{toast.price.toFixed(decimals)}</span> · {shellText(locale, "now")}{" "}
              <span className="num">{toast.hitPrice.toFixed(decimals)}</span>
            </span>
          </>
        )}
      </div>
      <button type="button" aria-label={shellText(locale, "dismissAlert")} onClick={() => onDismiss(toast.id)}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
