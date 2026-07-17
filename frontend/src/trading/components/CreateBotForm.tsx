import { AlertTriangle, Bot } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Locale } from "../../i18n";
import { paperPortfolioText } from "../../i18n/paperPortfolio";
import { tradingText } from "../../i18n/trading";
import { compileXmlToIr } from "../../strategy/compileArtifact";
import type { StrategyArtifact } from "../../strategy/library";
import type { CatalogResponse } from "../../types";
import { listTradingAccounts, type TradingAccountView } from "../accountClient";
import { createPaperIdempotencyKey, getPaperPortfolio, listPaperPortfolios } from "../paperPortfolioClient";
import { comparePaperMoney, toCanonicalPositivePaperMoney } from "../paperPortfolioMoney";
import { saveBot, type ExchangeId, type SaveBotInput, type SaveBotOptions, type TradingBot } from "../tradeClient";
import { DEFAULT_LIVE_RISK_LIMITS, validLiveRiskLimits } from "../liveRisk";
import { usePaperBotBinding } from "../usePaperBotBinding";

interface CreateBotFormProps {
  strategies: StrategyArtifact[];
  catalog?: CatalogResponse;
  locale: Locale;
  canReadAccounts?: boolean;
  paperOnly?: boolean;
  ownerUserId?: string;
  paperPortfolioBindingRequired?: boolean;
  onCreated: (bot: TradingBot) => void;
  onOpenPortfolioCenter?: () => void;
  loadAccounts?: () => Promise<TradingAccountView[]>;
  loadPaperPortfolios?: typeof listPaperPortfolios;
  loadPaperPortfolio?: typeof getPaperPortfolio;
  saveTradingBot?: (bot: SaveBotInput, options?: SaveBotOptions) => Promise<TradingBot>;
}

type DurablePaperBotInput = Required<Pick<
  SaveBotInput,
  "paperPortfolioId" | "paperAllocation" | "expectedPortfolioRevision" | "expectedLedgerEpoch"
>>;

