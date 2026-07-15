import { AlertTriangle, KeyRound, XOctagon } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import type { Locale } from "../../i18n";
import { tradingSaveKeys, tradingText } from "../../i18n/trading";
import { AccountTelemetryPanel } from "./AccountTelemetryPanel";
import { AccountRegistryPanel } from "./AccountRegistryPanel";
import { getKeys, getEmergencyStop, getNotify, getSettings, killAll, createEmergencyOperationId, saveKeys, saveNotify, setLiveTrading, testNotify, type AuthState, type EmergencyStopStatus, type ExchangeId, type NotifyStatus } from "../tradeClient";

const BybitUtaPanel = lazy(() => import("./bybit-uta/BybitUtaPanel").then((module) => ({ default: module.BybitUtaPanel })));
const ResearchAlertPanel = lazy(() => import("./research-alerts/ResearchAlertPanel").then((module) => ({ default: module.ResearchAlertPanel })));

export function TradingSettings({ locale }: { locale: Locale }) {
  const [keys, setKeys] = useState({ binance: false, bybit: false });
  const [notifyStatus, setNotifyStatus] = useState<NotifyStatus>();
  const [settings, setSettings] = useState<AuthState>();
  const [emergency, setEmergency] = useState<EmergencyStopStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    getKeys()
      .then(setKeys)
      .catch(() => undefined);
    getNotify()
      .then(setNotifyStatus)
      .catch(() => undefined);
    getSettings()
      .then(setSettings)
      .catch(() => undefined);
    getEmergencyStop()
      .then(setEmergency)
      .catch(() => undefined);
  }, []);

  const toggleLive = async (next: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      await setLiveTrading(next);
      setSettings((current) => (current ? { ...current, liveTradingEnabled: next } : current));
      if (next) setEmergency(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tradingText(locale, "settingsFailed"));
    } finally {
      setBusy(false);
    }
  };

  const secureTradingOrigin = settings?.secureTradingOrigin === true;

  const kill = async (flatten: boolean) => {
    if (!window.confirm(tradingText(locale, flatten ? "killFlattenConfirm" : "killConfirm"))) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await killAll({ operationId: createEmergencyOperationId(), flatten });
      setEmergency(result);
      setSettings((current) => (current ? { ...current, liveTradingEnabled: false } : current));
      if (!result.ok) setError(`${tradingText(locale, "killPartial")} ${result.errors.join(" ")}`.trim());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tradingText(locale, "killPartial"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="trade-settings">
      <div className="panel-header">
        <strong>
          <AlertTriangle size={14} aria-hidden="true" /> {tradingText(locale, "liveTrading")} · {tradingText(locale, "experimental")}
        </strong>
      </div>
      {settings?.demo ? (
        <p className="settings-note">{tradingText(locale, "demoOnly")}</p>
      ) : (
        <>
          <p className="settings-note">{tradingText(locale, "liveTradingExplanation")}</p>
          {settings && !secureTradingOrigin && (
            <p className="trade-warn" role="alert">
              <AlertTriangle size={13} aria-hidden="true" /> {tradingText(locale, "secureOriginRequired")}
            </p>
          )}
          <label className="live-arm-row">
            <input name="live-trading-enabled" type="checkbox" checked={settings?.liveTradingEnabled ?? false} disabled={busy || (!secureTradingOrigin && !settings?.liveTradingEnabled)} onChange={(event) => void toggleLive(event.target.checked)} />
            <span>
              {tradingText(locale, "armLiveTrading")}
              {settings?.liveTradingEnabled ? ` — ${tradingText(locale, "armed")}` : ""}
            </span>
          </label>
          <div className="emergency-actions">
            <button type="button" className="kill-switch" onClick={() => void kill(false)} disabled={busy}>
              <XOctagon size={14} aria-hidden="true" /> {busy ? tradingText(locale, "killRunning") : tradingText(locale, "killSwitch")}
            </button>
            <button type="button" className="kill-switch kill-switch-flatten" onClick={() => void kill(true)} disabled={busy}>
              <XOctagon size={14} aria-hidden="true" /> {tradingText(locale, "killFlatten")}
            </button>
          </div>
          {emergency && emergency.phase !== "idle" && (
            <div className={`emergency-status ${emergency.ok ? "confirmed" : "failed"}`} role={emergency.ok ? "status" : "alert"}>
              <strong>{emergency.ok ? tradingText(locale, "killConfirmed") : emergency.phase === "stopping" ? tradingText(locale, "killRunning") : tradingText(locale, "killPartial")}</strong>
              <span>
                {tradingText(locale, "killBotsStopped")}: {emergency.botsStopped}
              </span>
              {emergency.accounts.map((account) => (
                <span key={account.account}>
                  {account.account}: {account.cancelOrders.state} / {account.flattenPositions.state}
                  {[...account.cancelOrders.errors, ...account.flattenPositions.errors].map((message, index) => (
                    <small key={`${account.account}-${index}`}>{message}</small>
                  ))}
                </span>
              ))}
            </div>
          )}
        </>
      )}

      <div className="panel-header">
        <strong>
          <KeyRound size={14} aria-hidden="true" /> {tradingText(locale, "exchangeApiKeys")}
        </strong>
      </div>
      <p className="settings-note">{tradingText(locale, "keysSecurityNote")}</p>
      <ExchangeKeyForm exchange="binance" configured={keys.binance} disabled={!secureTradingOrigin} locale={locale} onSaved={() => getKeys().then(setKeys)} />
      <ExchangeKeyForm exchange="bybit" configured={keys.bybit} disabled={!secureTradingOrigin} locale={locale} onSaved={() => getKeys().then(setKeys)} />
      {settings?.role === "admin" && <AccountRegistryPanel locale={locale} secureTradingOrigin={secureTradingOrigin} />}
      {error && (
        <div className="strategy-warnings" role="alert">
          <span>
            <AlertTriangle size={12} aria-hidden="true" /> {error}
          </span>
        </div>
      )}

      {settings?.role === "admin" && <AccountTelemetryPanel locale={locale} />}

      {settings?.role && settings.role !== "read-only" ? (
        <Suspense fallback={<p className="settings-note">{tradingText(locale, "checkingAccess")}</p>}>
          <ResearchAlertPanel locale={locale} />
        </Suspense>
      ) : null}

      <Suspense fallback={<p className="settings-note">{tradingText(locale, "checkingAccess")}</p>}>
        <BybitUtaPanel locale={locale} configured={keys.bybit} demo={settings?.demo ?? false} liveArmed={settings?.liveTradingEnabled ?? false} secureTradingOrigin={secureTradingOrigin} />
      </Suspense>

      <div className="panel-header">
        <strong>{tradingText(locale, "notifications")}</strong>
      </div>
      <TelegramForm status={notifyStatus} locale={locale} onSaved={() => getNotify().then(setNotifyStatus)} />
    </div>
  );
}

