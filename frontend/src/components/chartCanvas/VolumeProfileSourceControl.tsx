import { useId } from "react";
import { VOLUME_PROFILE_TIMEFRAMES, type VolumeProfileSource, type VolumeProfileSourceIssue } from "../../chart/volumeProfileSource";
import { chartText, type ChartMessageKey } from "../../i18n/chart";
import type { Locale } from "../../i18n";
import type { Timeframe } from "../../types";
import type { VolumeProfileSourceState } from "./useVolumeProfileSource";

export function VolumeProfileSourceControl({
  locale,
  chartTimeframe,
  enabled,
  onEnabledChange,
  state
}: {
  locale: Locale;
  chartTimeframe: Timeframe;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  state: VolumeProfileSourceState;
}) {
  const selectId = useId();
  const statusId = useId();
  const message = statusMessage(locale, chartTimeframe, state);
  return (
    <div className="volume-profile-source-control" data-state={state.status}>
      <label className="volume-profile-toggle">
        <input type="checkbox" checked={enabled} onChange={(event) => onEnabledChange(event.currentTarget.checked)} />
        <span>{chartText(locale, "volumeProfile")}</span>
      </label>
      {enabled && (
        <>
          <label className="volume-profile-source-field" htmlFor={selectId}>
            <span>{chartText(locale, "volumeProfileSource")}</span>
            <select
              id={selectId}
              name="volume-profile-source"
              value={state.source}
              aria-describedby={statusId}
              onChange={(event) => state.setSource(event.currentTarget.value as VolumeProfileSource)}
            >
              <option value="chart">{chartText(locale, "volumeProfileAsChart")} ({chartTimeframe})</option>
              {VOLUME_PROFILE_TIMEFRAMES.map((timeframe) => <option key={timeframe} value={timeframe}>{timeframe}</option>)}
            </select>
          </label>
          <output id={statusId} className="volume-profile-source-status" aria-live="polite">
            {message}
          </output>
        </>
      )}
    </div>
  );
}

function statusMessage(locale: Locale, chartTimeframe: Timeframe, state: VolumeProfileSourceState) {
  if (state.status === "idle" || state.status === "loading") return chartText(locale, "volumeProfileLoading");
  if (state.status === "ready") {
    if (state.source === "chart") return `${chartText(locale, "volumeProfileChartReady")} · ${chartTimeframe}`;
    return `${chartText(locale, "volumeProfileReady")} · ${state.candles.length} × ${state.timeframe}`;
  }
  const key: Record<VolumeProfileSourceIssue, ChartMessageKey> = {
    fallback: "volumeProfileFallback",
    incomplete: "volumeProfileIncomplete",
    "no-data": "volumeProfileNoData",
    "range-too-wide": "volumeProfileRangeTooWide",
    request: "volumeProfileRequestError"
  };
  const summary = chartText(locale, key[state.issue ?? "request"]);
  return state.detail ? `${summary} ${state.detail}` : summary;
}
