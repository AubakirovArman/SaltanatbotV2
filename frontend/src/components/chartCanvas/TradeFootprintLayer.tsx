import { parseTradeFlowStreamMessage } from "@saltanatbotv2/contracts";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createTradeFlowSocket } from "../../api/marketClient";
import { aggregateTradeFootprint, tradeFlowDeltaPercent } from "../../chart/tradeFootprint";
import { detectFootprintInsights } from "../../chart/footprintInsights";
import { drawFootprintInsights } from "../../chart/renderers/footprintInsights";
import { evaluateMicrostructureAlerts, type MicrostructureAlertEvent } from "../../chart/microstructureAlerts";
import { loadMicrostructureAlertSettings, storeMicrostructureAlertSettings } from "../../chart/microstructureAlertStore";
import type { Viewport } from "../../chart/types";
import type { Locale } from "../../i18n";
import { shellText } from "../../i18n/shell";
import { prepareCanvasContext, resizeCanvasToEntry } from "../../chart/canvasDensity";
import { playAlertBeep, showSystemNotification } from "../../market/alerts";
import type { Candle, DataExchange, TradeFlowStatus, TradeFlowStreamMessage, TradeFlowTrade } from "../../types";
import { TradeFlowAlertCenter } from "./TradeFlowAlertCenter";
import type { ChartTimeZone } from "../../chart/timeAxis";

const RETENTION_MS = 30 * 60_000;
const MAX_TRADES = 20_000;

interface FlowMeta {
  status: TradeFlowStatus | "paused";
  message: string;
  prints: number;
  buyNotional: number;
  sellNotional: number;
}

interface InsightMeta {
  imbalances: number;
  stacks: number;
  absorptions: number;
}

