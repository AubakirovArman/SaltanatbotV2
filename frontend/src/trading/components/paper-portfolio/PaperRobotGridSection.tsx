import { worstCaseGridCapitalQuote, type GridParamsV1 } from "@saltanatbotv2/contracts";
import { PAPER_FILL_MODEL_V1 } from "@saltanatbotv2/execution-core";
import type { ReactNode } from "react";
import { localeTag, type Locale } from "../../../i18n";
import { gridModeText, gridPhaseText, gridSpacingText, gridText, type GridMessageKey } from "../../../i18n/grid";
import { paperPortfolioText } from "../../../i18n/paperPortfolio";
import { formatPaperMoney } from "../../paperPortfolioFormat";
import type { EvidenceValue, PaperMoney, PaperRobotGridRuntime } from "../../paperPortfolioTypes";

/**
 * Detail-drawer grid state section; every field is optional and rendered
 * leniently. Realized grid PnL (closed buy-sell pairs) and inventory PnL (the
 * evidence-aware unrealized mark on held inventory) stay strictly separated.
 */
export function PaperRobotGridSection({
  grid,
  inventoryPnl,
  locale
}: {
  grid: PaperRobotGridRuntime;
  inventoryPnl?: EvidenceValue<PaperMoney>;
  locale: Locale;
}) {
  const unavailable = paperPortfolioText(locale, "unavailable");
  const amount = (value?: number) => value === undefined ? unavailable : value.toLocaleString(localeTag(locale), { maximumFractionDigits: 6 });
  const count = (value?: number) => value === undefined ? unavailable : String(value);
  const levelsTotal = grid.levelsTotal ?? grid.params?.gridLevels;
  return (
    <section className="paper-detail-section paper-grid-section">
      <h4>{gridText(locale, "gridTitle")}</h4>
      <dl className="paper-detail-metrics">
        <Metric label={gridText(locale, "phase")} value={grid.phase ? gridPhaseText(locale, grid.phase) : unavailable} />
        <Metric label={gridText(locale, "mode")} value={grid.mode ? gridModeText(locale, grid.mode) : unavailable} />
        <Metric label={gridText(locale, "spacing")} value={grid.spacing ? gridSpacingText(locale, grid.spacing) : unavailable} />
        <Metric label={gridText(locale, "lowerBound")} value={amount(grid.lowerBound ?? grid.params?.lowerBound)} />
        <Metric label={gridText(locale, "upperBound")} value={amount(grid.upperBound ?? grid.params?.upperBound)} />
        <Metric label={gridText(locale, "levelsTotal")} value={count(levelsTotal)} />
        <Metric label={gridText(locale, "levelsResting")} value={count(grid.levelsResting)} />
        <Metric label={gridText(locale, "levelsFilled")} value={count(grid.levelsFilled)} />
        <Metric label={gridText(locale, "levelsCooldown")} value={count(grid.levelsCooldown)} />
        <Metric label={gridText(locale, "inventoryBaseQty")} value={amount(grid.inventoryBaseQty)} />
        <Metric label={gridText(locale, "inventoryAvgCost")} value={amount(grid.inventoryAvgCost)} />
        <Metric label={gridText(locale, "realizedGridPnl")} value={grid.realizedGridPnl === undefined ? unavailable : `${amount(grid.realizedGridPnl)} USDT`} />
        <Metric label={gridText(locale, "inventoryPnl")} value={<InventoryPnl value={inventoryPnl} locale={locale} />} />
        <Metric label={gridText(locale, "cyclesCompleted")} value={count(grid.cyclesCompleted)} />
        {grid.stopReason && <Metric label={gridText(locale, "stopReason")} value={grid.stopReason} />}
      </dl>
      <p className="paper-grid-note" role="note">{gridText(locale, "pnlSeparationNote")}</p>
      {grid.params && <GridParamsDisclosure params={grid.params} locale={locale} />}
    </section>
  );
}

/** Evidence-aware unrealized mark on held inventory; unavailable stays unavailable. */
function InventoryPnl({ value, locale }: { value?: EvidenceValue<PaperMoney>; locale: Locale }) {
  if (!value || value.status === "unavailable") {
    return <span className="paper-evidence unavailable" title={value?.reason}>{paperPortfolioText(locale, "unavailable")}</span>;
  }
  const money = value.status === "available" ? value.value : value.lastValue;
  const title = value.status === "stale" ? value.reason : `${value.source} · ${new Date(value.observedAt).toLocaleString(localeTag(locale))}`;
  return (
    <span className={`paper-evidence ${value.status}`} title={title}>
      {formatPaperMoney(money, locale)}{value.status === "stale" && <small>{paperPortfolioText(locale, "stale")}</small>}
    </span>
  );
}

function GridParamsDisclosure({ params, locale }: { params: GridParamsV1; locale: Locale }) {
  const amount = (value: number) => `${value.toLocaleString(localeTag(locale), { maximumFractionDigits: 6 })} USDT`;
  const price = (value: number) => value.toLocaleString(localeTag(locale), { maximumFractionDigits: 6 });
  const worstCase = worstCaseGridCapitalQuote(params, PAPER_FILL_MODEL_V1.feePct);
  const rows: Array<[GridMessageKey, string]> = [
    ["mode", gridModeText(locale, params.mode)],
    ["spacing", gridSpacingText(locale, params.spacing)],
    ["lowerBound", price(params.lowerBound)],
    ["upperBound", price(params.upperBound)],
    ["gridLevels", String(params.gridLevels)],
    ["orderQuote", amount(params.orderQuote)],
    ["recenter", gridText(locale, "recenterOff")],
    ["outsideRangeAction", gridText(locale, params.outsideRangeAction === "pause" ? "outsidePause" : "outsideStop")],
    ...(params.stopLossPrice === undefined ? [] : [["stopLossPrice", price(params.stopLossPrice)] as [GridMessageKey, string]]),
    ...(params.maxCycles === undefined ? [] : [["maxCycles", String(params.maxCycles)] as [GridMessageKey, string]]),
    ["cooldownSeconds", String(params.cooldownSeconds)],
    ["worstCaseTitle", amount(worstCase)]
  ];
  return (
    <details className="paper-grid-params">
      <summary>{gridText(locale, "paramsDisclosure")}</summary>
      <dl className="paper-detail-metrics">
        {rows.map(([key, value]) => <Metric key={key} label={gridText(locale, key)} value={value} />)}
      </dl>
      <p className="paper-grid-note">{gridText(locale, "researchNote")}</p>
    </details>
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}
