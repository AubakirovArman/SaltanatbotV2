import { AlertTriangle, Pause, Play, Square, X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { dcaText } from "../../../i18n/dca";
import { paperPortfolioText, paperRobotActionText, paperRobotStatusText } from "../../../i18n/paperPortfolio";
import { localeTag, type Locale } from "../../../i18n";
import { formatPaperMoney as formatMoney } from "../../paperPortfolioFormat";
import type {
  EvidenceValue,
  PaperMoney,
  PaperRobotAction,
  PaperRobotControlStatus,
  PaperRobotProjection,
  PaperRobotRuntimeMetadata
} from "../../paperPortfolioTypes";
import { PaperRobotDcaSection } from "./PaperRobotDcaSection";
import { PaperRobotJournalView } from "./PaperRobotJournalView";

export interface PaperRobotRow {
  robot: PaperRobotProjection;
  metadata?: PaperRobotRuntimeMetadata;
  name: string;
  strategy?: string;
  symbol?: string;
  status?: PaperRobotControlStatus;
}

export function buildPaperRobotRows(robots: PaperRobotProjection[], metadata: PaperRobotRuntimeMetadata[]): PaperRobotRow[] {
  return robots.map((robot) => {
    const runtime = metadata.find((item) => item.botId === robot.botId);
    return {
      robot,
      metadata: runtime,
      name: runtime?.name ?? robot.botId,
      strategy: runtime?.strategyName,
      symbol: runtime?.symbol ?? robot.positions[0]?.symbol ?? robot.openOrders[0]?.symbol,
      status: runtime?.status
    };
  });
}

export function PaperRobotViews({
  rows,
  locale,
  busy,
  actionsEnabled,
  onOpen,
  onAction
}: {
  rows: PaperRobotRow[];
  locale: Locale;
  busy: boolean;
  actionsEnabled: boolean;
  onOpen: (row: PaperRobotRow, trigger: HTMLElement) => void;
  onAction: (row: PaperRobotRow, action: PaperRobotAction, trigger: HTMLElement) => void;
}) {
  return (
    <>
      <div className="paper-robot-table-wrap">
        <table className="paper-robot-table">
          <caption>{paperPortfolioText(locale, "robots")}</caption>
          <thead><tr>
            <th scope="col">{paperPortfolioText(locale, "robot")}</th>
            <th scope="col">{paperPortfolioText(locale, "status")}</th>
            <th scope="col">{paperPortfolioText(locale, "allocation")}</th>
            <th scope="col">{paperPortfolioText(locale, "equity")}</th>
            <th scope="col">{paperPortfolioText(locale, "realizedPnl")}</th>
            <th scope="col">{paperPortfolioText(locale, "positions")}</th>
            <th scope="col">{paperPortfolioText(locale, "orders")}</th>
            <th scope="col">{paperPortfolioText(locale, "margin")} / {paperPortfolioText(locale, "borrowing")}</th>
            <th scope="col"><span className="sr-only">{paperPortfolioText(locale, "portfolioActions")}</span></th>
          </tr></thead>
          <tbody>{rows.map((row) => (
            <tr key={row.robot.botId}>
              <th scope="row">
                <button type="button" className="paper-robot-open" onClick={(event) => onOpen(row, event.currentTarget)}>
                  <strong>{row.name}{row.metadata?.dca && <span className="ex-badge dca">{dcaText(locale, "typeBadge")}</span>}</strong><small>{row.symbol ?? paperPortfolioText(locale, "unavailable")}</small>
                </button>
              </th>
              <td><RobotStatus status={row.status} locale={locale} /></td>
              <td>{formatMoney(row.robot.allocation, locale)}</td>
              <td><EvidenceMoney value={row.robot.metrics.equity} locale={locale} compact /></td>
              <td>{formatMoney(row.robot.metrics.realizedNetCashPnl, locale)}</td>
              <td>{row.robot.positions.length}</td>
              <td>{row.robot.openOrders.length}</td>
              <td><MarginBorrowing row={row} locale={locale} /></td>
              <td><RobotActions row={row} locale={locale} busy={busy} enabled={actionsEnabled} onAction={onAction} compact /></td>
            </tr>
          ))}</tbody>
        </table>
      </div>

      <ul className="paper-robot-cards" aria-label={paperPortfolioText(locale, "robots")}>
        {rows.map((row) => (
          <li key={row.robot.botId}>
            <article className="paper-robot-card">
              <button type="button" className="paper-robot-card-open" onClick={(event) => onOpen(row, event.currentTarget)}>
                <span><strong>{row.name}{row.metadata?.dca && <span className="ex-badge dca">{dcaText(locale, "typeBadge")}</span>}</strong><small>{row.strategy ?? row.symbol ?? paperPortfolioText(locale, "unavailable")}</small></span>
                <RobotStatus status={row.status} locale={locale} />
              </button>
              <dl>
                <CardMetric label={paperPortfolioText(locale, "equity")} value={<EvidenceMoney value={row.robot.metrics.equity} locale={locale} compact />} />
                <CardMetric label={paperPortfolioText(locale, "realizedPnl")} value={formatMoney(row.robot.metrics.realizedNetCashPnl, locale)} />
                <CardMetric label={paperPortfolioText(locale, "positions")} value={String(row.robot.positions.length)} />
                <CardMetric label={paperPortfolioText(locale, "orders")} value={String(row.robot.openOrders.length)} />
                <CardMetric label={`${paperPortfolioText(locale, "margin")} / ${paperPortfolioText(locale, "borrowing")}`} value={<MarginBorrowing row={row} locale={locale} />} />
              </dl>
              <RobotActions row={row} locale={locale} busy={busy} enabled={actionsEnabled} onAction={onAction} />
            </article>
          </li>
        ))}
      </ul>
    </>
  );
}

export function PaperRobotDetailDrawer({
  row,
  locale,
  busy,
  actionsEnabled,
  snapshotStale = false,
  portfolioLastError,
  returnFocus,
  onClose,
  onAction
}: {
  row: PaperRobotRow;
  locale: Locale;
  busy: boolean;
  actionsEnabled: boolean;
  snapshotStale?: boolean;
  portfolioLastError?: string;
  returnFocus?: HTMLElement | null;
  onClose: () => void;
  onAction: (row: PaperRobotRow, action: PaperRobotAction, trigger: HTMLElement) => void;
}) {
  const headingId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const capturedFocus = useRef(returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const lastError = row.metadata?.lastError ?? portfolioLastError;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab" && drawerRef.current) trapDrawerFocus(event, drawerRef.current);
    };
    document.addEventListener("keydown", keydown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", keydown);
      window.requestAnimationFrame(() => capturedFocus.current?.focus());
    };
  }, [onClose]);

  return (
    <div className="paper-detail-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside ref={drawerRef} className="paper-detail-drawer" role="dialog" aria-modal="true" aria-labelledby={headingId}>
        <header>
          <div><h3 id={headingId}>{row.name}</h3><p>{row.strategy ?? row.symbol ?? row.robot.botId}</p></div>
          <button ref={closeRef} type="button" className="paper-close-button" onClick={onClose} aria-label={paperPortfolioText(locale, "closeDetails")}><X aria-hidden="true" /></button>
        </header>
        <div className="paper-detail-scroll">
          <RobotStatus status={row.status} locale={locale} />
          {snapshotStale && <p className="paper-journal-evidence stale" role="status"><strong>{paperPortfolioText(locale, "stale")}</strong><span>{paperPortfolioText(locale, "staleSnapshot")}</span></p>}
          {lastError && <p className="paper-last-error" role="alert"><AlertTriangle aria-hidden="true" /> <span><strong>{paperPortfolioText(locale, "lastError")}</strong>{lastError}</span></p>}
          <dl className="paper-detail-metrics">
            <CardMetric label={paperPortfolioText(locale, "allocation")} value={formatMoney(row.robot.allocation, locale)} />
            <CardMetric label={paperPortfolioText(locale, "equity")} value={<EvidenceMoney value={row.robot.metrics.equity} locale={locale} />} />
            <CardMetric label={paperPortfolioText(locale, "realizedPnl")} value={formatMoney(row.robot.metrics.realizedNetCashPnl, locale)} />
            <CardMetric label={paperPortfolioText(locale, "unrealizedPnl")} value={<EvidenceMoney value={row.robot.metrics.unrealizedPnl} locale={locale} />} />
            <CardMetric label={paperPortfolioText(locale, "margin")} value={<EvidenceMoney value={row.robot.metrics.margin} locale={locale} />} />
            <CardMetric label={paperPortfolioText(locale, "borrowing")} value={<EvidenceMoney value={row.robot.metrics.borrowing} locale={locale} />} />
            <CardMetric label={paperPortfolioText(locale, "epoch")} value={String(row.robot.ledgerEpoch)} />
            <CardMetric label={paperPortfolioText(locale, "evidence")} value={String(row.robot.ledger.eventCount)} />
          </dl>
          <EvidenceNotice label={paperPortfolioText(locale, "margin")} value={row.robot.metrics.margin} locale={locale} />
          <EvidenceNotice label={paperPortfolioText(locale, "borrowing")} value={row.robot.metrics.borrowing} locale={locale} />
          {row.metadata?.dca && <PaperRobotDcaSection dca={row.metadata.dca} locale={locale} />}
          {row.metadata?.journal && <PaperRobotJournalView robot={row.robot} journal={row.metadata.journal} locale={locale} />}
          <section className="paper-detail-section">
            <h4>{paperPortfolioText(locale, "positions")} · {row.robot.positions.length}</h4>
            {row.robot.positions.length > 0 && <ul>{row.robot.positions.map((position) => <li key={`${position.symbol}:${position.openedAt}`}><strong>{position.symbol}</strong><span>{position.side} · {position.qty}</span><EvidenceMoney value={position.unrealizedPnl} locale={locale} compact /></li>)}</ul>}
          </section>
          <section className="paper-detail-section">
            <h4>{paperPortfolioText(locale, "orders")} · {row.robot.openOrders.length}</h4>
            {row.robot.openOrders.length > 0 && <ul>{row.robot.openOrders.map((order) => <li key={order.id}><strong>{order.symbol}</strong><span>{order.side} · {order.type}</span><span>{order.qty}</span></li>)}</ul>}
          </section>
          <RobotActions row={row} locale={locale} busy={busy} enabled={actionsEnabled} onAction={onAction} />
        </div>
      </aside>
    </div>
  );
}

