import type { Candle, Instrument } from "../types";
import type { ConnectionState } from "../hooks/useMarketStream";

interface StatsPanelProps {
  instrument: Instrument;
  candles: Candle[];
  provider: string;
  connection: ConnectionState;
  message: string;
  latencyMs?: number;
}

export function StatsPanel({
  instrument,
  candles,
  provider,
  connection,
  message,
  latencyMs
}: StatsPanelProps) {
  const latest = candles.at(-1);
  const previous = candles.at(-2);
  const change = latest && previous ? latest.close - previous.close : 0;
  const percent = latest && previous ? (change / previous.close) * 100 : 0;
  const direction = change >= 0 ? "up" : "down";
  const range = latest ? latest.high - latest.low : undefined;

  return (
    <aside className="stats-panel">
      <section>
        <div className="quote-meta">
          {instrument.symbol} · {instrument.exchange} · {instrument.assetClass}
        </div>
        <div className="quote-block">
          <strong className="num">{latest ? latest.close.toFixed(instrument.decimals) : "…"}</strong>
          <em className={`num ${direction}`}>
            {change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(instrument.decimals)} · {percent.toFixed(2)}%
          </em>
        </div>
      </section>

      <section className="stat-table" aria-label="Bar statistics">
        <StatRow label="Open" value={format(latest?.open, instrument.decimals)} />
        <StatRow label="High" value={format(latest?.high, instrument.decimals)} />
        <StatRow label="Low" value={format(latest?.low, instrument.decimals)} />
        <StatRow label="Range" value={format(range, instrument.decimals)} />
        <StatRow label="Change" value={`${change >= 0 ? "+" : ""}${change.toFixed(instrument.decimals)}`} tone={direction} />
        <StatRow label="Volume" value={compact(latest?.volume)} />
      </section>

      <section>
        <div className="panel-header">
          <strong>Feed</strong>
          <span className={connection}>{connection}</span>
        </div>
        <div className="feed-list">
          <FeedRow label="Provider" value={provider} />
          <FeedRow label="Latency" value={latencyMs !== undefined ? `${latencyMs} ms` : "…"} num />
          <FeedRow label="Candles" value={String(candles.length)} num />
          <FeedRow label="Status" value={message} />
        </div>
      </section>
    </aside>
  );
}

function StatRow({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="stat-row">
      <span>{label}</span>
      <strong className={`num ${tone ?? ""}`}>{value}</strong>
    </div>
  );
}

function FeedRow({ label, value, num }: { label: string; value: string; num?: boolean }) {
  return (
    <div className="feed-row">
      <span>{label}</span>
      <strong className={num ? "num" : ""} title={value}>{value}</strong>
    </div>
  );
}

function format(value: number | undefined, decimals: number) {
  return value === undefined ? "…" : value.toFixed(decimals);
}

function compact(value: number | undefined) {
  return value === undefined
    ? "…"
    : Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}
