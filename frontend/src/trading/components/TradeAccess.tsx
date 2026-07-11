import { Bot, KeyRound, Plus } from "lucide-react";
import { useState } from "react";
import type { Locale } from "../../i18n";
import { tradingText } from "../../i18n/trading";
import { checkAuth, setToken, type AuthState } from "../tradeClient";

export function TradeTokenGate({ locale, onAuthed }: { locale: Locale; onAuthed: (state: AuthState) => void }) {
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
      setError(tradingText(locale, "invalidToken"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="trade-gate" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <KeyRound size={26} aria-hidden="true" />
      <h2>{tradingText(locale, "tradingLocked")}</h2>
      <p>{tradingText(locale, "accessPrompt")}</p>
      <label className="trade-token-label" htmlFor="trade-access-token">{tradingText(locale, "accessToken")}</label>
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
      <button type="submit" className="run-button" disabled={busy}>{tradingText(locale, busy ? "checking" : "unlock")}</button>
    </form>
  );
}

export function EmptyTradingState({ locale, onNew }: { locale: Locale; onNew: () => void }) {
  return (
    <div className="trade-empty">
      <Bot size={22} aria-hidden="true" />
      <strong>{tradingText(locale, "livePaperTitle")}</strong>
      <p>{tradingText(locale, "livePaperDescription")}</p>
      <ol className="trade-empty-steps">
        <li>{tradingText(locale, "chooseStrategy")}</li>
        <li>{tradingText(locale, "runPaper")}</li>
        <li>{tradingText(locale, "reviewRisk")}</li>
      </ol>
      <button type="button" className="run-button" onClick={onNew}>
        <Plus size={14} aria-hidden="true" /> {tradingText(locale, "createPaperBot")}
      </button>
    </div>
  );
}