export function EvidenceMoney({ value, locale, compact = false }: { value: EvidenceValue<PaperMoney>; locale: Locale; compact?: boolean }) {
  if (value.status === "unavailable") return <span className="paper-evidence unavailable" title={value.reason}>{paperPortfolioText(locale, "unavailable")}</span>;
  const money = value.status === "available" ? value.value : value.lastValue;
  return <span className={`paper-evidence ${value.status}`} title={value.status === "stale" ? value.reason : `${value.source} · ${new Date(value.observedAt).toLocaleString(localeTag(locale))}`}>
    {formatMoney(money, locale, compact)}{value.status === "stale" && <small>{paperPortfolioText(locale, "stale")}</small>}
  </span>;
}

function EvidenceNotice({ label, value, locale }: { label: string; value: EvidenceValue<PaperMoney>; locale: Locale }) {
  if (value.status !== "unavailable") return null;
  return <p className="paper-evidence-notice"><strong>{label}: {paperPortfolioText(locale, "unavailable")}</strong><span>{value.reason || paperPortfolioText(locale, "unavailableEvidence")}</span></p>;
}

function RobotStatus({ status, locale }: { status?: PaperRobotControlStatus; locale: Locale }) {
  return <span className={`paper-robot-status ${status ?? "unavailable"}`}><i aria-hidden="true" />{status ? paperRobotStatusText(locale, status) : paperPortfolioText(locale, "unavailable")}</span>;
}