export function CreateBotForm({
  strategies,
  catalog,
  locale,
  canReadAccounts = false,
  paperOnly = false,
  ownerUserId,
  paperPortfolioBindingRequired,
  onCreated,
  onOpenPortfolioCenter,
  loadAccounts = listTradingAccounts,
  loadPaperPortfolios = listPaperPortfolios,
  loadPaperPortfolio = getPaperPortfolio,
  saveTradingBot = saveBot
}: CreateBotFormProps) {
  const runnable = useMemo(() => strategies.filter((item) => item.kind === "strategy"), [strategies]);
  const [strategyId, setStrategyId] = useState(runnable[0]?.id ?? "");
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [timeframe, setTimeframe] = useState<TradingBot["timeframe"]>("1m");
  const [exchange, setExchange] = useState<ExchangeId>("paper");
  const [market, setMarket] = useState<"spot" | "futures">("futures");
  const [sizeMode, setSizeMode] = useState<TradingBot["sizeMode"]>("quote");
  const [sizeValue, setSizeValue] = useState(100);
  const [leverage, setLeverage] = useState(3);
  const [maxPositionQuote, setMaxPositionQuote] = useState(DEFAULT_LIVE_RISK_LIMITS.maxPositionQuote);
  const [maxOrderQuote, setMaxOrderQuote] = useState(DEFAULT_LIVE_RISK_LIMITS.maxOrderQuote);
  const [maxDailyLossQuote, setMaxDailyLossQuote] = useState(DEFAULT_LIVE_RISK_LIMITS.maxDailyLossQuote);
  const [maxOpenOrders, setMaxOpenOrders] = useState(DEFAULT_LIVE_RISK_LIMITS.maxOpenOrders);
  const [bybitCrossCollateral, setBybitCrossCollateral] = useState(false);
  const [notifyMarkers, setNotifyMarkers] = useState(true);
  const [accounts, setAccounts] = useState<TradingAccountView[]>();
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsLoadFailed, setAccountsLoadFailed] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [paperAllocation, setPaperAllocation] = useState("10000.000000");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const strategy = runnable.find((item) => item.id === strategyId);
  const selectedExchange: ExchangeId = paperOnly ? "paper" : exchange;
  const databasePaperBinding = (paperPortfolioBindingRequired ?? !!ownerUserId) && selectedExchange === "paper";
  const liveAccountsAvailable = canReadAccounts && !paperOnly;
  const exchangeAccounts = useMemo(
    () => selectedExchange === "paper" ? [] : (accounts ?? []).filter((account) => account.exchange === selectedExchange),
    [accounts, selectedExchange]
  );
  const selectedLiveAccount = exchangeAccounts.find((account) => account.id === accountId && selectableLiveAccount(account));
  const paperBinding = usePaperBotBinding({
    ownerUserId,
    enabled: databasePaperBinding,
    loadPortfolios: loadPaperPortfolios,
    loadPortfolio: loadPaperPortfolio
  });
  const canonicalPaperAllocation = toCanonicalPositivePaperMoney(paperAllocation);
  const availablePaperCapital = paperBinding.detail?.snapshot.aggregates.availableCapital;
  const paperAllocationInsufficient = !!canonicalPaperAllocation && !!availablePaperCapital
    && comparePaperMoney(canonicalPaperAllocation, availablePaperCapital) > 0;
  const archivedPaperBinding = paperBinding.error?.message === "Selected paper portfolio is archived";
  const paperBindingReady = !databasePaperBinding || Boolean(
    !paperBinding.loading
    && !paperBinding.error
    && paperBinding.selectedPortfolioId
    && paperBinding.detail?.portfolio.status === "active"
    && canonicalPaperAllocation
    && !paperAllocationInsufficient
  );

  useEffect(() => {
    if (!liveAccountsAvailable) return;
    let active = true;
    setAccountsLoading(true);
    setAccountsLoadFailed(false);
    void loadAccounts()
      .then((next) => {
        if (!active) return;
        setAccounts(next);
      })
      .catch(() => {
        if (!active) return;
        setAccounts(undefined);
        setAccountsLoadFailed(true);
      })
      .finally(() => {
        if (active) setAccountsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [liveAccountsAvailable, loadAccounts]);

  const create = async () => {
    let durablePaperInput: DurablePaperBotInput | undefined;
    if (!strategy) {
      setError(tradingText(locale, "pickStrategy"));
      return;
    }
    const compiled = compileXmlToIr(strategy.xml);
    if (!compiled.ir || compiled.errors.length) {
      setError(compiled.errors[0] ?? tradingText(locale, "strategyErrors"));
      return;
    }
    const riskLimits = { maxPositionQuote, maxOrderQuote, maxDailyLossQuote, maxOpenOrders };
    if (selectedExchange === "binance" && market === "spot") {
      setError(tradingText(locale, "binanceSpotDisabled"));
      return;
    }
    if (selectedExchange !== "paper" && !validLiveRiskLimits(riskLimits)) {
      setError(tradingText(locale, "riskLimitsInvalid"));
      return;
    }
    if (selectedExchange !== "paper" && !selectedLiveAccount) {
      setError(tradingText(locale, "liveAccountInvalid"));
      return;
    }
    if (databasePaperBinding) {
      if (paperBinding.loading || paperBinding.error || !paperBinding.selectedPortfolioId || !paperBinding.detail) {
        setError(paperPortfolioText(locale, archivedPaperBinding ? "archivedPortfolioForbidden" : paperBinding.error ? "bindingLoadFailed" : "noActivePortfolioHint"));
        return;
      }
      if (paperBinding.detail.portfolio.status !== "active") {
        setError(paperPortfolioText(locale, "archivedPortfolioForbidden"));
        return;
      }
      if (!canonicalPaperAllocation) {
        setError(paperPortfolioText(locale, "invalidAllocation"));
        return;
      }
      if (paperAllocationInsufficient) {
        setError(paperPortfolioText(locale, "insufficientCapital"));
        return;
      }
      durablePaperInput = {
        paperPortfolioId: paperBinding.selectedPortfolioId,
        paperAllocation: canonicalPaperAllocation,
        expectedPortfolioRevision: paperBinding.detail.portfolio.revision,
        expectedLedgerEpoch: paperBinding.detail.snapshot.ledgerEpoch
      };
    }
    setBusy(true);
    setError(undefined);
    try {
      const input: SaveBotInput = {
        name: name.trim() || strategy.name,
        strategyName: strategy.name,
        ir: compiled.ir,
        symbol,
        timeframe,
        exchange: selectedExchange,
        market,
        sizeMode,
        sizeValue,
        leverage: market === "spot" ? 1 : leverage,
        bybitCrossCollateral: selectedExchange === "bybit" && market === "futures" && bybitCrossCollateral,
        notifyMarkers,
        ...(selectedLiveAccount ? { accountId: selectedLiveAccount.id } : {}),
        ...durablePaperInput,
        ...(selectedExchange === "paper" ? {} : riskLimits)
      };
      const bot = databasePaperBinding
        ? await saveTradingBot(input, { ownerUserId, idempotencyKey: createPaperIdempotencyKey() })
        : await saveTradingBot(input);
      onCreated(bot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tradingText(locale, "createFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="trade-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <div className="trade-form-title">
        <Bot size={16} aria-hidden="true" />
        <strong>{tradingText(locale, "newTradingBot")}</strong>
        <span>{tradingText(locale, paperOnly ? "runPaperOnly" : "runStrategy")}</span>
      </div>

      <fieldset className="form-section">
        <legend>{tradingText(locale, "strategy")}</legend>
        <label>{tradingText(locale, "fromStrategy")}
          <select name="strategy" value={strategyId} required onChange={(event) => setStrategyId(event.target.value)}>
            {runnable.length === 0 && <option value="">{tradingText(locale, "noStrategies")}</option>}
            {runnable.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>{tradingText(locale, "botName")}
          <input name="bot-name" value={name} placeholder={strategy?.name ?? tradingText(locale, "botFallbackName")} onChange={(event) => setName(event.target.value)} />
        </label>
      </fieldset>

      <fieldset className="form-section">
        <legend>{tradingText(locale, "market")}</legend>
        <div className="form-grid">
          <label>{tradingText(locale, "symbol")}
            <select name="symbol" value={symbol} onChange={(event) => setSymbol(event.target.value)}>
              {(catalog?.instruments ?? []).map((item) => <option key={item.symbol} value={item.symbol}>{item.symbol}</option>)}
            </select>
          </label>
          <label>{tradingText(locale, "interval")}
            <select name="timeframe" value={timeframe} onChange={(event) => setTimeframe(event.target.value as TradingBot["timeframe"])}>
              {(catalog?.timeframes ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
        </div>
        <p className="field-help">The bot evaluates the strategy on every closed {timeframe} candle — same signals as the backtest.</p>
      </fieldset>

      <fieldset className="form-section">
        <legend>{tradingText(locale, "execution")}</legend>
        <div className="form-grid">
          <label>{tradingText(locale, "exchange")}
            <select name="exchange" value={selectedExchange} onChange={(event) => {
              const next = event.target.value as ExchangeId;
              setExchange(next);
              setAccountId("");
              if (next === "binance" && market === "spot") setMarket("futures");
            }}>
              <option value="paper">{tradingText(locale, "paperSimulated")}</option>
              {liveAccountsAvailable && <option value="binance">Binance</option>}
              {liveAccountsAvailable && <option value="bybit">Bybit</option>}
            </select>
          </label>
          <label>{tradingText(locale, "marketType")}
            <select name="market" value={market} onChange={(event) => setMarket(event.target.value as "spot" | "futures")}>
              <option value="futures">{tradingText(locale, "futures")}</option><option value="spot" disabled={selectedExchange === "binance"}>{tradingText(locale, "spot")}</option>
            </select>
          </label>
        </div>
        {selectedExchange === "binance" && <p className="field-help">{tradingText(locale, "binanceSpotDisabled")}</p>}
        {selectedExchange === "paper" && databasePaperBinding ? (
          <section className="paper-bot-binding" aria-labelledby="paper-bot-binding-title">
            <div className="paper-bot-binding-head">
              <strong id="paper-bot-binding-title">{paperPortfolioText(locale, "bindingTitle")}</strong>
              <p>{paperPortfolioText(locale, "bindingHelp")}</p>
            </div>
            {paperBinding.loading && (
              <p className="paper-binding-status" role="status" aria-live="polite">{paperPortfolioText(locale, "bindingLoading")}</p>
            )}
            {!paperBinding.loading && paperBinding.error && (
              <div className="paper-binding-error" role="alert">
                <span>{paperPortfolioText(locale, archivedPaperBinding ? "archivedPortfolioForbidden" : "bindingLoadFailed")}</span>
                <button type="button" onClick={() => void paperBinding.refresh()}>{paperPortfolioText(locale, "refresh")}</button>
              </div>
            )}
            {!paperBinding.loading && !paperBinding.error && paperBinding.activePortfolios.length === 0 && (
              <div className="paper-binding-empty" role="note">
                <strong>{paperPortfolioText(locale, "noActivePortfolio")}</strong>
                <span>{paperPortfolioText(locale, "noActivePortfolioHint")}</span>
                {onOpenPortfolioCenter && (
                  <button type="button" onClick={onOpenPortfolioCenter}>{paperPortfolioText(locale, "openPortfolioCenter")}</button>
                )}
              </div>
            )}
            {!paperBinding.loading && !paperBinding.error && paperBinding.activePortfolios.length > 0 && (
              <div className="paper-binding-grid">
                <label>{paperPortfolioText(locale, "selectedPortfolio")}
                  <select
                    name="paper-portfolio-id"
                    value={paperBinding.selectedPortfolioId ?? ""}
                    required
                    disabled={paperBinding.loading}
                    onChange={(event) => paperBinding.selectPortfolio(event.target.value)}
                  >
                    {paperBinding.activePortfolios.map((portfolio) => (
                      <option key={portfolio.id} value={portfolio.id}>
                        {portfolio.name}{portfolio.isDefault ? ` · ${paperPortfolioText(locale, "defaultBadge")}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label>{paperPortfolioText(locale, "allocation")}
                  <input
                    name="paper-allocation"
                    type="text"
                    inputMode="decimal"
                    value={paperAllocation}
                    required
                    aria-invalid={!canonicalPaperAllocation || paperAllocationInsufficient}
                    aria-describedby="paper-allocation-help"
                    onChange={(event) => setPaperAllocation(event.target.value)}
                    onBlur={() => {
                      const canonical = toCanonicalPositivePaperMoney(paperAllocation);
                      if (canonical) setPaperAllocation(canonical);
                    }}
                  />
                </label>
                <p id="paper-allocation-help" className="field-help paper-binding-allocation-help">{paperPortfolioText(locale, "allocationHelp")}</p>
                {availablePaperCapital && (
                  <p className="paper-binding-available">
                    <span>{paperPortfolioText(locale, "availableCapital")}</span>
                    <strong>{availablePaperCapital} USDT</strong>
                  </p>
                )}
                {!canonicalPaperAllocation && <p className="paper-binding-validation" role="alert">{paperPortfolioText(locale, "invalidAllocation")}</p>}
                {canonicalPaperAllocation && paperAllocationInsufficient && <p className="paper-binding-validation" role="alert">{paperPortfolioText(locale, "insufficientCapital")}</p>}
              </div>
            )}
          </section>
        ) : selectedExchange === "paper" ? (
          <p className="field-help" role="note">{tradingText(locale, "paperAccountHelp")}</p>
        ) : liveAccountsAvailable ? (
          <>
            <label>{tradingText(locale, "liveAccount")}
              <select
                name="account-id"
                value={accountId}
                required
                aria-describedby="live-account-help"
                disabled={accountsLoading}
                onChange={(event) => setAccountId(event.target.value)}
              >
                <option value="">{tradingText(locale, "liveAccountServerDefault")}</option>
                {exchangeAccounts.map((account) => (
                  <option key={account.id} value={account.id} disabled={!selectableLiveAccount(account)}>
                    {account.label} · {tradingText(locale, account.ownership === "own" ? "accountOwn" : "accountManaged")} · {tradingText(locale, accountStatusKey(account))}
                  </option>
                ))}
              </select>
            </label>
            <p id="live-account-help" className="field-help">{tradingText(locale, "liveAccountSharedHelp")}</p>
            {accountsLoading && <p className="field-help" role="status" aria-live="polite">{tradingText(locale, "liveAccountLoading")}</p>}
            {accountsLoadFailed && <p className="field-help" role="alert">{tradingText(locale, "liveAccountLoadFailed")}</p>}
            {!accountsLoading && !accountsLoadFailed && accounts && exchangeAccounts.length === 0 && (
              <p className="field-help" role="note">{tradingText(locale, "liveAccountNone")}</p>
            )}
          </>
        ) : (
          <p className="field-help" role="note">{tradingText(locale, "liveAccountAdminFallback")}</p>
        )}
        <div className="form-grid">
          <label>{tradingText(locale, "sizing")}
            <select name="size-mode" value={sizeMode} onChange={(event) => setSizeMode(event.target.value as TradingBot["sizeMode"])}>
              <option value="quote">{tradingText(locale, "quoteUsdt")}</option><option value="base">{tradingText(locale, "baseUnits")}</option><option value="equity_pct">{tradingText(locale, "equityPercent")}</option><option value="risk_pct">{tradingText(locale, "riskPercent")}</option>
            </select>
          </label>
          <label>{tradingText(locale, "amount")}
            <input name="amount" type="number" value={sizeValue} min={0.00000001} step="any" required onChange={(event) => setSizeValue(event.target.valueAsNumber || 0)} />
          </label>
          <label>{tradingText(locale, "leverage")}
            <input name="leverage" type="number" value={market === "spot" ? 1 : leverage} min={1} max={125} step={1} required disabled={market === "spot"} onChange={(event) => setLeverage(event.target.valueAsNumber || 1)} />
          </label>
        </div>
        <label className="check-row">
          <input name="notify-markers" type="checkbox" checked={notifyMarkers} onChange={(event) => setNotifyMarkers(event.target.checked)} />
          {tradingText(locale, "notifyMarkers")}
        </label>
        {selectedExchange === "bybit" && market === "futures" && (
          <div className="uta-opt-in">
            <label className="check-row">
              <input name="bybit-cross-collateral" type="checkbox" checked={bybitCrossCollateral} onChange={(event) => setBybitCrossCollateral(event.target.checked)} />
              {tradingText(locale, "bybitCrossCollateral")}
            </label>
            <p className="field-help">{tradingText(locale, "bybitCrossCollateralHelp")}</p>
          </div>
        )}
      </fieldset>

      {selectedExchange !== "paper" && (
        <fieldset className="form-section live-risk-limits" aria-describedby="live-risk-limits-help">
          <legend>{tradingText(locale, "liveRiskLimits")}</legend>
          <p id="live-risk-limits-help" className="field-help">{tradingText(locale, "liveRiskLimitsHelp")}</p>
          <div className="form-grid">
            <label>{tradingText(locale, "maxPositionQuote")}
              <input name="max-position-quote" type="number" value={maxPositionQuote} min={0.01} max={1_000_000_000} step={0.01} required onChange={(event) => setMaxPositionQuote(event.target.valueAsNumber || 0)} />
            </label>
            <label>{tradingText(locale, "maxOrderQuote")}
              <input name="max-order-quote" type="number" value={maxOrderQuote} min={0.01} max={maxPositionQuote || 0.01} step={0.01} required onChange={(event) => setMaxOrderQuote(event.target.valueAsNumber || 0)} />
            </label>
            <label>{tradingText(locale, "maxDailyLossQuote")}
              <input name="max-daily-loss-quote" type="number" value={maxDailyLossQuote} min={0.01} max={1_000_000_000} step={0.01} required onChange={(event) => setMaxDailyLossQuote(event.target.valueAsNumber || 0)} />
            </label>
            <label>{tradingText(locale, "maxOpenOrders")}
              <input name="max-open-orders" type="number" value={maxOpenOrders} min={1} max={10_000} step={1} required onChange={(event) => setMaxOpenOrders(event.target.valueAsNumber || 0)} />
            </label>
          </div>
        </fieldset>
      )}

      {selectedExchange !== "paper" && <div className="trade-warn"><AlertTriangle size={13} aria-hidden="true" /> {tradingText(locale, "realTradingWarning")}</div>}
      {error && <div className="strategy-warnings" role="alert"><span><AlertTriangle size={12} aria-hidden="true" /> {error}</span></div>}
      <button type="submit" className="run-button form-submit" disabled={busy || !paperBindingReady}>{tradingText(locale, busy ? "creating" : "createBot")}</button>
    </form>
  );
}

function selectableLiveAccount(account: TradingAccountView): boolean {
  return account.enabled
    && account.credential.mode === "account_isolated"
    && account.status === "ready"
    && account.capabilities.liveExecution;
}

function accountStatusKey(account: TradingAccountView): "accountReady" | "accountCredentialsMissing" | "accountDisabled" {
  if (account.status === "ready") return "accountReady";
  if (account.status === "credentials_missing") return "accountCredentialsMissing";
  return "accountDisabled";
}
