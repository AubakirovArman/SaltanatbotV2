import { Archive, ChevronDown, Plus, RefreshCw, RotateCcw, Settings2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { MOBILE_SHELL_MEDIA_QUERY, useMediaQuery } from "../../../hooks/useMediaQuery";
import { paperPortfolioText, paperRobotStatusText } from "../../../i18n/paperPortfolio";
import { localeTag, type Locale } from "../../../i18n";
import type { PaperPortfolioCenterClient } from "../../usePaperPortfolioCenter";
import { usePaperPortfolioCenter } from "../../usePaperPortfolioCenter";
import type { PaperPortfolioAggregates, PaperRobotAction } from "../../paperPortfolioTypes";
import { createPaperIdempotencyKey, PaperPortfolioApiError, setPaperMultiLegKillSwitch } from "../../paperPortfolioClient";
import { PaperMultiLegIntentsSection } from "./PaperMultiLegIntentsSection";
import { PortfolioLifecycleDialog, RobotActionDialog, type PortfolioDialogKind } from "./PaperPortfolioDialogs";
import {
  buildPaperRobotRows,
  EvidenceMoney,
  formatMoney,
  PaperRobotDetailDrawer,
  PaperRobotViews,
  type PaperRobotRow
} from "./PaperRobotViews";

export function PaperPortfolioCenter({
  ownerUserId,
  locale,
  canMutate,
  onNewRobot,
  client,
  refreshIntervalMs
}: {
  ownerUserId: string;
  locale: Locale;
  canMutate: boolean;
  onNewRobot: () => void;
  client?: PaperPortfolioCenterClient;
  refreshIntervalMs?: number;
}) {
  const center = usePaperPortfolioCenter({ ownerUserId, client, refreshIntervalMs });
  const mobile = useMediaQuery(MOBILE_SHELL_MEDIA_QUERY);
  const [summaryOpen, setSummaryOpen] = useState(!mobile);
  const [statusFilter, setStatusFilter] = useState("all");
  const [symbolFilter, setSymbolFilter] = useState("all");
  const [dialog, setDialog] = useState<PortfolioDialogKind>();
  const [dialogTrigger, setDialogTrigger] = useState<HTMLElement | null>(null);
  const [selectedRobotId, setSelectedRobotId] = useState<string>();
  const [detailTrigger, setDetailTrigger] = useState<HTMLElement | null>(null);
  const [pendingAction, setPendingAction] = useState<{ botId: string; action: PaperRobotAction; trigger: HTMLElement }>();

  useEffect(() => setSummaryOpen(!mobile), [mobile]);
  useEffect(() => {
    setStatusFilter("all");
    setSymbolFilter("all");
    setSelectedRobotId(undefined);
  }, [center.selectedPortfolioId]);

  const rows = useMemo(() => center.detail ? buildPaperRobotRows(center.detail.snapshot.robots, center.detail.robots) : [], [center.detail]);
  const symbols = useMemo(() => [...new Set(rows.map((row) => row.symbol).filter((value): value is string => !!value))].sort(), [rows]);
  const filteredRows = useMemo(() => rows.filter((row) => {
    const status = row.status ?? "unavailable";
    return (statusFilter === "all" || status === statusFilter) && (symbolFilter === "all" || row.symbol === symbolFilter);
  }), [rows, statusFilter, symbolFilter]);
  const selectedRow = rows.find((row) => row.robot.botId === selectedRobotId);
  const actionRow = rows.find((row) => row.robot.botId === pendingAction?.botId);
  const portfolioBusy = center.detail ? center.busyKeys.has(`portfolio:${center.detail.portfolio.id}`) : center.busyKeys.has("portfolio:create");
  const snapshotStale = center.stale || !!center.detail && hasStaleAggregate(center.detail.snapshot.aggregates);
  const robotActionsEnabled = canMutate && center.detail?.portfolio.status === "active";

  const closeDetail = useCallback(() => setSelectedRobotId(undefined), []);
  const openDialog = (kind: PortfolioDialogKind, trigger: HTMLElement) => {
    const menu = trigger.closest("details");
    const returnTarget = menu?.querySelector<HTMLElement>("summary") ?? trigger;
    menu?.removeAttribute("open");
    setDialogTrigger(returnTarget);
    setDialog(kind);
  };
  const openAction = (row: PaperRobotRow, action: PaperRobotAction, trigger: HTMLElement) => {
    if (!robotActionsEnabled) return;
    setPendingAction({ botId: row.robot.botId, action, trigger });
  };

  return (
    <section className="paper-portfolio-center" aria-labelledby="paper-portfolio-title">
      <header className="paper-portfolio-toolbar">
        <div className="paper-portfolio-heading">
          <h2 id="paper-portfolio-title">{paperPortfolioText(locale, "title")}</h2>
          <p>{paperPortfolioText(locale, "description")}</p>
        </div>
        <div className="paper-toolbar-controls">
          {center.list && center.list.portfolios.length > 0 && (
            <label className="paper-portfolio-selector">
              <span>{paperPortfolioText(locale, "portfolio")}</span>
              <select value={center.selectedPortfolioId ?? ""} onChange={(event) => center.selectPortfolio(event.target.value)}>
                {center.list.portfolios.map((portfolio) => <option key={portfolio.id} value={portfolio.id}>{portfolio.name}{portfolio.isDefault ? ` · ${paperPortfolioText(locale, "defaultBadge")}` : ""}{portfolio.status === "archived" ? ` · ${paperPortfolioText(locale, "archivedBadge")}` : ""}</option>)}
              </select>
            </label>
          )}
          <button type="button" className="paper-icon-button" onClick={() => void center.refresh()} disabled={center.phase !== "ready"} aria-label={paperPortfolioText(locale, "refresh")} title={paperPortfolioText(locale, "refresh")}>
            <RefreshCw size={17} aria-hidden="true" />
          </button>
          {canMutate && (
            <details className="paper-portfolio-menu">
              <summary><Settings2 size={17} aria-hidden="true" /><span>{paperPortfolioText(locale, "portfolioActions")}</span><ChevronDown size={15} aria-hidden="true" /></summary>
              <div>
                <button type="button" onClick={(event) => openDialog("create", event.currentTarget)}><Plus aria-hidden="true" />{paperPortfolioText(locale, "createPortfolio")}</button>
                {center.detail && <>
                  <button type="button" onClick={(event) => openDialog("rename", event.currentTarget)} disabled={portfolioBusy}>{paperPortfolioText(locale, "renamePortfolio")}</button>
                  {!center.detail.portfolio.isDefault && center.detail.portfolio.status === "active" && <button type="button" onClick={() => void center.setDefaultPortfolio()} disabled={portfolioBusy}>{paperPortfolioText(locale, "makeDefault")}</button>}
                  {center.detail.portfolio.status === "active" && <button type="button" onClick={(event) => openDialog("archive", event.currentTarget)} disabled={portfolioBusy}><Archive aria-hidden="true" />{paperPortfolioText(locale, "archivePortfolio")}</button>}
                  {center.detail.portfolio.status === "active" && <button type="button" onClick={(event) => openDialog("reset", event.currentTarget)} disabled={portfolioBusy}><RotateCcw aria-hidden="true" />{paperPortfolioText(locale, "resetPortfolio")}</button>}
                </>}
              </div>
            </details>
          )}
        </div>
      </header>

      <div className="paper-snapshot-status" role="status" aria-live="polite">
        {center.phase === "loading" || center.phase === "refreshing" ? paperPortfolioText(locale, center.phase === "loading" ? "loading" : "refreshing")
          : center.detail ? <><span className={`paper-freshness ${snapshotStale ? "stale" : "fresh"}`}>{paperPortfolioText(locale, snapshotStale ? "stale" : "fresh")}</span>{paperPortfolioText(locale, "asOf")}: {new Date(center.detail.snapshot.asOf).toLocaleString(localeTag(locale))}</> : ""}
      </div>

      {center.error && <div className={`paper-center-alert ${center.stale ? "stale" : "error"}`} role={center.stale ? "status" : "alert"}>
        <strong>{paperPortfolioText(locale, center.stale ? "staleSnapshot" : "loadFailed")}</strong>
        <span>{errorMessage(center.error)}</span>
        <button type="button" onClick={() => void center.refresh()}>{paperPortfolioText(locale, "refresh")}</button>
      </div>}

      {center.phase === "loading" && !center.detail && <div className="paper-center-loading" role="status"><span className="loader-ring" aria-hidden="true" />{paperPortfolioText(locale, "loading")}</div>}

      {center.phase !== "loading" && center.list && center.list.portfolios.length === 0 && (
        <div className="paper-center-empty">
          <h3>{paperPortfolioText(locale, "noPortfolio")}</h3>
          <p>{paperPortfolioText(locale, "noPortfolioHint")}</p>
          {canMutate && <button type="button" className="run-button" onClick={(event) => openDialog("create", event.currentTarget)}><Plus aria-hidden="true" />{paperPortfolioText(locale, "createPortfolio")}</button>}
        </div>
      )}

      {center.detail && <>
        <section className={`paper-portfolio-summary ${summaryOpen ? "expanded" : "collapsed"}`} aria-label={paperPortfolioText(locale, "portfolio")}>
          <header>
            <div><strong>{center.detail.portfolio.name}</strong><span>{center.detail.portfolio.isDefault ? paperPortfolioText(locale, "defaultBadge") : paperPortfolioText(locale, center.detail.portfolio.status === "active" ? "active" : "archivedBadge")}</span></div>
            <button type="button" onClick={() => setSummaryOpen((current) => !current)} aria-expanded={summaryOpen}>{paperPortfolioText(locale, summaryOpen ? "hideSummary" : "showSummary")}<ChevronDown aria-hidden="true" /></button>
          </header>
          <dl>
            <SummaryMetric label={paperPortfolioText(locale, "equity")} value={<EvidenceMoney value={center.detail.snapshot.aggregates.equity} locale={locale} compact />} />
            <SummaryMetric label={paperPortfolioText(locale, "realizedPnl")} value={formatMoney(center.detail.snapshot.aggregates.realizedNetCashPnl, locale, true)} />
            <SummaryMetric label={paperPortfolioText(locale, "availableCapital")} value={formatMoney(center.detail.snapshot.aggregates.availableCapital, locale, true)} />
            <SummaryMetric label={paperPortfolioText(locale, "runningRobots")} value={String(rows.filter((row) => row.status === "running").length)} />
            <SummaryMetric extra label={paperPortfolioText(locale, "unrealizedPnl")} value={<EvidenceMoney value={center.detail.snapshot.aggregates.unrealizedPnl} locale={locale} compact />} />
            <SummaryMetric extra label={paperPortfolioText(locale, "reservedCapital")} value={formatMoney(center.detail.snapshot.aggregates.reservedCapital, locale, true)} />
            <SummaryMetric extra label={paperPortfolioText(locale, "exposure")} value={<EvidenceMoney value={center.detail.snapshot.aggregates.grossExposure} locale={locale} compact />} />
            <SummaryMetric extra label={paperPortfolioText(locale, "drawdown")} value={formatMoney(center.detail.snapshot.aggregates.cashEventMaxDrawdown, locale, true)} />
          </dl>
        </section>

        {rows.length === 0 ? <div className="paper-center-empty compact"><h3>{paperPortfolioText(locale, "noRobots")}</h3><p>{paperPortfolioText(locale, "noRobotsHint")}</p>{canMutate && center.detail.portfolio.status === "active" && <button type="button" className="run-button" onClick={onNewRobot}><Plus aria-hidden="true" />{paperPortfolioText(locale, "create")}</button>}</div> : <>
          <div className="paper-robot-filters">
            <label><span>{paperPortfolioText(locale, "statusFilter")}</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="all">{paperPortfolioText(locale, "allStatuses")}</option>
              {(["running", "paused", "stopped", "idle", "error"] as const).map((status) => <option key={status} value={status}>{paperRobotStatusText(locale, status)}</option>)}
              <option value="unavailable">{paperPortfolioText(locale, "unavailable")}</option>
            </select></label>
            <label><span>{paperPortfolioText(locale, "symbolFilter")}</span><select value={symbolFilter} onChange={(event) => setSymbolFilter(event.target.value)}>
              <option value="all">{paperPortfolioText(locale, "allSymbols")}</option>
              {symbols.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
            </select></label>
          </div>
          {filteredRows.length === 0 ? <p className="paper-filter-empty">{paperPortfolioText(locale, "noFilterResults")}</p> : <PaperRobotViews rows={filteredRows} locale={locale} busy={portfolioBusy} actionsEnabled={robotActionsEnabled} onOpen={(row, trigger) => { setDetailTrigger(trigger); setSelectedRobotId(row.robot.botId); }} onAction={openAction} />}
        </>}
        {center.detail.multiLeg && <PaperMultiLegIntentsSection
          locale={locale}
          multiLeg={center.detail.multiLeg}
          canMutate={canMutate}
          busy={center.busyKeys.size > 0}
          onToggleKillSwitch={async (enabled) => {
            await setPaperMultiLegKillSwitch(ownerUserId, { enabled }, { idempotencyKey: createPaperIdempotencyKey() });
            await center.refresh();
          }}
        />}
      </>}

      {selectedRow && <PaperRobotDetailDrawer row={selectedRow} locale={locale} busy={portfolioBusy} actionsEnabled={robotActionsEnabled} snapshotStale={center.stale} portfolioLastError={center.detail?.lastError} returnFocus={detailTrigger} onClose={closeDetail} onAction={openAction} />}
      {dialog && <PortfolioLifecycleDialog
        key={dialog}
        kind={dialog}
        locale={locale}
        portfolioName={center.detail?.portfolio.name}
        initialCapital={center.detail?.snapshot.aggregates.initialCapital}
        busy={center.busyKeys.size > 0}
        returnFocus={dialogTrigger}
        onClose={() => setDialog(undefined)}
        onCreate={async (name, capital) => { if (await center.createPortfolio(name, capital)) setDialog(undefined); }}
        onRename={async (name) => { if (await center.renamePortfolio(name)) setDialog(undefined); }}
        onArchive={async (name) => { if (await center.archivePortfolio(name)) setDialog(undefined); }}
        onReset={async (name, capital) => { if (await center.resetPortfolio(name, capital)) setDialog(undefined); }}
      />}
      {pendingAction && actionRow && <RobotActionDialog
        locale={locale}
        robot={actionRow.robot}
        robotName={actionRow.name}
        action={pendingAction.action}
        busy={portfolioBusy}
        returnFocus={pendingAction.trigger}
        onClose={() => setPendingAction(undefined)}
        onConfirm={async (robot, action) => { if (await center.runRobotAction(robot, action)) setPendingAction(undefined); }}
      />}
    </section>
  );
}

function SummaryMetric({ label, value, extra = false }: { label: string; value: ReactNode; extra?: boolean }) {
  return <div className={extra ? "paper-summary-extra" : undefined}><dt>{label}</dt><dd>{value}</dd></div>;
}

function errorMessage(error: Error): string {
  return error instanceof PaperPortfolioApiError ? `${error.code}: ${error.message}` : error.message;
}

function hasStaleAggregate(aggregates: PaperPortfolioAggregates): boolean {
  return [
    aggregates.equity, aggregates.unrealizedPnl, aggregates.grossExposure, aggregates.netExposure,
    aggregates.committedCapital, aggregates.margin, aggregates.borrowing
  ].some((value) => value.status === "stale");
}
