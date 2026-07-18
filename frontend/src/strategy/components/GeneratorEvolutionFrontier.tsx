import { Loader2, X } from "lucide-react";
import { useId } from "react";
import {
  gaPromotionBlockReason,
  type GaCandidateDetail,
  type GaCandidateSummary,
  type GaRunDetail
} from "../gaEvolutionClient";
import type { generatorText } from "../generatorText";

/**
 * Pareto frontier table + candidate evidence drawer for one server evolution
 * run (R9.2). Pure presentation: the parent owns all fetching and promotion
 * state. Overfit and missing-OOS conditions are surfaced explicitly and the
 * promote action is disabled with a visible reason — mirroring the server
 * invariant that promotion requires a clean out-of-sample report.
 */

type GeneratorKey = Parameters<typeof generatorText>[1];
type Translate = (key: GeneratorKey) => string;

/** Canonical objective order first, unknown objective keys after. */
const OBJECTIVE_ORDER = ["netProfitPct", "maxDrawdownPct", "sharpe", "complexity"];

export interface EvolutionDrawerState {
  fingerprint: string;
  detail?: GaCandidateDetail;
  loading: boolean;
  error?: string;
}

interface GeneratorEvolutionFrontierProps {
  run: GaRunDetail;
  drawer?: EvolutionDrawerState;
  promotingFingerprint?: string;
  onInspect: (fingerprint: string) => void;
  onCloseDrawer: () => void;
  onPromote: (candidate: GaCandidateSummary) => void;
  formatter: Intl.NumberFormat;
  t: Translate;
}

