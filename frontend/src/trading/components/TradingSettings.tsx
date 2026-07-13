import { AlertTriangle, KeyRound, XOctagon } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import type { Locale } from "../../i18n";
import { tradingSaveKeys, tradingText } from "../../i18n/trading";
import {
  getKeys,
  getNotify,
  getSettings,
  killAll,
  saveKeys,
  saveNotify,
  setLiveTrading,
  testNotify,
  type AuthState,
  type ExchangeId,
  type NotifyStatus
} from "../tradeClient";

const BybitUtaPanel = lazy(() => import("./bybit-uta/BybitUtaPanel").then((module) => ({ default: module.BybitUtaPanel })));

export function TradingSettings({ locale }: { locale: Locale }) {
  const [keys, setKeys] = useState({ binance: false, bybit: false });
  const [notifyStatus, setNotifyStatus] = useState<NotifyStatus>();
  const [settings, setSettings] = useState<AuthState>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getKeys().then(setKeys).catch(() => undefined);
    getNotify().then(setNotifyStatus).catch(() => undefined);
    getSettings().then(setSettings).catch(() => undefined);
  }, []);

  const toggleLive = async (next: boolean) => {
    setBusy(true);
    try {
      await setLiveTrading(next);
      setSettings((current) => current ? { ...current, liveTradingEnabled: next } : current);
    } finally {
      setBusy(false);
    }
  };

  const kill = async () => {
    if (!window.confirm(tradingText(locale, "killConfirm"))) return;
    setBusy(true);
    try {
      await killAll();
      setSettings((current) => current ? { ...current, liveTradingEnabled: false } : current);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="trade-settings">
      <div className="panel-header"><strong><AlertTriangle size={14} aria-hidden="true" /> {tradingText(locale, "liveTrading")} · {tradingText(locale, "experimental")}</strong></div>
      {settings?.demo ? (
        <p className="settings-note">{tradingText(locale, "demoOnly")}</p>
      ) : (
        <>
          <p className="settings-note">{tradingText(locale, "liveTradingExplanation")}</p>
          <label className="live-arm-row">
            <input name="live-trading-enabled" type="checkbox" checked={settings?.liveTradingEnabled ?? false} disabled={busy} onChange={(event) => void toggleLive(event.target.checked)} />
            <span>{tradingText(locale, "armLiveTrading")}{settings?.liveTradingEnabled ? ` — ${tradingText(locale, "armed")}` : ""}</span>
          </label>
          <button type="button" className="kill-switch" onClick={() => void kill()} disabled={busy}>
            <XOctagon size={14} aria-hidden="true" /> {tradingText(locale, "killSwitch")}
          </button>
        </>
      )}

      <div className="panel-header"><strong><KeyRound size={14} aria-hidden="true" /> {tradingText(locale, "exchangeApiKeys")}</strong></div>
      <p className="settings-note">{tradingText(locale, "keysSecurityNote")}</p>
      <ExchangeKeyForm exchange="binance" configured={keys.binance} locale={locale} onSaved={() => getKeys().then(setKeys)} />
      <ExchangeKeyForm exchange="bybit" configured={keys.bybit} locale={locale} onSaved={() => getKeys().then(setKeys)} />

      <Suspense fallback={<p className="settings-note">{tradingText(locale, "checkingAccess")}</p>}>
        <BybitUtaPanel
          locale={locale}
          configured={keys.bybit}
          demo={settings?.demo ?? false}
          liveArmed={settings?.liveTradingEnabled ?? false}
        />
      </Suspense>

      <div className="panel-header"><strong>{tradingText(locale, "notifications")}</strong></div>
      <TelegramForm status={notifyStatus} locale={locale} onSaved={() => getNotify().then(setNotifyStatus)} />
    </div>
  );
}

function ExchangeKeyForm({ exchange, configured, locale, onSaved }: { exchange: ExchangeId; configured: boolean; locale: Locale; onSaved: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [saved, setSaved] = useState(false);
  const save = async () => {
    await saveKeys(exchange, apiKey, apiSecret);
    setApiKey("");
    setApiSecret("");
    setSaved(true);
    onSaved();
    window.setTimeout(() => setSaved(false), 1800);
  };
  return (
    <form className="key-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="key-form-head">
        <strong>{exchange}</strong>
        {configured && <span className="badge-ok">{tradingText(locale, "configured")}</span>}
        {saved && <span className="badge-ok" role="status">{tradingText(locale, "savedStatus")}</span>}
      </div>
      <label>{tradingText(locale, "apiKey")}
        <input name={`${exchange}-api-key`} value={apiKey} autoComplete="off" required onChange={(event) => setApiKey(event.target.value)} />
      </label>
      <label>{tradingText(locale, "apiSecret")}
        <input name={`${exchange}-api-secret`} type="password" value={apiSecret} autoComplete="new-password" required onChange={(event) => setApiSecret(event.target.value)} />
      </label>
      <button type="submit">{tradingSaveKeys(locale, exchange)}</button>
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
    <form className="key-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label className="check-row">
        <input name="telegram-enabled" type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        {tradingText(locale, "telegram")} {status?.telegram.hasToken && <span className="badge-ok">{tradingText(locale, "tokenSet")}</span>}
      </label>
      <label>{tradingText(locale, "botToken")}
        <input name="telegram-token" type="password" value={token} autoComplete="new-password" onChange={(event) => setToken(event.target.value)} />
      </label>
      <label>{tradingText(locale, "chatId")}
        <input name="telegram-chat-id" value={chat} inputMode="numeric" onChange={(event) => setChat(event.target.value)} />
      </label>
      <div className="key-form-actions">
        <button type="submit">{tradingText(locale, "saveNotifications")}</button>
        <button type="button" onClick={() => void test()}>{tradingText(locale, "sendTest")}</button>
      </div>
      {testMessage && <div className="trade-console-out" role="status">{testMessage}</div>}
      <p className="settings-note">{tradingText(locale, "notificationNote")}</p>
    </form>
  );
}