function ExchangeKeyForm({ exchange, configured, disabled, locale, onSaved }: { exchange: ExchangeId; configured: boolean; disabled: boolean; locale: Locale; onSaved: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const save = async () => {
    setError(undefined);
    try {
      await saveKeys(exchange, apiKey, apiSecret);
      setApiKey("");
      setApiSecret("");
      setSaved(true);
      onSaved();
      window.setTimeout(() => setSaved(false), 1800);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tradingText(locale, "settingsFailed"));
    }
  };
  return (
    <form
      className="key-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="key-form-head">
        <strong>{exchange}</strong>
        {configured && <span className="badge-ok">{tradingText(locale, "configured")}</span>}
        {saved && (
          <span className="badge-ok" role="status">
            {tradingText(locale, "savedStatus")}
          </span>
        )}
      </div>
      <label>
        {tradingText(locale, "apiKey")}
        <input name={`${exchange}-api-key`} value={apiKey} autoComplete="off" required disabled={disabled} onChange={(event) => setApiKey(event.target.value)} />
      </label>
      <label>
        {tradingText(locale, "apiSecret")}
        <input name={`${exchange}-api-secret`} type="password" value={apiSecret} autoComplete="new-password" required disabled={disabled} onChange={(event) => setApiSecret(event.target.value)} />
      </label>
      <button type="submit" disabled={disabled}>
        {tradingSaveKeys(locale, exchange)}
      </button>
      {error && (
        <div className="strategy-warnings" role="alert">
          <span>{error}</span>
        </div>
      )}
    </form>
  );
}

function TelegramForm({ status, locale, onSaved }: { status?: NotifyStatus; locale: Locale; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(false);
  const [token, setToken] = useState("");
  const [chat, setChat] = useState("");
  const [testMessage, setTestMessage] = useState<string>();

  useEffect(() => {
    if (!status) return;
    setEnabled(status.telegram.enabled);
    setChat(status.telegram.chatId);
  }, [status]);

  const save = async () => {
    await saveNotify({ telegram: { enabled, token: token || undefined, chatId: chat } });
    setToken("");
    onSaved();
  };
  const test = async () => {
    const result = await testNotify();
    setTestMessage(result.ok ? tradingText(locale, "sent") : result.message);
  };

  return (
    <form
      className="key-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="check-row">
        <input name="telegram-enabled" type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        {tradingText(locale, "telegram")} {status?.telegram.hasToken && <span className="badge-ok">{tradingText(locale, "tokenSet")}</span>}
      </label>
      <label>
        {tradingText(locale, "botToken")}
        <input name="telegram-token" type="password" value={token} autoComplete="new-password" onChange={(event) => setToken(event.target.value)} />
      </label>
      <label>
        {tradingText(locale, "chatId")}
        <input name="telegram-chat-id" value={chat} inputMode="numeric" onChange={(event) => setChat(event.target.value)} />
      </label>
      <div className="key-form-actions">
        <button type="submit">{tradingText(locale, "saveNotifications")}</button>
        <button type="button" onClick={() => void test()}>
          {tradingText(locale, "sendTest")}
        </button>
      </div>
      {testMessage && (
        <div className="trade-console-out" role="status">
          {testMessage}
        </div>
      )}
      <p className="settings-note">{tradingText(locale, "notificationNote")}</p>
    </form>
  );
}
