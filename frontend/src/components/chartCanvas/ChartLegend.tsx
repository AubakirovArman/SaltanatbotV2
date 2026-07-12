import { priceRepresentationBadge, type PriceRepresentationSettings } from "../../chart/priceRepresentationSettings";
import type { Candle, ChartType, Instrument, Timeframe } from "../../types";
import { formatVolume } from "./drawingInteraction";

export function ChartLegend({ candle, chartType, instrument, settings, timeframe }: {
  candle?: Candle;
  chartType: ChartType;
  instrument: Instrument;
  settings: PriceRepresentationSettings;
  timeframe: Timeframe;
}) {
  const badge = priceRepresentationBadge(chartType, settings);
  const change = candle && candle.open ? (candle.close - candle.open) / candle.open * 100 : 0;
  return (
    <div className="chart-legend" aria-hidden="true">
      <span className="legend-symbol">
        <b>{instrument.symbol}</b>
        <i>{badge ? `${badge} · ` : ""}{timeframe} · {instrument.exchange}</i>
      </span>
      {candle && <>
        <span>O <b>{candle.open.toFixed(instrument.decimals)}</b></span>
        <span>H <b>{candle.high.toFixed(instrument.decimals)}</b></span>
        <span>L <b>{candle.low.toFixed(instrument.decimals)}</b></span>
        <span>C <b>{candle.close.toFixed(instrument.decimals)}</b></span>
        <span className={candle.close >= candle.open ? "up" : "down"}>
          {change >= 0 ? "+" : ""}{change.toFixed(2)}%
        </span>
        <span className="vol">V {formatVolume(candle.volume)}</span>
      </>}
    </div>
  );
}
