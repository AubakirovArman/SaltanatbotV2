import { ChevronDown } from "lucide-react";
import { useId, type ReactNode } from "react";
import { localeTag, type Locale } from "../../../i18n";
import { paperLedgerEventText, paperPortfolioText } from "../../../i18n/paperPortfolio";
import { formatPaperMoney } from "../../paperPortfolioFormat";
import type {
  EvidenceValue,
  PaperMoney,
  PaperRealizedCashCurvePoint,
  PaperRobotJournal,
  PaperRobotProjection
} from "../../paperPortfolioTypes";

export function PaperRobotJournalView({
  robot,
  journal,
  locale
}: {
  robot: PaperRobotProjection;
  journal: PaperRobotJournal;
  locale: Locale;
}) {
  return (
    <div className="paper-journal-stack">
      <PaperCashCurve robot={robot} journal={journal} locale={locale} />
      <AnalyticsDisclosure robot={robot} locale={locale} />
      <FillsDisclosure journal={journal} locale={locale} />
      <EventsDisclosure journal={journal} locale={locale} />
    </div>
  );
}

export function PaperCashCurve({
  robot,
  journal,
  locale
}: {
  robot: PaperRobotProjection;
  journal: PaperRobotJournal;
  locale: Locale;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const cashPoints = journal.curve.points.filter((point) => point.basis === "cash-realized");
  const equityPoint = journal.curve.points.find((point) => point.basis === "current-equity");
  const geometry = curveGeometry(cashPoints, equityPoint?.equity);
  const first = cashPoints[0]!;
  const latest = cashPoints.at(-1)!;
  const accessibleSummary = `${paperPortfolioText(locale, "cashPoints")}: ${journal.curve.sourceCashPointCount}. ${paperPortfolioText(locale, "firstCash")}: ${formatPaperMoney(first.cashBalance, locale)}. ${paperPortfolioText(locale, "latestCash")}: ${formatPaperMoney(latest.cashBalance, locale)}.${equityPoint ? ` ${paperPortfolioText(locale, "currentEquityPoint")}: ${formatPaperMoney(equityPoint.equity, locale)}.` : ""}`;

  return (
    <section className="paper-journal-card paper-curve-card" aria-labelledby={`${titleId}-visible`}>
      <header>
        <h4 id={`${titleId}-visible`}>{paperPortfolioText(locale, "cashCurve")}</h4>
        <span>{journal.curve.sourceCashPointCount}</span>
      </header>
      <figure>
        <svg
          className="paper-cash-curve"
          viewBox="0 0 320 116"
          role="img"
          aria-labelledby={`${titleId} ${descriptionId}`}
        >
          <title id={titleId}>{paperPortfolioText(locale, "cashCurve")}</title>
          <desc id={descriptionId}>{accessibleSummary} {paperPortfolioText(locale, "cashCurveHint")}</desc>
          <g className="paper-curve-grid" aria-hidden="true">
            <line x1="10" y1="12" x2="310" y2="12" />
            <line x1="10" y1="58" x2="310" y2="58" />
            <line x1="10" y1="104" x2="310" y2="104" />
          </g>
          {geometry.cashPolyline && <polyline className="paper-curve-cash-line" points={geometry.cashPolyline} vectorEffect="non-scaling-stroke" />}
          {geometry.cashCoordinates.length === 1 && (
            <circle className="paper-curve-cash-dot" cx={geometry.cashCoordinates[0]!.x} cy={geometry.cashCoordinates[0]!.y} r="3" vectorEffect="non-scaling-stroke" />
          )}
          {geometry.equityCoordinate && (
            <g className="paper-curve-current" aria-hidden="true">
              <line x1={geometry.equityCoordinate.x} y1="12" x2={geometry.equityCoordinate.x} y2="104" vectorEffect="non-scaling-stroke" />
              <circle cx={geometry.equityCoordinate.x} cy={geometry.equityCoordinate.y} r="4" vectorEffect="non-scaling-stroke" />
            </g>
          )}
        </svg>
        <figcaption>
          <p>{paperPortfolioText(locale, "cashCurveHint")}</p>
          <dl className="paper-curve-range">
            <Metric label={paperPortfolioText(locale, "firstCash")} value={formatPaperMoney(first.cashBalance, locale, true)} />
            <Metric label={paperPortfolioText(locale, "latestCash")} value={formatPaperMoney(latest.cashBalance, locale, true)} />
            {equityPoint && <Metric label={paperPortfolioText(locale, "currentEquityPoint")} value={formatPaperMoney(equityPoint.equity, locale, true)} />}
          </dl>
          {journal.curve.truncated && <p className="paper-journal-bound" role="note">{paperPortfolioText(locale, "boundedHistory")}</p>}
          {robot.metrics.equity.status === "stale" && (
            <p className="paper-journal-evidence stale" role="note">
              <strong>{paperPortfolioText(locale, "stale")}: {formatPaperMoney(robot.metrics.equity.lastValue, locale, true)}</strong>
              <span>{paperPortfolioText(locale, "currentEquityStale")} {robot.metrics.equity.reason}</span>
            </p>
          )}
          {robot.metrics.equity.status === "unavailable" && (
            <p className="paper-journal-evidence unavailable" role="note">
              <strong>{paperPortfolioText(locale, "unavailable")}</strong>
              <span>{paperPortfolioText(locale, "currentEquityMissing")} {robot.metrics.equity.reason}</span>
            </p>
          )}
        </figcaption>
      </figure>
    </section>
  );
}

function AnalyticsDisclosure({ robot, locale }: { robot: PaperRobotProjection; locale: Locale }) {
  const metrics = robot.metrics;
  const statistics = metrics.tradeStatistics;
  return (
    <details className="paper-journal-disclosure">
      <summary><span>{paperPortfolioText(locale, "analytics")}</span><span aria-hidden="true">14</span><ChevronDown aria-hidden="true" /></summary>
      <div className="paper-journal-body">
        <dl className="paper-analytics-grid">
          <Metric label={paperPortfolioText(locale, "cashBalance")} value={formatPaperMoney(metrics.cashBalance, locale, true)} />
          <Metric label={paperPortfolioText(locale, "feesPaid")} value={formatPaperMoney(metrics.feesPaid, locale, true)} />
          <Metric label={paperPortfolioText(locale, "fundingNet")} value={formatPaperMoney(metrics.fundingNet, locale, true)} />
          <Metric label={paperPortfolioText(locale, "exposure")} value={<EvidenceMoney value={metrics.grossExposure} locale={locale} />} />
          <Metric label={paperPortfolioText(locale, "netExposure")} value={<EvidenceMoney value={metrics.netExposure} locale={locale} />} />
          <Metric label={paperPortfolioText(locale, "committedCapital")} value={<EvidenceMoney value={metrics.committedCapital} locale={locale} />} />
          <Metric label={paperPortfolioText(locale, "margin")} value={<EvidenceMoney value={metrics.margin} locale={locale} />} />
          <Metric label={paperPortfolioText(locale, "borrowing")} value={<EvidenceMoney value={metrics.borrowing} locale={locale} />} />
          <Metric label={paperPortfolioText(locale, "closedTrades")} value={statistics.closedTrades.toLocaleString(localeTag(locale))} />
          <Metric label={paperPortfolioText(locale, "winRate")} value={<EvidenceNumber value={statistics.winRate} locale={locale} percent />} />
          <Metric label={paperPortfolioText(locale, "profitFactor")} value={<EvidenceNumber value={statistics.profitFactor} locale={locale} />} />
          <Metric label={paperPortfolioText(locale, "expectancy")} value={<EvidenceMoney value={statistics.expectancy} locale={locale} />} />
          <Metric label={paperPortfolioText(locale, "grossProfit")} value={formatPaperMoney(statistics.grossProfit, locale, true)} />
          <Metric label={paperPortfolioText(locale, "grossLoss")} value={formatPaperMoney(statistics.grossLoss, locale, true)} />
        </dl>
      </div>
    </details>
  );
}

function FillsDisclosure({ journal, locale }: { journal: PaperRobotJournal; locale: Locale }) {
  const items = journal.recentFills.items;
  return (
    <details className="paper-journal-disclosure">
      <summary><span>{paperPortfolioText(locale, "recentFills")}</span><span>{items.length}</span><ChevronDown aria-hidden="true" /></summary>
      <div className="paper-journal-body">
        {journal.recentFills.truncated && <p className="paper-journal-bound" role="note">{paperPortfolioText(locale, "truncatedWindow")}</p>}
        {items.length === 0 ? <p className="paper-journal-empty">{paperPortfolioText(locale, "noRecentFills")}</p> : (
          <ul className="paper-fill-list" aria-label={paperPortfolioText(locale, "recentFills")}>
            {items.map((fill) => (
              <li key={`${fill.sequence}:${fill.fillId}`}>
                <header>
                  <span><strong>{fill.symbol}</strong><small>{paperPortfolioText(locale, fill.side)} · {paperPortfolioText(locale, fill.kind === "open" ? "openFill" : "closeFill")}</small></span>
                  <MoneyTone value={fill.realizedPnl} locale={locale} />
                </header>
                <dl>
                  <Metric label={paperPortfolioText(locale, "sequence")} value={`#${fill.sequence}`} />
                  <Metric label={paperPortfolioText(locale, "quantity")} value={fill.qty.toLocaleString(localeTag(locale), { maximumFractionDigits: 8 })} />
                  <Metric label={paperPortfolioText(locale, "price")} value={formatPaperMoney(fill.price, locale, true)} />
                  <Metric label={paperPortfolioText(locale, "fee")} value={`${formatPaperMoney(fill.fee, locale, true)} ${fill.feeAsset ?? "USDT"}`} />
                </dl>
                <time dateTime={new Date(fill.ts).toISOString()}>{new Date(fill.ts).toLocaleString(localeTag(locale))}</time>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

function EventsDisclosure({ journal, locale }: { journal: PaperRobotJournal; locale: Locale }) {
  const items = journal.recentEvents.items;
  return (
    <details className="paper-journal-disclosure">
      <summary><span>{paperPortfolioText(locale, "recentEvents")}</span><span>{items.length}</span><ChevronDown aria-hidden="true" /></summary>
      <div className="paper-journal-body">
        {journal.recentEvents.truncated && <p className="paper-journal-bound" role="note">{paperPortfolioText(locale, "truncatedWindow")}</p>}
        {items.length === 0 ? <p className="paper-journal-empty">{paperPortfolioText(locale, "noRecentEvents")}</p> : (
          <ol className="paper-event-list" aria-label={paperPortfolioText(locale, "recentEvents")}>
            {items.map((event) => (
              <li key={`${event.sequence}:${event.eventId}`}>
                <span>
                  <strong>#{event.sequence}</strong>
                  <code data-event-type={event.type} title={event.type}>{paperLedgerEventText(locale, event.type)}</code>
                </span>
                <time dateTime={new Date(event.ts).toISOString()}>{new Date(event.ts).toLocaleString(localeTag(locale))}</time>
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function EvidenceMoney({ value, locale }: { value: EvidenceValue<PaperMoney>; locale: Locale }) {
  return <EvidenceValueView value={value} locale={locale} format={(money) => formatPaperMoney(money, locale, true)} />;
}

function EvidenceNumber({ value, locale, percent = false }: { value: EvidenceValue<number>; locale: Locale; percent?: boolean }) {
  const format = (number: number) => `${(percent ? number * 100 : number).toLocaleString(localeTag(locale), { maximumFractionDigits: 2 })}${percent ? "%" : ""}`;
  return <EvidenceValueView value={value} locale={locale} format={format} />;
}

function EvidenceValueView<T>({ value, locale, format }: { value: EvidenceValue<T>; locale: Locale; format: (value: T) => string }) {
  if (value.status === "unavailable") {
    return <span className="paper-analytics-evidence unavailable"><strong>{paperPortfolioText(locale, "unavailable")}</strong><small>{value.reason}</small></span>;
  }
  const displayed = value.status === "available" ? value.value : value.lastValue;
  return (
    <span className={`paper-analytics-evidence ${value.status}`}>
      <strong>{format(displayed)}{value.status === "stale" ? ` · ${paperPortfolioText(locale, "stale")}` : ""}</strong>
      {value.status === "stale" && <small>{value.reason}</small>}
    </span>
  );
}

function MoneyTone({ value, locale }: { value: PaperMoney; locale: Locale }) {
  const tone = value.startsWith("-") ? "down" : /^0\.0{6}$/.test(value) ? "" : "up";
  const formatted = formatPaperMoney(value, locale, true);
  return <strong className={`paper-fill-pnl ${tone}`} aria-label={`${paperPortfolioText(locale, "realizedPnl")}: ${formatted}`}>{formatted}</strong>;
}

function curveGeometry(cashPoints: PaperRealizedCashCurvePoint[], currentEquity?: PaperMoney): {
  cashCoordinates: Array<{ x: number; y: number }>;
  cashPolyline?: string;
  equityCoordinate?: { x: number; y: number };
} {
  const cashValues = cashPoints.map((point) => Number(point.cashBalance));
  const equityValue = currentEquity === undefined ? undefined : Number(currentEquity);
  const values = equityValue === undefined ? cashValues : [...cashValues, equityValue];
  const rawMinimum = Math.min(...values);
  const rawMaximum = Math.max(...values);
  const padding = Math.max((rawMaximum - rawMinimum) * 0.08, Math.abs(rawMaximum || 1) * 0.002, 0.000001);
  const minimum = rawMinimum - padding;
  const maximum = rawMaximum + padding;
  const y = (value: number) => 12 + (maximum - value) / (maximum - minimum) * 92;
  const cashCoordinates = cashPoints.map((point, index) => ({
    x: cashPoints.length === 1 ? (equityValue === undefined ? 160 : 10) : 10 + index / (cashPoints.length - 1) * 300,
    y: y(Number(point.cashBalance))
  }));
  return {
    cashCoordinates,
    cashPolyline: cashCoordinates.length > 1 ? cashCoordinates.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ") : undefined,
    equityCoordinate: equityValue === undefined ? undefined : { x: 310, y: y(equityValue) }
  };
}