export const TradeFootprintLayer = memo(function TradeFootprintLayer({
  enabled,
  symbol,
  exchange,
  locale,
  timeZone,
  candles,
  viewportRef,
  renderKey
}: {
  enabled: boolean;
  symbol: string;
  exchange: DataExchange;
  locale: Locale;
  timeZone: ChartTimeZone;
  candles: Candle[];
  viewportRef: { current: Viewport | undefined };
  renderKey: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tradesRef = useRef<TradeFlowTrade[]>([]);
  const seenRef = useRef(new Set<string>());
  const alertSeenRef = useRef(new Set<string>());
  const statusRef = useRef<FlowMeta["status"]>("connecting");
  const rafRef = useRef<number>();
  const insightMetaRef = useRef<InsightMeta>({ imbalances: 0, stacks: 0, absorptions: 0 });
  const pendingInsightMetaRef = useRef<InsightMeta>();
  const insightMetaTimerRef = useRef<number>();
  const lastInsightMetaAtRef = useRef(0);
  const [meta, setMeta] = useState<FlowMeta>({ status: "connecting", message: "", prints: 0, buyNotional: 0, sellNotional: 0 });
  const [insightMeta, setInsightMeta] = useState<InsightMeta>(insightMetaRef.current);
  const [alertSettings, setAlertSettings] = useState(loadMicrostructureAlertSettings);
  const [alertEvents, setAlertEvents] = useState<MicrostructureAlertEvent[]>([]);
  const t = (key: Parameters<typeof shellText>[1]) => shellText(locale, key);

  useEffect(() => storeMicrostructureAlertSettings(alertSettings), [alertSettings]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport || !enabled) return;
    const surface = prepareCanvasContext(canvas);
    if (!surface) return;
    const { ctx } = surface;
    ctx.clearRect(0, 0, surface.width, surface.height);
    const footprint = aggregateTradeFootprint(tradesRef.current, viewport);
    const insights = detectFootprintInsights(footprint, candles);
    const styles = getComputedStyle(canvas);
    const up = styles.getPropertyValue("--up").trim() || "#23b99a";
    const down = styles.getPropertyValue("--down").trim() || "#ef6a65";
    const accent = styles.getPropertyValue("--accent").trim() || "#53b7e8";
    const panel = styles.getPropertyValue("--chart-panel").trim() || "#0d141c";
    const grid = styles.getPropertyValue("--line").trim() || "#22303d";
    const text = styles.getPropertyValue("--muted").trim() || "#9aa7b3";
    const dimmed = statusRef.current === "connected" ? 1 : 0.34;

    ctx.save();
    ctx.beginPath();
    ctx.rect(viewport.plot.left, viewport.plot.top, viewport.plot.width, viewport.plot.height);
    ctx.clip();
    const cellWidth = footprintCellWidth(viewport);
    drawFootprintCells(ctx, footprint, viewport, up, down, text, dimmed, cellWidth);
    drawDeltaRibbon(ctx, footprint, viewport, up, down, accent, panel, grid, dimmed);
    drawFootprintInsights(ctx, insights, viewport, cellWidth, up, down, accent, panel, dimmed);
    ctx.restore();
    const candidates = evaluateMicrostructureAlerts({ symbol, trades: tradesRef.current, footprint, insights, settings: alertSettings });
    const fresh = candidates.filter((event) => {
      if (alertSeenRef.current.has(event.id)) return false;
      alertSeenRef.current.add(event.id);
      return true;
    });
    if (fresh.length > 0) {
      const newest = [...fresh].sort((left, right) => right.time - left.time);
      setAlertEvents((current) => [...newest, ...current].slice(0, 8));
      if (alertSettings.sound) playAlertBeep();
      if (alertSettings.desktopNotifications) {
        for (const event of newest.slice(0, 3)) {
          showSystemNotification(`${symbol} · ${t("microstructureAlert")}`, microstructureNotificationBody(event, t), event.id);
        }
      }
    }
    const nextMeta = { imbalances: insights.imbalances.length, stacks: insights.stacks.length, absorptions: insights.absorptions.length };
    const previous = insightMetaRef.current;
    const now = Date.now();
    if (!sameInsightMeta(nextMeta, previous)) {
      pendingInsightMetaRef.current = nextMeta;
      const remaining = 1_000 - (now - lastInsightMetaAtRef.current);
      if (remaining <= 0) {
        if (insightMetaTimerRef.current !== undefined) window.clearTimeout(insightMetaTimerRef.current);
        insightMetaTimerRef.current = undefined;
        pendingInsightMetaRef.current = undefined;
        publishInsightMeta(nextMeta, insightMetaRef, lastInsightMetaAtRef, setInsightMeta);
      }
      else if (insightMetaTimerRef.current === undefined) {
        insightMetaTimerRef.current = window.setTimeout(() => {
          insightMetaTimerRef.current = undefined;
          const pending = pendingInsightMetaRef.current;
          pendingInsightMetaRef.current = undefined;
          if (pending) publishInsightMeta(pending, insightMetaRef, lastInsightMetaAtRef, setInsightMeta);
        }, remaining);
      }
    }
  }, [alertSettings, candles, enabled, locale, symbol, viewportRef]);

  const scheduleDraw = useCallback(() => {
    if (rafRef.current !== undefined) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = undefined;
      draw();
    });
  }, [draw]);

  useEffect(() => { scheduleDraw(); }, [renderKey, scheduleDraw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !enabled) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!resizeCanvasToEntry(canvas, entry)) return;
      scheduleDraw();
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [enabled, scheduleDraw]);

  useEffect(() => {
    tradesRef.current = [];
    seenRef.current.clear();
    if (!enabled) return;
    let socket: WebSocket | undefined;
    let stopped = false;
    let skipped = false;
    let reconnectTimer: number | undefined;
    let staleTimer: number | undefined;
    let attempts = 0;
    let lastTradeAt = 0;
    let lastMetaAt = 0;

    const paused = () => document.hidden || skipped;
    const setStatus = (status: FlowMeta["status"], message: string) => {
      statusRef.current = status;
      setMeta((current) => ({ ...current, status, message }));
      scheduleDraw();
    };
    const resetObservation = () => {
      tradesRef.current = [];
      seenRef.current.clear();
      alertSeenRef.current.clear();
      setAlertEvents([]);
      lastTradeAt = 0;
      setMeta((current) => ({ ...current, prints: 0, buyNotional: 0, sellNotional: 0 }));
      insightMetaRef.current = { imbalances: 0, stacks: 0, absorptions: 0 };
      pendingInsightMetaRef.current = undefined;
      if (insightMetaTimerRef.current !== undefined) window.clearTimeout(insightMetaTimerRef.current);
      insightMetaTimerRef.current = undefined;
      setInsightMeta(insightMetaRef.current);
    };
    const connect = () => {
      if (stopped || paused()) return;
      if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
      setStatus(attempts > 0 ? "reconnecting" : "connecting", "");
      const currentSocket = createTradeFlowSocket(symbol, exchange);
      socket = currentSocket;
      currentSocket.onopen = () => { attempts = 0; };
      currentSocket.onmessage = (event) => {
        let message: TradeFlowStreamMessage;
        try { message = parseTradeFlowStreamMessage(JSON.parse(String(event.data))); }
        catch { setStatus("error", "Invalid trade flow message"); return; }
        if (message.type === "error") { setStatus("error", message.message); return; }
        if (message.type === "trade_flow_status") { setStatus(message.status, message.message); return; }
        if (message.symbol !== symbol || message.exchange !== exchange) return;
        const now = Date.now();
        lastTradeAt = now;
        const unique = message.trades.filter((trade) => {
          if (seenRef.current.has(trade.id)) return false;
          seenRef.current.add(trade.id);
          return true;
        });
        if (unique.length === 0) return;
        const cutoff = now - RETENTION_MS;
        tradesRef.current = [...tradesRef.current, ...unique].filter((trade) => trade.exchangeTs >= cutoff).slice(-MAX_TRADES);
        if (seenRef.current.size > MAX_TRADES * 2) seenRef.current = new Set(tradesRef.current.map((trade) => trade.id));
        statusRef.current = "connected";
        if (now - lastMetaAt >= 1_000 || lastMetaAt === 0) {
          lastMetaAt = now;
          let buyNotional = 0;
          let sellNotional = 0;
          for (const trade of tradesRef.current) {
            if (trade.side === "buy") buyNotional += trade.price * trade.size;
            else sellNotional += trade.price * trade.size;
          }
          setMeta({ status: "connected", message: `${exchange} public trades`, prints: tradesRef.current.length, buyNotional, sellNotional });
        }
        scheduleDraw();
      };
      currentSocket.onclose = () => {
        if (currentSocket !== socket || stopped || paused()) return;
        resetObservation();
        attempts += 1;
        setStatus("reconnecting", "Backend trade flow disconnected");
        reconnectTimer = window.setTimeout(connect, Math.min(15_000, 500 * 2 ** Math.min(attempts, 5)));
      };
      currentSocket.onerror = () => setStatus("error", "Backend trade flow error");
    };
    const updateOperationalVisibility = () => {
      if (paused()) {
        if (reconnectTimer) window.clearTimeout(reconnectTimer);
        socket?.close();
        setStatus("paused", "Chart is not being rendered");
      } else if (!socket || socket.readyState >= WebSocket.CLOSING) {
        resetObservation();
        connect();
      }
    };
    const onDocumentVisibility = () => updateOperationalVisibility();
    const onContentVisibility = (event: Event) => {
      skipped = Boolean((event as Event & { skipped?: boolean }).skipped);
      updateOperationalVisibility();
    };

    connect();
    document.addEventListener("visibilitychange", onDocumentVisibility);
    const root = rootRef.current;
    root?.addEventListener("contentvisibilityautostatechange", onContentVisibility);
    let intersection: IntersectionObserver | undefined;
    if (!("contentVisibility" in document.documentElement.style) && root) {
      intersection = new IntersectionObserver(([entry]) => {
        skipped = !entry.isIntersecting;
        updateOperationalVisibility();
      }, { rootMargin: "200px" });
      intersection.observe(root);
    }
    staleTimer = window.setInterval(() => {
      if (lastTradeAt > 0 && Date.now() - lastTradeAt > 15_000 && statusRef.current === "connected") {
        setStatus("stale", "No public trade received for 15 seconds");
      }
    }, 1_000);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onDocumentVisibility);
      root?.removeEventListener("contentvisibilityautostatechange", onContentVisibility);
      intersection?.disconnect();
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (staleTimer) window.clearInterval(staleTimer);
      socket?.close();
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
      if (insightMetaTimerRef.current !== undefined) window.clearTimeout(insightMetaTimerRef.current);
    };
  }, [enabled, exchange, scheduleDraw, symbol]);

  if (!enabled) return null;
  const statusLabel = meta.status === "connected" ? t("flowLive")
    : meta.status === "connecting" ? t("flowConnecting")
      : meta.status === "reconnecting" ? t("flowReconnecting")
        : meta.status === "stale" ? t("flowStale")
          : meta.status === "paused" ? t("flowPaused") : t("flowError");
  const deltaPct = tradeFlowDeltaPercent(meta.buyNotional, meta.sellNotional);
  return (
    <>
      <div ref={rootRef} className="trade-footprint-layer">
        <canvas ref={canvasRef} className="chart-canvas chart-canvas-layer trade-footprint-canvas" aria-hidden="true" />
        <div className={`trade-footprint-badge ${meta.status}`} role="status" title={meta.message} aria-label={`${t("tradeFootprint")}: ${statusLabel}; ${t("tradeDelta")} ${deltaPct.toFixed(1)}%; ${insightMeta.imbalances} ${t("imbalances")}; ${insightMeta.stacks} ${t("stacks")}; ${insightMeta.absorptions} ${t("potentialAbsorptions")}`}>
          <strong>FOOTPRINT · {exchange.toUpperCase()} · LIVE</strong>
          <span>{statusLabel} · Δ <b className={deltaPct >= 0 ? "up" : "down"}>{deltaPct >= 0 ? "+" : ""}{deltaPct.toFixed(1)}%</b></span>
          {meta.prints > 0 && <small>{meta.prints} {t("prints")} · {formatCompact(meta.buyNotional + meta.sellNotional)}</small>}
          {meta.prints > 0 && <small className="trade-footprint-insights">{insightMeta.imbalances} {t("imbalances")} · {insightMeta.stacks} {t("stacks")} · {insightMeta.absorptions} ABS?</small>}
        </div>
      </div>
      <TradeFlowAlertCenter
        locale={locale}
        timeZone={timeZone}
        settings={alertSettings}
        events={alertEvents}
        onSettingsChange={(patch) => setAlertSettings((current) => ({ ...current, ...patch }))}
        onDismiss={(id) => setAlertEvents((current) => current.filter((event) => event.id !== id))}
        onClear={() => setAlertEvents([])}
      />
    </>
  );
});

