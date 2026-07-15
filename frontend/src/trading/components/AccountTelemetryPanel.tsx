import { RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { useCallback, useState } from "react";
import { localeTag, type Locale } from "../../i18n";
import { DEFAULT_ACCOUNT_TELEMETRY_QUERY, normalizeAccountTelemetryQuery, type AccountTelemetryQuery, type AccountTelemetrySnapshot, type AccountTelemetryEvidence } from "../accountTelemetry";
import { accountTelemetryText as text } from "../accountTelemetryText";
import { getAccountTelemetry } from "../tradeClient";

interface Props {
  locale: Locale;
  load?: (query: AccountTelemetryQuery) => Promise<AccountTelemetrySnapshot>;
}

export function AccountTelemetryPanel({ locale, load = getAccountTelemetry }: Props) {
  const [symbols, setSymbols] = useState(DEFAULT_ACCOUNT_TELEMETRY_QUERY.symbols.join(","));
  const [assets, setAssets] = useState(DEFAULT_ACCOUNT_TELEMETRY_QUERY.assets.join(","));
  const [stableAssets, setStableAssets] = useState(DEFAULT_ACCOUNT_TELEMETRY_QUERY.stableAssets.join(","));
  const [snapshot, setSnapshot] = useState<AccountTelemetrySnapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const query = normalizeAccountTelemetryQuery({
        venues: ["binance", "bybit"],
        symbols: split(symbols),
        assets: split(assets),
        stableAssets: split(stableAssets)
      });
      setSnapshot(await load(query));
    } catch (cause) {
      setSnapshot(undefined);
      setError(cause instanceof Error ? cause.message : text(locale, "unavailable"));
    } finally {
      setBusy(false);
    }
  }, [assets, load, locale, stableAssets, symbols]);

  return (
    <section className="account-telemetry" aria-labelledby="account-telemetry-title">
      <header className="account-telemetry-header">
        <div>
          <strong id="account-telemetry-title">
            <ShieldCheck size={15} aria-hidden="true" /> {text(locale, "title")}
          </strong>
          <p>{text(locale, "description")}</p>
        </div>
        <span className="telemetry-safety-badge">{text(locale, "nonExecutable")}</span>
      </header>

      <form
        className="account-telemetry-query"
        onSubmit={(event) => {
          event.preventDefault();
          void refresh();
        }}
      >
        <label>
          {text(locale, "symbols")}
          <input name="telemetry-symbols" value={symbols} required pattern="[A-Za-z0-9]+(?:\s*,\s*[A-Za-z0-9]+){0,1}" autoCapitalize="characters" spellCheck={false} onChange={(event) => setSymbols(event.target.value)} />
        </label>
        <label>
          {text(locale, "assets")}
          <input name="telemetry-assets" value={assets} required pattern="[A-Za-z0-9]+(?:\s*,\s*[A-Za-z0-9]+){0,3}" autoCapitalize="characters" spellCheck={false} onChange={(event) => setAssets(event.target.value)} />
        </label>
        <label>
          {text(locale, "stableAssets")}
          <input name="telemetry-stable-assets" value={stableAssets} required pattern="[A-Za-z0-9]+(?:\s*,\s*[A-Za-z0-9]+){0,2}" autoCapitalize="characters" spellCheck={false} onChange={(event) => setStableAssets(event.target.value)} />
        </label>
        <button type="submit" disabled={busy}>
          <RefreshCw size={14} aria-hidden="true" className={busy ? "spin" : undefined} />
          {text(locale, busy ? "refreshing" : "refresh")}
        </button>
      </form>
      <p className="settings-note">{text(locale, "invalidQuery")}</p>
      {error && (
        <p className="trade-warn" role="alert">
          <TriangleAlert size={14} aria-hidden="true" /> {text(locale, "unavailable")}: {error}
        </p>
      )}
      <div className="account-telemetry-status" role="status" aria-live="polite">
        {busy ? text(locale, "refreshing") : snapshot ? `${text(locale, snapshot.complete ? "complete" : "partial")} · ${text(locale, "validUntil")} ${date(snapshot.validUntil, locale)}` : ""}
      </div>
      {snapshot && <AccountTelemetryView locale={locale} snapshot={snapshot} />}
    </section>
  );
}

