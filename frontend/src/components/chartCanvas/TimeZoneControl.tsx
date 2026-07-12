import type { Locale } from "../../i18n";
import { shellText } from "../../i18n/shell";
import { CHART_TIME_ZONES, normalizeChartTimeZone, type ChartTimeZone } from "../../chart/timeAxis";

export function TimeZoneControl({ chartId, locale, value, onChange }: {
  chartId: string;
  locale: Locale;
  value?: ChartTimeZone;
  onChange?: (timeZone: ChartTimeZone) => void;
}) {
  const selected = normalizeChartTimeZone(value);
  const labels: Record<ChartTimeZone, string> = {
    exchange: shellText(locale, "timeZoneExchange"),
    local: shellText(locale, "timeZoneLocal"),
    UTC: "UTC",
    "Asia/Almaty": shellText(locale, "timeZoneAlmaty"),
    "America/New_York": shellText(locale, "timeZoneNewYork"),
    "Europe/London": shellText(locale, "timeZoneLondon"),
    "Europe/Berlin": shellText(locale, "timeZoneBerlin"),
    "Asia/Tokyo": shellText(locale, "timeZoneTokyo"),
    "Asia/Hong_Kong": shellText(locale, "timeZoneHongKong")
  };
  const inputId = `${chartId}-time-zone`;
  return (
    <label className="time-zone-control" htmlFor={inputId}>
      <span>{shellText(locale, "timeZone")}</span>
      <select
        id={inputId}
        name="chart-time-zone"
        value={selected}
        title={`${shellText(locale, "timeZone")}: ${labels[selected]}`}
        onChange={(event) => onChange?.(normalizeChartTimeZone(event.currentTarget.value))}
      >
        {CHART_TIME_ZONES.map((timeZone) => <option key={timeZone} value={timeZone}>{labels[timeZone]}</option>)}
      </select>
    </label>
  );
}