function MarginBorrowing({ row, locale }: { row: PaperRobotRow; locale: Locale }) {
  return <span className="paper-margin-borrow"><EvidenceMoney value={row.robot.metrics.margin} locale={locale} compact /><span aria-hidden="true">/</span><EvidenceMoney value={row.robot.metrics.borrowing} locale={locale} compact /></span>;
}

function RobotActions({ row, locale, busy, enabled, onAction, compact = false }: {
  row: PaperRobotRow;
  locale: Locale;
  busy: boolean;
  enabled: boolean;
  onAction: (row: PaperRobotRow, action: PaperRobotAction, trigger: HTMLElement) => void;
  compact?: boolean;
}) {
  const actions = enabled && row.robot.allocationStatus === "active" ? availableActions(row.status) : [];
  if (actions.length === 0) return null;
  return <div className={`paper-robot-actions ${compact ? "compact" : ""}`}>{actions.map((action) => (
    <button key={action} type="button" disabled={busy} onClick={(event) => onAction(row, action, event.currentTarget)} title={paperRobotActionText(locale, action)}>
      {actionIcon(action)}<span>{paperRobotActionText(locale, action)}</span>
    </button>
  ))}</div>;
}

function CardMetric({ label, value }: { label: string; value: ReactNode }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function availableActions(status?: PaperRobotControlStatus): PaperRobotAction[] {
  if (status === "running") return ["pause", "stop"];
  if (status === "paused") return ["resume", "stop"];
  if (status === "idle" || status === "stopped") return ["start"];
  if (status === "error") return ["stop"];
  return [];
}

function actionIcon(action: PaperRobotAction) {
  if (action === "pause") return <Pause size={15} aria-hidden="true" />;
  if (action === "stop") return <Square size={15} aria-hidden="true" />;
  return <Play size={15} aria-hidden="true" />;
}

function trapDrawerFocus(event: KeyboardEvent, panel: HTMLElement): void {
  const focusable = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')];
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export { formatPaperMoney as formatMoney } from "../../paperPortfolioFormat";
