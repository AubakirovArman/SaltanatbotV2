import { KeyRound, Pencil, Plus, Power, Trash2, WalletCards } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { Locale } from "../../i18n";
import { createTradingAccount, deleteTradingAccount, deleteTradingAccountCredentials, listTradingAccounts, setTradingAccountCredentials, updateTradingAccount, type CreateTradingAccountInput, type TradingAccountCredentialsInput, type TradingAccountOwnership, type TradingAccountStatus, type TradingAccountView, type UpdateTradingAccountInput } from "../accountClient";
import { accountRegistryText as text } from "../accountRegistryText";

interface AccountRegistryPanelProps {
  locale: Locale;
  secureTradingOrigin: boolean;
  loadAccounts?: () => Promise<TradingAccountView[]>;
  createAccount?: (input: CreateTradingAccountInput) => Promise<TradingAccountView>;
  updateAccount?: (id: string, input: UpdateTradingAccountInput) => Promise<TradingAccountView>;
  removeAccount?: (id: string) => Promise<void>;
  saveCredentials?: (id: string, input: TradingAccountCredentialsInput) => Promise<TradingAccountView>;
  clearCredentials?: (id: string) => Promise<TradingAccountView>;
  confirmAction?: (message: string) => boolean;
  onAccountsChange?: (accounts: TradingAccountView[]) => void;
}

interface EditState {
  id: string;
  label: string;
  ownership: TradingAccountOwnership;
}