function drawFootprintCells(
  ctx: CanvasRenderingContext2D,
  footprint: ReturnType<typeof aggregateTradeFootprint>,
  viewport: Viewport,
  up: string,
  down: string,
  text: string,
  dimmed: number,
  width: number
) {
  if (footprint.maxCellNotional <= 0) return;
  const logMax = Math.log1p(footprint.maxCellNotional);
  const half = width / 2;
  for (const cell of footprint.cells) {
    const sellIntensity = Math.log1p(cell.sellNotional) / logMax;
    const buyIntensity = Math.log1p(cell.buyNotional) / logMax;
    if (cell.sellNotional > 0) {
      ctx.globalAlpha = (0.08 + sellIntensity * 0.5) * dimmed;
      ctx.fillStyle = down;
      ctx.fillRect(cell.x - half, cell.y - 4, half, 8);
    }
    if (cell.buyNotional > 0) {
      ctx.globalAlpha = (0.08 + buyIntensity * 0.5) * dimmed;
      ctx.fillStyle = up;
      ctx.fillRect(cell.x, cell.y - 4, half, 8);
    }
    if (viewport.barSpacing >= 24 && Math.max(cell.buyNotional, cell.sellNotional) >= footprint.maxCellNotional * 0.08) {
      ctx.globalAlpha = 0.88 * dimmed;
      ctx.fillStyle = text;
      ctx.font = "8px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const label = `${formatFootprintValue(cell.sellNotional)}×${formatFootprintValue(cell.buyNotional)}`;
      const halfLabel = ctx.measureText(label).width / 2;
      const labelX = Math.max(viewport.plot.left + halfLabel + 3, Math.min(viewport.plot.right - halfLabel - 3, cell.x));
      ctx.fillText(label, labelX, cell.y);
    }
  }
}

