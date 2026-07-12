import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { Candle, Timeframe } from "../../types";
import type { Viewport, VolumeProfileSnapshot } from "../../chart/types";
import type { Locale } from "../../i18n";
import { shellText } from "../../i18n/shell";
import { formatVolume } from "./drawingInteraction";

interface ChartPriceHudProps {
  candle?: Candle;
  latest?: Candle;
  timeframe: Timeframe;
  decimals: number;
  locale: Locale;
  viewport?: Viewport;
  crosshair?: { x: number; y: number };
}

export function ChartPriceHud({ candle, latest, timeframe, decimals, locale, viewport, crosshair }: ChartPriceHudProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const priceStyle = useMemo<CSSProperties | undefined>(() => {
    if (!latest || !viewport) return undefined;
    const y = viewport.priceToY(latest.close) / deviceRatio();
    return y >= viewport.plot.top / deviceRatio() && y <= viewport.plot.bottom / deviceRatio()
      ? { top: y }
      : undefined;
  }, [latest, viewport]);

  const cardStyle = useMemo<CSSProperties | undefined>(() => {
    if (!crosshair || !viewport) return undefined;
    const ratio = deviceRatio();
    const x = crosshair.x / ratio;
    const y = Math.max(42, crosshair.y / ratio - 46);
    const midpoint = (viewport.plot.left + viewport.plot.right) / 2 / ratio;
    return x > midpoint ? { right: 78, top: y } : { left: Math.max(12, x + 18), top: y };
  }, [crosshair, viewport]);

  if (!latest) return null;
  const up = latest.close >= latest.open;
  const remaining = formatBarCountdown(nextBarTime(latest.time, timeframe) - now);
  const change = candle ? candle.close - candle.open : 0;
  const changePct = candle && candle.open ? change / candle.open * 100 : 0;

  return (
    <>
      {priceStyle && (
        <div className={`current-price-pill ${up ? "up" : "down"}`} style={priceStyle} aria-label={`Last price ${latest.close.toFixed(decimals)}, ${remaining} remaining`}>
          <strong>{latest.close.toFixed(decimals)}</strong>
          <span>{remaining}</span>
        </div>
      )}
      {candle && crosshair && cardStyle && (
        <div className="crosshair-hud" style={cardStyle} aria-hidden="true">
          <header>
            <strong>{new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(candle.time)}</strong>
            <span className={change >= 0 ? "up" : "down"}>{change >= 0 ? "+" : ""}{changePct.toFixed(2)}%</span>
          </header>
          <dl>
            <div><dt>O</dt><dd>{candle.open.toFixed(decimals)}</dd></div>
            <div><dt>H</dt><dd>{candle.high.toFixed(decimals)}</dd></div>
            <div><dt>L</dt><dd>{candle.low.toFixed(decimals)}</dd></div>
            <div><dt>C</dt><dd>{candle.close.toFixed(decimals)}</dd></div>
          </dl>
          <footer><span>Δ {change >= 0 ? "+" : ""}{change.toFixed(decimals)}</span><span>V {formatVolume(candle.volume)}</span></footer>
        </div>
      )}
    </>
  );
}

export function VolumeProfileBadge({ visible, profile, decimals, locale }: { visible: boolean; profile?: VolumeProfileSnapshot; decimals: number; locale: Locale }) {
  if (!visible || !profile) return null;
  const valueArea = shellText(locale, "valueArea");
  return (
    <div className="volume-profile-badge" title={`${shellText(locale, "volumeProfileEstimate")}. ${valueArea}: ${profile.valueAreaLow.toFixed(decimals)} — ${profile.valueAreaHigh.toFixed(decimals)}`}>
      <strong>VPVR · EST · {profile.bins}</strong>
      <span>{shellText(locale, "pointOfControl")} <b>{profile.pocPrice.toFixed(decimals)}</b></span>
    </div>
  );
}

export function nextBarTime(openTime: number, timeframe: Timeframe) {
  if (timeframe === "1M") {
    const date = new Date(openTime);
    const nextMonthLastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 2, 0)).getUTCDate();
    return Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      Math.min(date.getUTCDate(), nextMonthLastDay),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds()
    );
  }
  return openTime + timeframeMs(timeframe);
}

export function formatBarCountdown(remainingMs: number) {
  const total = Math.max(0, Math.floor(remainingMs / 1_000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor(total % 86_400 / 3_600);
  const minutes = Math.floor(total % 3_600 / 60);
  const seconds = total % 60;
  const clock = [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
  return days > 0 ? `${days}d ${clock}` : clock;
}

function timeframeMs(timeframe: Exclude<Timeframe, "1M">) {
  const units: Record<Exclude<Timeframe, "1M">, number> = {
    "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
    "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000,
    "1d": 86_400_000, "1w": 604_800_000
  };
  return units[timeframe];
}

function deviceRatio() {
  return typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
}