export function AccountRegistryPanel({ locale, secureTradingOrigin, loadAccounts = listTradingAccounts, createAccount = createTradingAccount, updateAccount = updateTradingAccount, removeAccount = deleteTradingAccount, saveCredentials = setTradingAccountCredentials, clearCredentials = deleteTradingAccountCredentials, confirmAction = (message) => window.confirm(message), onAccountsChange }: AccountRegistryPanelProps) {
  const [accounts, setAccounts] = useState<TradingAccountView[]>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [announcement, setAnnouncement] = useState("");
  const [editing, setEditing] = useState<EditState>();

  useEffect(() => {
    let active = true;
    setError(undefined);
    loadAccounts()
      .then((value) => {
        if (active) setAccounts(sortAccounts(value));
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause, locale, "loadFailed"));
      });
    return () => {
      active = false;
    };
  }, [loadAccounts, locale]);

  useEffect(() => {
    if (accounts) onAccountsChange?.(accounts);
  }, [accounts, onAccountsChange]);

  const create = async (input: CreateTradingAccountInput) => {
    setBusy("create");
    setError(undefined);
    setAnnouncement("");
    try {
      const account = await createAccount(input);
      setAccounts((current) => sortAccounts([...(current ?? []), account]));
      setAnnouncement(text(locale, "created"));
      return true;
    } catch (cause) {
      setError(errorMessage(cause, locale));
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  const update = async (account: TradingAccountView, input: UpdateTradingAccountInput, message: "updated" | "enabledDone" | "disabledDone") => {
    setBusy(account.id);
    setError(undefined);
    setAnnouncement("");
    try {
      const next = await updateAccount(account.id, input);
      setAccounts((current) => sortAccounts((current ?? []).map((item) => (item.id === next.id ? next : item))));
      setAnnouncement(text(locale, message));
      if (message === "updated") setEditing(undefined);
    } catch (cause) {
      setError(errorMessage(cause, locale));
    } finally {
      setBusy(undefined);
    }
  };

  const toggle = (account: TradingAccountView) => {
    if (account.enabled && !confirmAction(`${text(locale, "disableConfirm")}\n\n${account.label} · ${account.exchange}`)) return;
    void update(account, { enabled: !account.enabled }, account.enabled ? "disabledDone" : "enabledDone");
  };

  const remove = async (account: TradingAccountView) => {
    if (!confirmAction(`${text(locale, "deleteConfirm")}\n\n${account.label} · ${account.exchange}`)) return;
    setBusy(account.id);
    setError(undefined);
    setAnnouncement("");
    try {
      await removeAccount(account.id);
      setAccounts((current) => (current ?? []).filter((item) => item.id !== account.id));
      if (editing?.id === account.id) setEditing(undefined);
      setAnnouncement(text(locale, "deleted"));
    } catch (cause) {
      setError(errorMessage(cause, locale));
    } finally {
      setBusy(undefined);
    }
  };

  const saveAccountCredentials = async (account: TradingAccountView, input: TradingAccountCredentialsInput) => {
    setBusy(account.id);
    setError(undefined);
    setAnnouncement("");
    try {
      const next = await saveCredentials(account.id, input);
      setAccounts((current) => sortAccounts((current ?? []).map((item) => (item.id === next.id ? next : item))));
      setAnnouncement(text(locale, account.credential.status === "configured" ? "credentialsRotated" : "credentialsSaved"));
      return true;
    } catch (cause) {
      setError(errorMessage(cause, locale));
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  const clearAccountCredentials = async (account: TradingAccountView) => {
    if (!confirmAction(`${text(locale, "credentialsDeleteConfirm")}\n\n${account.label} · ${account.exchange}`)) return;
    setBusy(account.id);
    setError(undefined);
    setAnnouncement("");
    try {
      const next = await clearCredentials(account.id);
      setAccounts((current) => sortAccounts((current ?? []).map((item) => (item.id === next.id ? next : item))));
      setAnnouncement(text(locale, "credentialsDeleted"));
    } catch (cause) {
      setError(errorMessage(cause, locale));
    } finally {
      setBusy(undefined);
    }
  };

  const mutationDisabled = !secureTradingOrigin || busy !== undefined || accounts === undefined;

  return (
    <section className="account-registry" aria-labelledby="account-registry-title">
      <header className="account-registry-header">
        <div>
          <strong id="account-registry-title">
            <WalletCards size={15} aria-hidden="true" /> {text(locale, "title")}
          </strong>
          <p>{text(locale, "description")}</p>
        </div>
      </header>

      <p className="account-registry-boundary" role="note">
        {text(locale, "boundary")}
      </p>
      {!secureTradingOrigin && (
        <p className="trade-warn" role="alert">
          {text(locale, "secureOrigin")}
        </p>
      )}

      <CreateAccountForm locale={locale} disabled={mutationDisabled} busy={busy === "create"} onCreate={create} />

      <div className="account-registry-announcement" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {error && (
        <p className="trade-warn" role="alert">
          <strong>{text(locale, accounts === undefined ? "loadFailed" : "operationFailed")}:</strong> {error}
        </p>
      )}

      {accounts === undefined && !error && (
        <p className="settings-note" role="status">
          {text(locale, "loading")}
        </p>
      )}
      {accounts?.length === 0 && <p className="settings-note">{text(locale, "empty")}</p>}
      {accounts && accounts.length > 0 && (
        <ul className="account-registry-list">
          {accounts.map((account, index) => {
            const inUse = account.botIds.length > 0;
            const isBusy = busy === account.id;
            const titleId = `account-registry-item-${index}`;
            return (
              <li key={account.id}>
                <article className={`account-registry-card status-${account.status}`} aria-labelledby={titleId}>
                  <header>
                    <div>
                      <h3 id={titleId}>{account.label}</h3>
                      <span>
                        {account.exchange} · {text(locale, account.ownership)}
                      </span>
                    </div>
                    <span className="account-registry-status">{statusText(locale, account.status)}</span>
                  </header>

                  <dl>
                    <div>
                      <dt>{text(locale, "accountId")}</dt>
                      <dd>
                        <code>{account.id}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>{text(locale, "status")}</dt>
                      <dd>{statusText(locale, account.status)}</dd>
                    </div>
                    <div>
                      <dt>{text(locale, "robots")}</dt>
                      <dd>{account.botIds.length ? account.botIds.join(", ") : text(locale, "none")}</dd>
                    </div>
                    <div>
                      <dt>{text(locale, "accountCredentials")}</dt>
                      <dd>{credentialText(locale, account)}</dd>
                    </div>
                  </dl>

                  {inUse && <p className="account-registry-in-use">{text(locale, "inUse")}</p>}

                  <AccountCredentialForm
                    locale={locale}
                    account={account}
                    disabled={mutationDisabled}
                    busy={isBusy}
                    removeDisabled={inUse}
                    onSave={(input) => saveAccountCredentials(account, input)}
                    onClear={() => void clearAccountCredentials(account)}
                  />

                  {editing?.id === account.id ? (
                    <EditAccountForm locale={locale} value={editing} disabled={mutationDisabled} onChange={setEditing} onCancel={() => setEditing(undefined)} onSave={() => void update(account, { label: editing.label, ownership: editing.ownership }, "updated")} />
                  ) : (
                    <div className="account-registry-actions">
                      <button type="button" onClick={() => setEditing({ id: account.id, label: account.label, ownership: account.ownership })} disabled={mutationDisabled}>
                        <Pencil size={13} aria-hidden="true" /> {text(locale, "edit")}
                      </button>
                      <button type="button" onClick={() => toggle(account)} disabled={mutationDisabled || inUse}>
                        <Power size={13} aria-hidden="true" /> {text(locale, account.enabled ? "disable" : "enable")}
                      </button>
                      <button type="button" className="danger" onClick={() => void remove(account)} disabled={mutationDisabled || inUse}>
                        <Trash2 size={13} aria-hidden="true" /> {text(locale, "delete")}
                      </button>
                      {isBusy && <span role="status">{text(locale, "loading")}</span>}
                    </div>
                  )}
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function AccountCredentialForm({ locale, account, disabled, busy, removeDisabled, onSave, onClear }: { locale: Locale; account: TradingAccountView; disabled: boolean; busy: boolean; removeDisabled: boolean; onSave: (input: TradingAccountCredentialsInput) => Promise<boolean>; onClear: () => void }) {
  const keyId = useId();
  const secretId = useId();
  const hintId = useId();
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");

  return (
    <form
      className="account-registry-form account-credential-form"
      method="post"
      action={`/api/trade/accounts/${encodeURIComponent(account.id)}/credentials`}
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({ apiKey, apiSecret }).then((saved) => {
          if (!saved) return;
          setApiKey("");
          setApiSecret("");
        });
      }}
    >
      <fieldset disabled={disabled}>
        <legend><KeyRound size={13} aria-hidden="true" /> {text(locale, account.credential.status === "configured" ? "rotateCredentials" : "setCredentials")}</legend>
        <p id={hintId} className="field-help">{text(locale, "credentialsHint")}</p>
        <label htmlFor={keyId}>
          <span>{text(locale, "apiKey")}</span>
          <input id={keyId} name="apiKey" type="password" value={apiKey} autoComplete="off" minLength={8} maxLength={256} required aria-describedby={hintId} onChange={(event) => setApiKey(event.target.value)} />
        </label>
        <label htmlFor={secretId}>
          <span>{text(locale, "apiSecret")}</span>
          <input id={secretId} name="apiSecret" type="password" value={apiSecret} autoComplete="off" minLength={8} maxLength={256} required aria-describedby={hintId} onChange={(event) => setApiSecret(event.target.value)} />
        </label>
        <div className="account-registry-actions">
          <button type="submit">{text(locale, busy ? "savingCredentials" : account.credential.status === "configured" ? "rotateCredentials" : "setCredentials")}</button>
          {account.credential.status === "configured" && (
            <button type="button" className="danger" disabled={removeDisabled} onClick={onClear}>
              <Trash2 size={13} aria-hidden="true" /> {text(locale, "deleteCredentials")}
            </button>
          )}
        </div>
      </fieldset>
    </form>
  );
}

function CreateAccountForm({ locale, disabled, busy, onCreate }: { locale: Locale; disabled: boolean; busy: boolean; onCreate: (input: CreateTradingAccountInput) => Promise<boolean> }) {
  const [label, setLabel] = useState("");
  const [exchange, setExchange] = useState<"binance" | "bybit">("bybit");
  const [ownership, setOwnership] = useState<TradingAccountOwnership>("own");

  return (
    <form
      className="account-registry-form"
      method="post"
      action="/api/trade/accounts"
      onSubmit={(event) => {
        event.preventDefault();
        void onCreate({ label, exchange, ownership, enabled: true }).then((created) => {
          if (created) setLabel("");
        });
      }}
    >
      <strong>{text(locale, "createTitle")}</strong>
      <label>
        {text(locale, "label")}
        <input name="account-label" value={label} required maxLength={120} disabled={disabled} onChange={(event) => setLabel(event.target.value)} />
      </label>
      <fieldset disabled={disabled}>
        <legend>{text(locale, "exchange")}</legend>
        <label>
          <input type="radio" name="account-exchange" value="bybit" checked={exchange === "bybit"} onChange={() => setExchange("bybit")} /> Bybit
        </label>
        <label>
          <input type="radio" name="account-exchange" value="binance" checked={exchange === "binance"} onChange={() => setExchange("binance")} /> Binance
        </label>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>{text(locale, "ownership")}</legend>
        <label>
          <input type="radio" name="account-ownership" value="own" checked={ownership === "own"} onChange={() => setOwnership("own")} /> {text(locale, "own")}
        </label>
        <label>
          <input type="radio" name="account-ownership" value="managed" checked={ownership === "managed"} onChange={() => setOwnership("managed")} /> {text(locale, "managed")}
        </label>
      </fieldset>
      <button type="submit" disabled={disabled}>
        <Plus size={13} aria-hidden="true" /> {text(locale, busy ? "creating" : "create")}
      </button>
    </form>
  );
}

function EditAccountForm({ locale, value, disabled, onChange, onCancel, onSave }: { locale: Locale; value: EditState; disabled: boolean; onChange: (value: EditState) => void; onCancel: () => void; onSave: () => void }) {
  return (
    <form
      className="account-registry-edit"
      method="post"
      action={`/api/trade/accounts/${encodeURIComponent(value.id)}`}
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <label>
        {text(locale, "label")}
        <input name={`account-label-${value.id}`} value={value.label} required maxLength={120} disabled={disabled} onChange={(event) => onChange({ ...value, label: event.target.value })} />
      </label>
      <fieldset disabled={disabled}>
        <legend>{text(locale, "ownership")}</legend>
        <label>
          <input type="radio" name={`account-ownership-${value.id}`} value="own" checked={value.ownership === "own"} onChange={() => onChange({ ...value, ownership: "own" })} /> {text(locale, "own")}
        </label>
        <label>
          <input type="radio" name={`account-ownership-${value.id}`} value="managed" checked={value.ownership === "managed"} onChange={() => onChange({ ...value, ownership: "managed" })} /> {text(locale, "managed")}
        </label>
      </fieldset>
      <div className="account-registry-actions">
        <button type="submit" disabled={disabled}>
          {text(locale, "save")}
        </button>
        <button type="button" onClick={onCancel}>
          {text(locale, "cancel")}
        </button>
      </div>
    </form>
  );
}

function sortAccounts(accounts: TradingAccountView[]): TradingAccountView[] {
  return [...accounts].sort((left, right) => left.exchange.localeCompare(right.exchange) || left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

function statusText(locale: Locale, status: TradingAccountStatus): string {
  if (status === "ready") return text(locale, "ready");
  if (status === "credentials_missing") return text(locale, "credentialsMissing");
  return text(locale, "disabled");
}

function credentialText(locale: Locale, account: TradingAccountView): string {
  return text(locale, account.credential.status === "configured" ? "configuredCredentials" : "missingCredentials");
}

function errorMessage(cause: unknown, locale: Locale, fallback: "loadFailed" | "operationFailed" = "operationFailed"): string {
  return cause instanceof Error && cause.message ? cause.message : text(locale, fallback);
}
