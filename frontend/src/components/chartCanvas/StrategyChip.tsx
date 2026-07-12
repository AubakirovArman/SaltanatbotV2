import { SlidersHorizontal, Workflow, X } from "lucide-react";
import type { Locale } from "../../i18n";
import { shellText } from "../../i18n/shell";

export function StrategyChip({ hasInputs, locale, name, onClear, onToggleSettings, signals, summary, trades }: {
  hasInputs: boolean;
  locale: Locale;
  name: string;
  onClear?: () => void;
  onToggleSettings: () => void;
  signals: number;
  summary?: string;
  trades: number;
}) {
  const t = (key: Parameters<typeof shellText>[1]) => shellText(locale, key);
  return (
    <div className="strategy-chip">
      <Workflow size={12} aria-hidden="true" />
      <span>{name}</span>
      {summary && <b>{summary}</b>}
      {trades > 0 && <b>{trades} {t("trades")}</b>}
      {!summary && signals > 0 && <b>{signals} {t("signals")}</b>}
      {hasInputs && (
        <button type="button" onClick={onToggleSettings} title={t("indicatorInputs")} aria-label={t("editIndicatorInputs")}>
          <SlidersHorizontal size={12} aria-hidden="true" />
        </button>
      )}
      <button type="button" onClick={onClear} title={t("removeFromChart")} aria-label={t("removeArtifact")}>
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
}
