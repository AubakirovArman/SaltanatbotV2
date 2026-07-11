import { Bot, KeyRound, Plus } from "lucide-react";
import { useState } from "react";
import { checkAuth, setToken, type AuthState } from "../tradeClient";

export function TradeTokenGate({ onAuthed }: { onAuthed: (state: AuthState) => void }) {
  const [token, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async () => {
    if (!token.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const state = await checkAuth(token.trim());
      setToken(token.trim());
      onAuthed(state);
    } catch {
      setError("Invalid access token.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="trade-gate" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <KeyRound size={26} aria-hidden="true" />
      <h2>Trading is locked</h2>
      <p>Enter the admin access token to manage paper and live bots. Public charts stay open; trading controls remain locked until this token is verified.</p>
      <label className="trade-token-label" htmlFor="trade-access-token">Access token</label>
      <input
        id="trade-access-token"
        name="access-token"
        type="password"
        value={token}
        autoComplete="current-password"
        enterKeyHint="done"
        required
        autoFocus
        onChange={(event) => setInput(event.target.value)}
        aria-describedby={error ? "trade-access-error" : undefined}
      />
      {error && <span id="trade-access-error" className="trade-gate-error" role="alert">{error}</span>}
      <button type="submit" className="run-button" disabled={busy}>{busy ? "Checking…" : "Unlock"}</button>
    </form>
  );
}

export function EmptyTradingState({ onNew }: { onNew: () => void }) {
  return (
    <div className="trade-empty">
      <Bot size={22} aria-hidden="true" />
      <strong>Live &amp; paper trading</strong>
      <p>Start with a saved strategy in paper mode, verify signals, then arm live execution only when keys and risk settings are ready.</p>
      <ol className="trade-empty-steps">
        <li>Choose a saved strategy</li>
        <li>Run it on paper</li>
        <li>Review logs, fills and risk</li>
      </ol>
      <button type="button" className="run-button" onClick={onNew}>
        <Plus size={14} aria-hidden="true" /> Create paper bot
      </button>
    </div>
  );
}
