import { Copy, RefreshCw, Trash2, X } from "lucide-react";
import { useState } from "react";
import { AlertApiError, type AlertBindingCodeGrant, type AlertBindingRecord } from "../alerts/client";
import type { TelegramBindingsState } from "../hooks/useTelegramBindings";
import { localeTag, type Locale } from "../i18n";
import { shellText, type ShellMessageKey } from "../i18n/shell";

interface TelegramBindingsProps {
  locale: Locale;
  telegram: TelegramBindingsState;
}

/**
 * Telegram binding lifecycle UI for the alerts area: one-time binding codes,
 * the owner's binding list and revocation. The raw code exists only in this
 * component's state, is rendered exactly once and is never logged.
 */
export function TelegramBindings({ locale, telegram }: TelegramBindingsProps) {
  const t = (key: ShellMessageKey) => shellText(locale, key);
  const [pending, setPending] = useState<string>();
  const [grant, setGrant] = useState<AlertBindingCodeGrant>();
  const [copied, setCopied] = useState(false);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  if (telegram.status === "unavailable") return null;

  const createCode = async () => {
    setPending("code");
    setActionError(undefined);
    setCopied(false);
    try {
      setGrant(await telegram.createCode());
    } catch (error) {
      setGrant(undefined);
      setActionError(t(bindingErrorKey(error, "telegramCodeFailed")));
    } finally {
      setPending(undefined);
    }
  };

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
      setActionError(t("telegramCopyFailed"));
    }
  };

  const revoke = async (binding: AlertBindingRecord) => {
    setPending(`revoke:${binding.id}`);
    setActionError(undefined);
    try {
      await telegram.revokeBinding(binding.id, binding.revision);
      setConfirmRevokeId(undefined);
    } catch (error) {
      setActionError(t(bindingErrorKey(error, "telegramRevokeFailed")));
      // A stale revision means another session changed the binding; resync.
      telegram.refresh();
    } finally {
      setPending(undefined);
    }
  };

  const timeText = (iso: string) => new Intl.DateTimeFormat(localeTag(locale), { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  const dateText = (iso: string) => new Intl.DateTimeFormat(localeTag(locale), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

  return (
    <details className="alert-activity telegram-bindings">
      <summary>
        {t("telegramTitle")}
        {telegram.status === "ready" ? ` · ${t(telegram.activeBinding ? "telegramLinked" : "telegramNotLinked")}` : ""}
      </summary>
      {telegram.status === "loading" && <p>{t("telegramLoading")}</p>}
      {telegram.status === "error" && (
        <p className="alert-operation-error" role="alert">
          {t("telegramLoadError")}
          <button type="button" onClick={telegram.refresh} aria-label={t("telegramRefresh")} title={t("telegramRefresh")}>
            <RefreshCw size={12} aria-hidden="true" />
          </button>
        </p>
      )}
      {telegram.status === "ready" && (
        <>
          <p>{t("telegramIntro")}</p>
          <div className="telegram-code-controls">
            <button type="button" className="telegram-create-code" disabled={pending !== undefined} onClick={() => void createCode()}>
              {pending === "code" ? t("telegramCreatingCode") : t("telegramCreateCode")}
            </button>
            <button type="button" onClick={telegram.refresh} aria-label={t("telegramRefresh")} title={t("telegramRefresh")}>
              <RefreshCw size={12} aria-hidden="true" />
            </button>
          </div>
          <div aria-live="polite">
            {grant && (
              <div className="telegram-code" role="status">
                <p>{t("telegramCodeOnce")} {t("telegramCodeExpires")} <time dateTime={grant.expiresAt}>{timeText(grant.expiresAt)}</time>.</p>
                <div className="telegram-code-value">
                  <code className="num">{grant.code}</code>
                  <button type="button" onClick={() => void copyCode(grant.code)} aria-label={t("telegramCopyCode")} title={t("telegramCopyCode")}>
                    <Copy size={12} aria-hidden="true" />
                    {t(copied ? "telegramCodeCopied" : "telegramCopyCode")}
                  </button>
                </div>
                <p>{t("telegramCodeHint")}</p>
              </div>
            )}
          </div>
          {actionError && <p className="alert-operation-error" role="alert">{actionError}</p>}
          {telegram.bindings.length === 0 ? (
            <p>{t("telegramNoBindings")}</p>
          ) : (
            <ul className="alert-list telegram-binding-list" aria-label={t("telegramBindings")}>
              {telegram.bindings.map((binding) => {
                const handle = binding.recipientHandle.slice(0, 8);
                return (
                  <li key={binding.id} className="alert-item telegram-binding-item">
                    <span className={`alert-source-badge ${binding.status === "active" ? "server" : "disabled"}`}>{t(bindingStatusKey(binding.status))}</span>
                    <span className="alert-name num" title={binding.recipientHandle}>{handle}</span>
                    <time dateTime={binding.activatedAt ?? binding.createdAt}>{dateText(binding.activatedAt ?? binding.createdAt)}</time>
                    {binding.status === "active" && confirmRevokeId !== binding.id && (
                      <button
                        type="button"
                        disabled={pending !== undefined}
                        aria-label={`${t("telegramRevoke")} ${handle}`}
                        title={t("telegramRevoke")}
                        onClick={() => setConfirmRevokeId(binding.id)}
                      >
                        <Trash2 size={12} aria-hidden="true" />
                      </button>
                    )}
                    {binding.status === "active" && confirmRevokeId === binding.id && (
                      <>
                        <button
                          type="button"
                          className="telegram-revoke-confirm"
                          disabled={pending !== undefined}
                          onClick={() => void revoke(binding)}
                        >
                          {t("telegramRevokeConfirm")}
                        </button>
                        <button
                          type="button"
                          disabled={pending !== undefined}
                          aria-label={t("telegramRevokeCancel")}
                          title={t("telegramRevokeCancel")}
                          onClick={() => setConfirmRevokeId(undefined)}
                        >
                          <X size={12} aria-hidden="true" />
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </details>
  );
}

function bindingStatusKey(status: AlertBindingRecord["status"]): ShellMessageKey {
  return status === "active" ? "telegramStatusActive" : status === "pending" ? "telegramStatusPending" : "telegramStatusRevoked";
}

/** Honest quota/rate/availability mapping; unknown failures use the fallback. */
function bindingErrorKey(error: unknown, fallback: ShellMessageKey): ShellMessageKey {
  if (error instanceof AlertApiError) {
    if (error.code.includes("quota")) return "telegramCodeQuota";
    if (error.status === 429 || error.code === "rate_limited" || error.code === "too_many_requests") return "telegramRateLimited";
    if (error.code === "network_error" || error.code === "request_timeout") return "telegramServiceUnavailable";
  }
  return fallback;
}
