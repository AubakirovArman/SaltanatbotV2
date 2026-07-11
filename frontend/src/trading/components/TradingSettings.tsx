import { AlertTriangle, KeyRound, XOctagon } from "lucide-react";
import { useEffect, useState } from "react";
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

export function TradingSettings() {
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
    if (!window.confirm("Stop ALL bots and disarm live trading now?")) return;
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
      <div className="panel-header"><strong><AlertTriangle size={14} aria-hidden="true" /> Live trading</strong></div>
      {settings?.demo ? (
        <p className="settings-note">Running in demo mode — only paper trading is available.</p>
      ) : (
        <>
          <p className="settings-note">Live trading places real orders with your exchange keys. It is disarmed by default; arm it only when you intend to trade for real. The kill switch stops every bot and disarms instantly.</p>
          <label className="live-arm-row">
            <input name="live-trading-enabled" type="checkbox" checked={settings?.liveTradingEnabled ?? false} disabled={busy} onChange={(event) => void toggleLive(event.target.checked)} />
            <span>Arm live trading{settings?.liveTradingEnabled ? " — ARMED" : ""}</span>
          </label>
          <button type="button" className="kill-switch" onClick={() => void kill()} disabled={busy}>
            <XOctagon size={14} aria-hidden="true" /> Kill switch — stop all bots
          </button>
        </>
      )}

      <div className="panel-header"><strong><KeyRound size={14} aria-hidden="true" /> Exchange API keys</strong></div>
      <p className="settings-note">Keys are stored encrypted on the server and never returned to the browser. Use trade permissions without withdrawals and enable an IP allowlist.</p>
      <ExchangeKeyForm exchange="binance" configured={keys.binance} onSaved={() => getKeys().then(setKeys)} />
      <ExchangeKeyForm exchange="bybit" configured={keys.bybit} onSaved={() => getKeys().then(setKeys)} />

      <div className="panel-header"><strong>Notifications</strong></div>
      <TelegramForm status={notifyStatus} onSaved={() => getNotify().then(setNotifyStatus)} />
    </div>
  );
}

function ExchangeKeyForm({ exchange, configured, onSaved }: { exchange: ExchangeId; configured: boolean; onSaved: () => void }) {
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
        {configured && <span className="badge-ok">configured</span>}
        {saved && <span className="badge-ok" role="status">saved</span>}
      </div>
      <label>API key
        <input name={`${exchange}-api-key`} value={apiKey} autoComplete="off" required onChange={(event) => setApiKey(event.target.value)} />
      </label>
      <label>API secret
        <input name={`${exchange}-api-secret`} type="password" value={apiSecret} autoComplete="new-password" required onChange={(event) => setApiSecret(event.target.value)} />
      </label>
      <button type="submit">Save {exchange} keys</button>
    </form>
  );
}

function TelegramForm({ status, onSaved }: { status?: NotifyStatus; onSaved: () => void }) {
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
    setTestMessage(result.ok ? "Sent ✓" : result.message);
  };

  return (
    <form className="key-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label className="check-row">
        <input name="telegram-enabled" type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        Telegram {status?.telegram.hasToken && <span className="badge-ok">token set</span>}
      </label>
      <label>Bot token
        <input name="telegram-token" type="password" value={token} autoComplete="new-password" onChange={(event) => setToken(event.target.value)} />
      </label>
      <label>Chat ID
        <input name="telegram-chat-id" value={chat} inputMode="numeric" onChange={(event) => setChat(event.target.value)} />
      </label>
      <div className="key-form-actions">
        <button type="submit">Save notifications</button>
        <button type="button" onClick={() => void test()}>Send test</button>
      </div>
      {testMessage && <div className="trade-console-out" role="status">{testMessage}</div>}
      <p className="settings-note">VK and other channels can be added the same way. Notifications fire on start/stop, position open/close, errors and signal markers.</p>
    </form>
  );
}