export function GeneratorEvolutionFrontier({ run, drawer, promotingFingerprint, onInspect, onCloseDrawer, onPromote, formatter, t }: GeneratorEvolutionFrontierProps) {
  const headingId = useId();
  const metric = (value: number | undefined) => (value !== undefined && Number.isFinite(value) ? formatter.format(value) : "—");

  return (
    <section className="strategy-generator-evolution-frontier" aria-labelledby={headingId}>
      <strong id={headingId}>{t("serverEvolutionFrontier")}</strong>
      <p>{t("serverEvolutionFrontierIntro")}</p>
      {run.frontier.length === 0 ? (
        <p className="strategy-generator-eval-hint" role="status">{t("serverEvolutionFrontierEmpty")}</p>
      ) : (
        <div className="strategy-generator-table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{t("serverEvolutionRank")}</th>
                <th scope="col">{t("candidate")}</th>
                <th scope="col">{t("serverEvolutionObjectives")}</th>
                <th scope="col">{t("rankingOosScore")}</th>
                <th scope="col">{t("serverEvolutionPromote")}</th>
              </tr>
            </thead>
            <tbody>
              {run.frontier.map((candidate) => (
                <tr key={candidate.fingerprint} className={drawer?.fingerprint === candidate.fingerprint ? "selected" : undefined} data-candidate-fingerprint={candidate.fingerprint}>
                  <td>{candidate.paretoRank ?? "—"}</td>
                  <th scope="row">
                    <span className="strategy-generator-candidate-name">
                      <code title={candidate.fingerprint}>{candidate.fingerprint.slice(0, 24)}…</code>
                      <span>{t("generation")} {candidate.generation ?? "—"}</span>
                    </span>
                  </th>
                  <td><ObjectiveList objectives={candidate.objectives} metric={metric} /></td>
                  <td><OosBadges candidate={candidate} metric={metric} t={t} /></td>
                  <td>
                    <span className="strategy-generator-evolution-row-actions">
                      <PromoteButton candidate={candidate} promotingFingerprint={promotingFingerprint} onPromote={onPromote} t={t} />
                      <button type="button" onClick={() => onInspect(candidate.fingerprint)} aria-label={`${t("serverEvolutionInspect")}: ${candidate.fingerprint}`}>
                        {t("serverEvolutionInspect")}
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {drawer && <CandidateDrawer drawer={drawer} promotingFingerprint={promotingFingerprint} onCloseDrawer={onCloseDrawer} onPromote={onPromote} metric={metric} t={t} />}
    </section>
  );
}

function ObjectiveList({ objectives, metric }: { objectives: Record<string, number>; metric: (value: number | undefined) => string }) {
  const keys = orderedObjectiveKeys(objectives);
  if (keys.length === 0) return <span>—</span>;
  return (
    <span className="strategy-generator-evolution-objectives">
      {keys.map((key) => (
        <span key={key}><code>{key}</code> {metric(objectives[key])}</span>
      ))}
    </span>
  );
}

function OosBadges({ candidate, metric, t }: { candidate: GaCandidateSummary; metric: (value: number | undefined) => string; t: Translate }) {
  const report = candidate.oosReport;
  if (!report) return <span className="strategy-generator-evolution-badge is-missing">{t("serverEvolutionNoOos")}</span>;
  const worstGap = worstObjectiveGap(report.gapPct);
  return (
    <span className="strategy-generator-evolution-badges">
      {report.overfit ? (
        <span className="strategy-generator-evolution-badge is-overfit">{t("serverEvolutionOverfit")}</span>
      ) : (
        <span className="strategy-generator-evolution-badge is-clean">{t("serverEvolutionCleanOos")}</span>
      )}
      {report.unstable && <span className="strategy-generator-evolution-badge is-unstable">{t("serverEvolutionUnstable")}</span>}
      <span className="strategy-generator-evolution-badge is-gap">{t("serverEvolutionOosGap")}: {metric(worstGap)}</span>
    </span>
  );
}

function PromoteButton({ candidate, promotingFingerprint, onPromote, t }: { candidate: GaCandidateSummary; promotingFingerprint?: string; onPromote: (candidate: GaCandidateSummary) => void; t: Translate }) {
  if (candidate.promotedAt !== undefined) {
    return <span className="strategy-generator-evolution-badge is-promoted">{t("serverEvolutionPromotedBadge")}</span>;
  }
  const block = gaPromotionBlockReason(candidate);
  const reason = block === "missing_oos" ? t("serverEvolutionPromoteNoOos") : block === "overfit" ? t("serverEvolutionPromoteOverfit") : undefined;
  const promoting = promotingFingerprint === candidate.fingerprint;
  const label = promoting ? t("serverEvolutionPromoting") : t("serverEvolutionPromote");
  return (
    <button
      type="button"
      className="primary"
      disabled={block !== undefined || promotingFingerprint !== undefined}
      title={reason}
      aria-label={reason ? `${t("serverEvolutionPromote")}: ${reason}` : `${t("serverEvolutionPromote")}: ${candidate.fingerprint}`}
      onClick={() => onPromote(candidate)}
    >
      {promoting && <Loader2 className="spin" size={13} aria-hidden="true" />}
      {label}
    </button>
  );
}

function CandidateDrawer({ drawer, promotingFingerprint, onCloseDrawer, onPromote, metric, t }: {
  drawer: EvolutionDrawerState;
  promotingFingerprint?: string;
  onCloseDrawer: () => void;
  onPromote: (candidate: GaCandidateSummary) => void;
  metric: (value: number | undefined) => string;
  t: Translate;
}) {
  const detail = drawer.detail;
  const block = detail ? gaPromotionBlockReason(detail) : undefined;
  const blockText = block === "missing_oos" ? t("serverEvolutionPromoteNoOos") : block === "overfit" ? t("serverEvolutionPromoteOverfit") : undefined;
  const lineage = detail ? (detail.lineage.length > 0 ? detail.lineage : detail.parentFingerprints) : [];
  return (
    <aside className="strategy-generator-evolution-drawer" aria-label={t("candidateDetails")}>
      <div className="strategy-generator-evolution-drawer-head">
        <strong>{t("candidateDetails")}</strong>
        <code title={drawer.fingerprint}>{drawer.fingerprint}</code>
        <button type="button" className="icon-button" onClick={onCloseDrawer} aria-label={t("serverEvolutionCloseDrawer")}><X size={14} aria-hidden="true" /></button>
      </div>
      {drawer.loading && <p role="status" aria-live="polite"><Loader2 className="spin" size={13} aria-hidden="true" /> {t("serverEvalStateRunning")}…</p>}
      {drawer.error && <p className="strategy-generator-error" role="alert">{drawer.error}</p>}
      {detail && (
        <>
          <dl>
            <div><dt>{t("generation")}</dt><dd>{detail.generation ?? "—"}</dd></div>
            <div><dt>{t("serverEvolutionRank")}</dt><dd>{detail.paretoRank ?? "—"}</dd></div>
            <div>
              <dt>{t("serverEvolutionLineage")}</dt>
              <dd>{lineage.length ? lineage.map((fingerprint) => <code key={fingerprint}>{fingerprint}</code>) : t("none")}</dd>
            </div>
            <div>
              <dt>{t("mutations")}</dt>
              <dd>{detail.mutationLog.length ? detail.mutationLog.map((mutation, index) => <code key={`${mutation.field}-${index}`}>{mutation.field}: {mutation.from ?? "—"} → {mutation.to ?? "—"}</code>) : t("none")}</dd>
            </div>
            <div><dt>{t("serverEvolutionObjectives")}</dt><dd><ObjectiveList objectives={detail.objectives} metric={metric} /></dd></div>
            {detail.oosReport && (
              <div>
                <dt>{t("rankingOosScore")}</dt>
                <dd>
                  <OosBadges candidate={detail} metric={metric} t={t} />
                  {detail.oosReport.oosLossShare !== undefined && <span>{t("serverEvolutionOosLossShare")}: {metric(detail.oosReport.oosLossShare)}</span>}
                  {detail.oosReport.dispersion !== undefined && <span>{t("serverEvolutionDispersion")}: {metric(detail.oosReport.dispersion)}</span>}
                </dd>
              </div>
            )}
          </dl>
          {detail.markets.length > 0 && (
            <div className="strategy-generator-table-wrap">
              <table aria-label={t("serverEvolutionPerMarket")}>
                <thead>
                  <tr>
                    <th scope="col">{t("serverEvalMarkets")}</th>
                    <th scope="col">{t("rankingTrainScore")}</th>
                    <th scope="col">{t("rankingOosScore")}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.markets.map((market) => (
                    <tr key={market.marketId}>
                      <th scope="row"><code>{market.marketId}</code></th>
                      <td><ObjectiveList objectives={pickMetrics(market.train)} metric={metric} /></td>
                      <td><ObjectiveList objectives={pickMetrics(market.outOfSample)} metric={metric} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="strategy-generator-evolution-row-actions">
            <PromoteButton candidate={detail} promotingFingerprint={promotingFingerprint} onPromote={onPromote} t={t} />
            {blockText && <span className="strategy-generator-eval-hint" role="status">{blockText}</span>}
          </div>
        </>
      )}
    </aside>
  );
}

function orderedObjectiveKeys(record: Record<string, number>): string[] {
  const known = OBJECTIVE_ORDER.filter((key) => key in record);
  const rest = Object.keys(record).filter((key) => !OBJECTIVE_ORDER.includes(key)).sort();
  return [...known, ...rest];
}

/** The full backtest section carries many metrics; the drawer shows a stable, readable subset. */
function pickMetrics(record: Record<string, number>): Record<string, number> {
  const picked: Record<string, number> = {};
  for (const key of ["netProfitPct", "maxDrawdownPct", "sharpe", "profitFactor", "tradeCount"]) {
    if (key in record) picked[key] = record[key]!;
  }
  return picked;
}

function worstObjectiveGap(gapPct: Record<string, number>): number | undefined {
  let worst: number | undefined;
  for (const gap of Object.values(gapPct)) {
    if (!Number.isFinite(gap)) continue;
    if (worst === undefined || Math.abs(gap) > Math.abs(worst)) worst = gap;
  }
  return worst;
}
