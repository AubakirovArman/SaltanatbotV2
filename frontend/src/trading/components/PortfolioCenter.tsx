import { Bot, CircleAlert, RefreshCw, Settings2, WalletCards } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { automationText } from "../../i18n/automation";
import { localeTag, type Locale } from "../../i18n";
import { tradingTerm, tradingText } from "../../i18n/trading";
import { listTradingAccounts, type TradingAccountStatus, type TradingAccountView } from "../accountClient";
import {
  getPortfolio,
  type PortfolioExchangeAccount,
  type PortfolioOrder,
  type PortfolioPosition,
  type PortfolioSummary
} from "../portfolioClient";
import type { TradingBot } from "../tradeClient";

interface PortfolioCenterProps {
  bots: TradingBot[];
  locale: Locale;
  onNew: () => void;
  onOpenBot: (id: string) => void;
  onOpenSettings: () => void;
  loadPortfolio?: () => Promise<PortfolioSummary>;
  canReadAccounts?: boolean;
  canCreate?: boolean;
  loadAccounts?: () => Promise<TradingAccountView[]>;
}

type LoadState = "loading" | "refreshing" | "ready";

export function PortfolioCenter({
  bots,
  locale,
  onNew,
  onOpenBot,
  onOpenSettings,
  loadPortfolio = getPortfolio,
  canReadAccounts = false,
  canCreate = true,
  loadAccounts = listTradingAccounts
}: PortfolioCenterProps) {
  const [summary, setSummary] = useState<PortfolioSummary>();
  const [accounts, setAccounts] = useState<TradingAccountView[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState<string>();
  const [accountRegistryError, setAccountRegistryError] = useState<string>();
  const [updatedAt, setUpdatedAt] = useState<number>();
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const currentRequest = ++request.current;
    setLoadState((current) => current === "loading" ? "loading" : "refreshing");
    try {
      const [portfolioResult, accountResult] = await Promise.allSettled([
        loadPortfolio(),
        canReadAccounts ? loadAccounts() : Promise.resolve([])
      ] as const);
      if (currentRequest !== request.current) return;
      if (portfolioResult.status === "rejected") throw portfolioResult.reason;
      const next = portfolioResult.value;
      setSummary(next);
      if (accountResult.status === "fulfilled") {
        setAccounts(accountResult.value);
        setAccountRegistryError(undefined);
      } else {
        setAccountRegistryError(accountResult.reason instanceof Error ? accountResult.reason.message : String(accountResult.reason));
      }
      setUpdatedAt(Date.now());
      setError(undefined);
      setLoadState("ready");
    } catch (cause) {
      if (currentRequest !== request.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setLoadState("ready");
    }
  }, [canReadAccounts, loadAccounts, loadPortfolio]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10_000);
    return () => {
      request.current += 1;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const runningBots = bots.filter((bot) => bot.status === "running");
  const positionCount = summary
    ? aggregateCoverageCount(summary.exchanges, summary.paper.reduce((total, bot) => total + (bot.position ? 1 : 0), 0), "positions")
    : "0";
  const orderCount = summary
    ? aggregateCoverageCount(summary.exchanges, summary.paper.reduce((total, bot) => total + bot.openOrders.length, 0), "openOrders")
    : "0";
  const empty = !!summary && summary.exchanges.length === 0 && summary.paper.length === 0;

  return (
    <section className="robots-center" aria-labelledby="robots-center-title">
      <header className="robots-center-header">
        <div>
          <h1 id="robots-center-title">{automationText(locale, "robotsCenter")}</h1>
          <p>{automationText(locale, "robotsCenterDescription")}</p>
        </div>
        <div className="robots-center-actions">
          {canCreate && (
            <button type="button" className="secondary-button" onClick={onOpenSettings}>
              <Settings2 size={14} aria-hidden="true" />
              {automationText(locale, "openSettings")}
            </button>
          )}
          <button type="button" className="icon-button" onClick={() => void refresh()} disabled={loadState !== "ready"} aria-label={automationText(locale, "refresh")} title={automationText(locale, "refresh")}>
            <RefreshCw size={15} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="portfolio-update-status" role="status" aria-live="polite" aria-atomic="true">
        {loadState === "loading" || loadState === "refreshing"
          ? automationText(locale, "refreshing")
          : updatedAt
            ? `${automationText(locale, "lastUpdated")}: ${new Date(updatedAt).toLocaleTimeString(localeTag(locale))}`
            : ""}
      </div>

      {error && (
        <div className="portfolio-error" role="alert">
          <CircleAlert size={16} aria-hidden="true" />
          <span><strong>{automationText(locale, "loadFailed")}.</strong> {error}</span>
        </div>
      )}

      {accountRegistryError && (
        <div className="portfolio-error metadata-warning" role="alert">
          <CircleAlert size={16} aria-hidden="true" />
          <span><strong>{automationText(locale, "accountRegistryFailed")}.</strong> {accountRegistryError}</span>
        </div>
      )}

      {loadState === "loading" && !summary && (
        <div className="portfolio-loading" role="status">
          <span className="loader-ring" aria-hidden="true" />
          {automationText(locale, "refreshing")}
        </div>
      )}

      {empty && (
        <div className="trade-empty robots-empty">
          <Bot size={24} aria-hidden="true" />
          <h2>{automationText(locale, "noRunning")}</h2>
          <p><strong>{tradingText(locale, "livePaperTitle")}</strong></p>
          <p>{automationText(locale, "noRunningHint")}</p>
          {canCreate && <button type="button" className="run-button" onClick={onNew}>{tradingText(locale, "createPaperBot")}</button>}
        </div>
      )}

      {summary && !empty && (
        <>
          <dl className="portfolio-overview" aria-label={automationText(locale, "overview")}>
            <Metric label={automationText(locale, "runningBots")} value={String(Math.max(runningBots.length, summary.paper.length))} />
            <Metric label={automationText(locale, "liveAccountCount")} value={String(summary.exchanges.length)} />
            <Metric label={automationText(locale, "realizedToday")} value={formatSigned(summary.totalRealizedToday, locale)} tone={summary.totalRealizedToday > 0 ? "positive" : summary.totalRealizedToday < 0 ? "negative" : undefined} />
            <Metric label={automationText(locale, "positions")} value={positionCount} />
            <Metric label={automationText(locale, "orders")} value={orderCount} />
          </dl>

          <section className="portfolio-section" aria-labelledby="live-accounts-title">
            <div className="portfolio-section-heading">
              <WalletCards size={17} aria-hidden="true" />
              <h2 id="live-accounts-title">{automationText(locale, "liveAccounts")}</h2>
            </div>
            {summary.exchanges.length === 0 ? (
              <p className="empty-note">{automationText(locale, "noLiveAccounts")}</p>
            ) : (
              <ul className="portfolio-account-grid">
                {summary.exchanges.map((account) => (
                  <li key={account.id}>
                    <LiveAccountCard
                      account={account}
                      accountMetadata={accounts.find((candidate) => candidate.id === account.accountId)}
                      bots={runningBots.filter((bot) => liveBotAccountId(bot) === account.accountId && bot.market === account.market)}
                      locale={locale}
                      onOpenBot={onOpenBot}
                      onOpenSettings={onOpenSettings}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="portfolio-section" aria-labelledby="paper-bots-title">
            <div className="portfolio-section-heading">
              <Bot size={17} aria-hidden="true" />
              <h2 id="paper-bots-title">{automationText(locale, "paperBots")}</h2>
            </div>
            {summary.paper.length === 0 ? (
              <p className="empty-note">{automationText(locale, "noPaperBots")}</p>
            ) : (
              <div className="portfolio-table-wrap">
                <table className="portfolio-table">
                  <caption>{automationText(locale, "paperBots")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{automationText(locale, "bot")}</th>
                      <th scope="col">{automationText(locale, "symbol")}</th>
                      <th scope="col">{automationText(locale, "balance")}</th>
                      <th scope="col">{automationText(locale, "equity")}</th>
                      <th scope="col">{automationText(locale, "positions")}</th>
                      <th scope="col">{automationText(locale, "orders")}</th>
                      <th scope="col">{automationText(locale, "realizedToday")}</th>
                      <th scope="col">{automationText(locale, "marginBorrow")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.paper.map((paper) => (
                      <tr key={paper.botId}>
                        <th scope="row">
                          <button type="button" className="portfolio-link" onClick={() => onOpenBot(paper.botId)} aria-label={`${automationText(locale, "openBot")}: ${paper.name}`}>
                            {paper.name}
                          </button>
                          <small>{automationText(locale, "simulation")}</small>
                        </th>
                        <td>{paper.symbol}</td>
                        <td>{formatNumber(paper.balance, locale)}</td>
                        <td>{formatNumber(paper.equity, locale)}</td>
                        <td>{paper.position ? `${tradingTerm(locale, paper.position.side)} · ${formatNumber(paper.position.qty, locale)}` : "—"}</td>
                        <td>{paper.openOrders.length}</td>
                        <td className={toneClass(summary.realizedTodayByBot[paper.botId] ?? 0)}>{formatSigned(summary.realizedTodayByBot[paper.botId] ?? 0, locale)}</td>
                        <td>{automationText(locale, "notApplicable")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "positive" | "negative" }) {
  return (
    <div className={tone ? `portfolio-metric ${tone}` : "portfolio-metric"}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function LiveAccountCard({
  account,
  accountMetadata,
  bots,
  locale,
  onOpenBot,
  onOpenSettings
}: {
  account: PortfolioExchangeAccount;
  accountMetadata?: TradingAccountView;
  bots: TradingBot[];
  locale: Locale;
  onOpenBot: (id: string) => void;
  onOpenSettings: () => void;
}) {
  const degraded = !!account.error || account.positionsCoverage !== "account-wide" || account.openOrdersCoverage !== "account-wide" || (!!accountMetadata && accountMetadata.status !== "ready");
  return (
    <article className={`portfolio-account-card ${degraded ? "degraded" : "healthy"}`}>
      <header>
        <div>
          <div className="portfolio-account-badges">
            <span className="portfolio-account-kind">{automationText(locale, "live")}</span>
            {accountMetadata && <span className="portfolio-account-ownership">{automationText(locale, accountMetadata.ownership === "own" ? "ownershipOwn" : "ownershipManaged")}</span>}
          </div>
          <h3>{accountMetadata?.label ?? account.exchange} · {tradingText(locale, account.market)}</h3>
          <p>{account.accountId}</p>
        </div>
        <span className={`portfolio-health ${degraded ? "degraded" : "healthy"}`}>
          {degraded ? `! ${accountMetadata ? accountStatusText(locale, accountMetadata.status) : automationText(locale, "degraded")}` : `✓ ${automationText(locale, "healthy")}`}
        </span>
      </header>

      {account.error && <p className="portfolio-account-error"><strong>{automationText(locale, "error")}:</strong> {account.error}</p>}

      <dl className="portfolio-account-metrics">
        <Metric label={automationText(locale, "balance")} value={formatAmount(account.balance, account.currency, locale)} />
        <Metric label={automationText(locale, "equity")} value={formatAmount(account.equity, account.currency, locale)} />
        <Metric label={automationText(locale, "positions")} value={coverageCount(account.positions.length, account.positionsCoverage)} />
        <Metric label={automationText(locale, "orders")} value={coverageCount(account.openOrders.length, account.openOrdersCoverage)} />
      </dl>

      {(account.positionsCoverage !== "account-wide" || account.openOrdersCoverage !== "account-wide") && (
        <div className="portfolio-account-error metadata-warning" role="status">
          {account.positionsCoverage !== "account-wide" && <p><strong>{automationText(locale, "positions")}:</strong> {automationText(locale, account.positionsCoverage === "unavailable" ? "unavailableCoverage" : "botSymbolsCoverage")}</p>}
          {account.openOrdersCoverage !== "account-wide" && <p><strong>{automationText(locale, "orders")}:</strong> {automationText(locale, account.openOrdersCoverage === "unavailable" ? "unavailableCoverage" : "botSymbolsCoverage")}</p>}
        </div>
      )}

      <div className="portfolio-associated-bots">
        <strong>{automationText(locale, "associatedBots")}</strong>
        {bots.length ? (
          <ul>
            {bots.map((bot) => (
              <li key={bot.id}>
                <button type="button" className="portfolio-link" onClick={() => onOpenBot(bot.id)}>{bot.name}</button>
                <span>{bot.symbol} · {bot.timeframe}</span>
              </li>
            ))}
          </ul>
        ) : <span>—</span>}
      </div>

      {accountMetadata && (
        <div className="portfolio-credential-truth">
          <strong>{automationText(locale, "isolatedCredentials")}: {automationText(locale, accountMetadata.credential.status === "configured" ? "accountReady" : "accountCredentialsMissing")}</strong>
          <span>{automationText(locale, "credentialsNeverReturned")}</span>
        </div>
      )}

      {account.positions.length > 0 && <PositionTable positions={account.positions} locale={locale} />}
      {account.openOrders.length > 0 && <OrderTable orders={account.openOrders} locale={locale} />}

      <aside className="portfolio-unavailable" aria-label={automationText(locale, "marginBorrow")}>
        <div>
          <strong>{automationText(locale, "marginBorrow")}: {automationText(locale, "notAvailable")}</strong>
          <p>{automationText(locale, "marginBorrowUnavailable")}</p>
        </div>
        <button type="button" className="secondary-button" onClick={onOpenSettings}>{automationText(locale, "openSettings")}</button>
      </aside>
    </article>
  );
}

function PositionTable({ positions, locale }: { positions: PortfolioPosition[]; locale: Locale }) {
  return (
    <div className="portfolio-table-wrap compact">
      <table className="portfolio-table">
        <caption>{automationText(locale, "positionDetails")}</caption>
        <thead><tr>
          <th scope="col">{automationText(locale, "symbol")}</th>
          <th scope="col">{automationText(locale, "side")}</th>
          <th scope="col">{automationText(locale, "quantity")}</th>
          <th scope="col">{automationText(locale, "entryPrice")}</th>
          <th scope="col">{automationText(locale, "leverage")}</th>
        </tr></thead>
        <tbody>{positions.map((position, index) => (
          <tr key={`${position.symbol}:${position.side}:${index}`}>
            <th scope="row">{position.symbol}</th>
            <td>{tradingTerm(locale, position.side)}</td>
            <td>{formatNumber(position.qty, locale)}</td>
            <td>{formatNumber(position.entryPrice, locale)}</td>
            <td>{formatNumber(position.leverage, locale)}×</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function OrderTable({ orders, locale }: { orders: PortfolioOrder[]; locale: Locale }) {
  return (
    <div className="portfolio-table-wrap compact">
      <table className="portfolio-table">
        <caption>{automationText(locale, "orderDetails")}</caption>
        <thead><tr>
          <th scope="col">{automationText(locale, "symbol")}</th>
          <th scope="col">{automationText(locale, "side")}</th>
          <th scope="col">{automationText(locale, "type")}</th>
          <th scope="col">{automationText(locale, "quantity")}</th>
          <th scope="col">{automationText(locale, "price")}</th>
        </tr></thead>
        <tbody>{orders.map((order) => (
          <tr key={order.id}>
            <th scope="row">{order.symbol}</th>
            <td>{tradingTerm(locale, order.side)}</td>
            <td>{tradingTerm(locale, order.type)}</td>
            <td>{formatNumber(order.qty, locale)}</td>
            <td>{order.price === undefined && order.trgPrice === undefined ? "—" : formatNumber(order.price ?? order.trgPrice ?? 0, locale)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 8 }).format(value);
}

function coverageCount(count: number, coverage: PortfolioExchangeAccount["positionsCoverage"]): string {
  if (coverage === "account-wide") return String(count);
  if (coverage === "bot-symbols-only") return `≥ ${count}`;
  return "—";
}

function aggregateCoverageCount(accounts: readonly PortfolioExchangeAccount[], paperCount: number, resource: "positions" | "openOrders"): string {
  const count = paperCount + accounts.reduce((total, account) => total + account[resource].length, 0);
  const complete = accounts.every((account) => account[resource === "positions" ? "positionsCoverage" : "openOrdersCoverage"] === "account-wide");
  if (complete) return String(count);
  return count > 0 ? `≥ ${count}` : "—";
}

function formatSigned(value: number, locale: Locale): string {
  return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 8, signDisplay: "exceptZero" }).format(value);
}

function formatAmount(value: number, currency: string, locale: Locale): string {
  return `${formatNumber(value, locale)} ${currency}`;
}

function toneClass(value: number): string | undefined {
  return value > 0 ? "positive" : value < 0 ? "negative" : undefined;
}

function liveBotAccountId(bot: TradingBot): string | undefined {
  if (bot.exchange === "paper") return undefined;
  return bot.accountId ?? `${bot.exchange}:default`;
}

function accountStatusText(locale: Locale, status: TradingAccountStatus): string {
  if (status === "ready") return automationText(locale, "accountReady");
  if (status === "credentials_missing") return automationText(locale, "accountCredentialsMissing");
  return automationText(locale, "accountDisabled");
}