export function AccountTelemetryView({ locale, snapshot }: { locale: Locale; snapshot: AccountTelemetrySnapshot }) {
  const fees = snapshot.venues.flatMap((item) => item.fees);
  const borrow = snapshot.venues.flatMap((item) => item.borrow);
  const networks = snapshot.venues
    .flatMap((item) => item.transferNetworks)
    .sort((left, right) => Number(right.usableForTransfer) - Number(left.usableForTransfer) || left.asset.localeCompare(right.asset))
    .slice(0, 32);
  return (
    <div className="account-telemetry-results">
      <div className="account-telemetry-venues" aria-label={text(locale, "title")}>
        {snapshot.venues.map((item) => (
          <article key={item.venue} className={`account-telemetry-venue ${item.status}`}>
            <strong>{item.venue}</strong>
            <span>{text(locale, item.configured ? "configured" : "unconfigured")}</span>
            <span>{item.status}</span>
          </article>
        ))}
      </div>

      <TelemetryTable title={text(locale, "fees")} empty={fees.length === 0} emptyText={text(locale, "noRows")}>
        <thead>
          <tr>
            <th scope="col">Venue</th>
            <th scope="col">Symbol</th>
            <th scope="col">{text(locale, "tier")}</th>
            <th scope="col">{text(locale, "maker")}</th>
            <th scope="col">{text(locale, "taker")}</th>
            <th scope="col">Evidence</th>
          </tr>
        </thead>
        <tbody>
          {fees.map((item) => (
            <tr key={`${item.venue}:${item.market}:${item.symbol}`}>
              <th scope="row">
                {item.venue} · {item.market}
              </th>
              <td>{item.symbol}</td>
              <td>{item.tierId}</td>
              <td>{bps(item.makerBps)}</td>
              <td>{bps(item.takerBps)}</td>
              <td>
                <Evidence locale={locale} value={item.evidence} usable={item.usableForRateRanking} />
              </td>
            </tr>
          ))}
        </tbody>
      </TelemetryTable>

      <TelemetryTable title={text(locale, "borrow")} empty={borrow.length === 0} emptyText={text(locale, "noRows")}>
        <thead>
          <tr>
            <th scope="col">Venue</th>
            <th scope="col">Asset</th>
            <th scope="col">{text(locale, "available")}</th>
            <th scope="col">{text(locale, "limit")}</th>
            <th scope="col">{text(locale, "annualRate")}</th>
            <th scope="col">Evidence</th>
          </tr>
        </thead>
        <tbody>
          {borrow.map((item) => (
            <tr key={`${item.venue}:${item.asset}`}>
              <th scope="row">{item.venue}</th>
              <td>{item.asset}</td>
              <td>{number(item.availableQuantity, locale)}</td>
              <td>{number(item.accountLimitQuantity, locale)}</td>
              <td>{bps(item.annualRateBps)}</td>
              <td>
                <Evidence locale={locale} value={item.evidence} usable={item.usableForProjectedCost && item.borrowable} />
                <small>{text(locale, "recallUnknown")}</small>
              </td>
            </tr>
          ))}
        </tbody>
      </TelemetryTable>

      <TelemetryTable title={text(locale, "networks")} empty={networks.length === 0} emptyText={text(locale, "noRows")}>
        <thead>
          <tr>
            <th scope="col">Venue</th>
            <th scope="col">Asset / network</th>
            <th scope="col">{text(locale, "deposit")}</th>
            <th scope="col">{text(locale, "withdrawal")}</th>
            <th scope="col">{text(locale, "withdrawalFee")}</th>
            <th scope="col">Evidence</th>
          </tr>
        </thead>
        <tbody>
          {networks.map((item) => (
            <tr key={`${item.venue}:${item.asset}:${item.network}`}>
              <th scope="row">{item.venue}</th>
              <td>
                {item.asset} · {item.network}
              </td>
              <td>{yes(item.depositEnabled)}</td>
              <td>{yes(item.withdrawEnabled)}</td>
              <td>
                {number(item.fixedWithdrawFee, locale)}
                {item.estimatedArrivalMinutes === undefined ? "" : ` · ${item.estimatedArrivalMinutes} ${text(locale, "minutes")}`}
              </td>
              <td>
                <Evidence locale={locale} value={item.evidence} usable={item.usableForTransfer} />
              </td>
            </tr>
          ))}
        </tbody>
      </TelemetryTable>

      <TelemetryTable title={text(locale, "fx")} empty={snapshot.stablecoinFx.length === 0} emptyText={text(locale, "noRows")}>
        <thead>
          <tr>
            <th scope="col">Venue</th>
            <th scope="col">Symbol</th>
            <th scope="col">Bid</th>
            <th scope="col">Ask</th>
            <th scope="col">Evidence</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.stablecoinFx.map((item) => (
            <tr key={`${item.venue}:${item.symbol}`}>
              <th scope="row">{item.venue}</th>
              <td>{item.symbol}</td>
              <td>{number(item.bid, locale)}</td>
              <td>{number(item.ask, locale)}</td>
              <td>
                <Evidence locale={locale} value={item.evidence} usable={item.usableForEconomics} />
              </td>
            </tr>
          ))}
        </tbody>
      </TelemetryTable>

      {snapshot.readiness.blockers.length > 0 && (
        <aside className="account-telemetry-blockers">
          <strong>{text(locale, "blockers")}</strong>
          <ul>
            {snapshot.readiness.blockers.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}

function TelemetryTable({ title, empty, emptyText, children }: { title: string; empty: boolean; emptyText: string; children: React.ReactNode }) {
  return (
    <section className="account-telemetry-section">
      <h3>{title}</h3>
      {empty ? (
        <p className="settings-note">{emptyText}</p>
      ) : (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded evidence table must remain horizontally keyboard-scrollable.
        <div className="account-telemetry-table" role="region" aria-label={title} tabIndex={0}>
          <table>
            <caption>{title}</caption>
            {children}
          </table>
        </div>
      )}
    </section>
  );
}

function Evidence({ locale, value, usable }: { locale: Locale; value: AccountTelemetryEvidence; usable: boolean }) {
  return (
    <span className={`telemetry-evidence ${usable && value.fresh ? "usable" : "blocked"}`} title={`${value.source} · ${date(value.asOf, locale)}`}>
      <span aria-hidden="true">●</span> {text(locale, usable && value.fresh ? "usable" : "blocked")} · {text(locale, value.timestampQuality === "venue" ? "timestampVenue" : "timestampReceive")}
    </span>
  );
}

function split(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function date(value: number, locale: Locale): string {
  return new Intl.DateTimeFormat(localeTag(locale), { dateStyle: "short", timeStyle: "medium" }).format(value);
}

function number(value: number, locale: Locale): string {
  return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 8 }).format(value);
}

function bps(value: number): string {
  return `${value.toFixed(3)} bps`;
}

function yes(value: boolean): string {
  return value ? "✓" : "—";
}