function footprintCellWidth(viewport: Viewport) {
  return Math.min(52, Math.max(8, viewport.barSpacing * (viewport.barSpacing >= 24 ? 1.35 : 0.86)));
}

function sameInsightMeta(left: InsightMeta, right: InsightMeta) {
  return left.imbalances === right.imbalances && left.stacks === right.stacks && left.absorptions === right.absorptions;
}

function publishInsightMeta(
  value: InsightMeta,
  current: { current: InsightMeta },
  lastPublishedAt: { current: number },
  publish: (value: InsightMeta) => void
) {
  current.current = value;
  lastPublishedAt.current = Date.now();
  publish(value);
}

function microstructureNotificationBody(event: MicrostructureAlertEvent, t: (key: Parameters<typeof shellText>[1]) => string) {
  const side = event.side === "buy" ? t("buyAggression") : event.side === "sell" ? t("sellAggression") : "";
  if (event.kind === "stacked_imbalance") return `${side} · ${t("stackedImbalance")} ${event.value}×`;
  if (event.kind === "potential_absorption") return `${side} · ${t("potentialAbsorptionShort")} Δ ${event.value.toFixed(0)}%`;
  if (event.kind === "cvd_spike") return `${side} · ${t("cvdSpike")} ${event.value.toFixed(0)}%`;
  return `${side} · ${t("largePrint")} ${event.value.toFixed(0)}`;
}

function drawDeltaRibbon(
  ctx: CanvasRenderingContext2D,
  footprint: ReturnType<typeof aggregateTradeFootprint>,
  viewport: Viewport,
  up: string,
  down: string,
  accent: string,
  panel: string,
  grid: string,
  dimmed: number
) {
  if (footprint.bars.length === 0 || footprint.maxAbsDelta <= 0) return;
  const height = Math.min(84, Math.max(48, viewport.plot.height * 0.16));
  const top = viewport.plot.bottom - height;
  const baseline = top + height / 2;
  ctx.globalAlpha = 0.76 * dimmed;
  ctx.fillStyle = panel;
  ctx.fillRect(viewport.plot.left, top, viewport.plot.width, height);
  ctx.globalAlpha = 0.55 * dimmed;
  ctx.strokeStyle = grid;
  ctx.beginPath();
  ctx.moveTo(viewport.plot.left, baseline);
  ctx.lineTo(viewport.plot.right, baseline);
  ctx.stroke();
  const latest = footprint.bars.at(-1);
  ctx.globalAlpha = 0.72 * dimmed;
  ctx.fillStyle = accent;
  ctx.font = "9px ui-monospace, monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("LIVE Δ / CVD", viewport.plot.left + 6, top + 5);
  if (latest) {
    ctx.textAlign = "right";
    ctx.fillStyle = latest.delta >= 0 ? up : down;
    ctx.fillText(`${latest.delta >= 0 ? "+" : ""}${formatCompact(latest.delta)}`, viewport.plot.right - 6, top + 5);
  }
  const barWidth = Math.max(2, Math.min(18, viewport.barSpacing * 0.62));
  const maxCumulative = Math.max(...footprint.bars.map((bar) => Math.abs(bar.cumulative)), 1);
  ctx.beginPath();
  for (const [index, bar] of footprint.bars.entries()) {
    const barHeight = Math.max(1, Math.abs(bar.delta) / footprint.maxAbsDelta * (height / 2 - 5));
    ctx.globalAlpha = 0.5 * dimmed;
    ctx.fillStyle = bar.delta >= 0 ? up : down;
    ctx.fillRect(bar.x - barWidth / 2, bar.delta >= 0 ? baseline - barHeight : baseline, barWidth, barHeight);
    const y = baseline - (bar.cumulative / maxCumulative) * (height / 2 - 6);
    if (index === 0) ctx.moveTo(bar.x, y);
    else ctx.lineTo(bar.x, y);
  }
  ctx.globalAlpha = 0.9 * dimmed;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.25;
  ctx.stroke();
}

function formatCompact(value: number) {
  const sign = value < 0 ? "−" : "";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${sign}${(absolute / 1_000_000_000).toFixed(1)}B`;
  if (absolute >= 1_000_000) return `${sign}${(absolute / 1_000_000).toFixed(1)}M`;
  if (absolute >= 1_000) return `${sign}${(absolute / 1_000).toFixed(1)}K`;
  return absolute > 0 ? `${sign}${absolute.toFixed(absolute < 10 ? 1 : 0)}` : "—";
}

function formatFootprintValue(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return value > 0 ? value.toFixed(value < 10 ? 1 : 0) : "0";
}
