import { parseOrderBookStreamMessage } from "@saltanatbotv2/contracts";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { buildHeatmapCells, orderBookSpreadBps, type OrderBookFrame } from "../../chart/orderBookHeatmap";
import type { OrderBookSnapshotMessage, OrderBookStatus, OrderBookStreamMessage, DataExchange } from "../../types";
import type { Viewport } from "../../chart/types";
import { createOrderBookSocket } from "../../api/marketClient";
import type { Locale } from "../../i18n";
import { shellText } from "../../i18n/shell";
import { prepareCanvasContext, resizeCanvasToEntry } from "../../chart/canvasDensity";

interface HeatmapMeta {
  status: OrderBookStatus | "paused";
  message: string;
  spreadBps?: number;
  levels: number;
}

export const OrderBookHeatmapLayer = memo(function OrderBookHeatmapLayer({
  enabled,
  symbol,
  exchange,
  locale,
  viewportRef,
  renderKey
}: {
  enabled: boolean;
  symbol: string;
  exchange: DataExchange;
  locale: Locale;
  viewportRef: { current: Viewport | undefined };
  renderKey: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const framesRef = useRef<OrderBookFrame[]>([]);
  const latestRef = useRef<OrderBookSnapshotMessage>();
  const statusRef = useRef<HeatmapMeta["status"]>("connecting");
  const rafRef = useRef<number>();
  const [meta, setMeta] = useState<HeatmapMeta>({ status: "connecting", message: "", levels: 0 });
  const t = (key: Parameters<typeof shellText>[1]) => shellText(locale, key);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport || !enabled) return;
    const surface = prepareCanvasContext(canvas);
    if (!surface) return;
    const { ctx } = surface;
    ctx.clearRect(0, 0, surface.width, surface.height);
    const { plot } = viewport;
    const stripWidth = Math.max(120, Math.min(240, plot.width * 0.25));
    const stripLeft = plot.right - stripWidth;
    const now = Date.now();
    const rows = buildHeatmapCells(framesRef.current, viewport.priceToY, now);
    const styles = getComputedStyle(canvas);
    const up = styles.getPropertyValue("--up").trim() || "#23b99a";
    const down = styles.getPropertyValue("--down").trim() || "#ef6a65";
    const line = styles.getPropertyValue("--line").trim() || "#22303d";
    const dimmed = statusRef.current === "connected" ? 1 : 0.34;

    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.left, plot.top, plot.width, plot.height);
    ctx.clip();
    ctx.globalAlpha = 0.3 * dimmed;
    ctx.fillStyle = styles.getPropertyValue("--chart-panel").trim() || "#0d141c";
    ctx.fillRect(stripLeft, plot.top, stripWidth, plot.height);

    drawCurrentLadder(ctx, latestRef.current, viewport, stripLeft, stripWidth, up, down, dimmed);
    const logMax = Math.log1p(rows.maxNotional);
    for (const cell of rows.cells) {
      if (cell.y < plot.top - 3 || cell.y > plot.bottom + 3) continue;
      const intensity = logMax > 0 ? Math.log1p(cell.notional) / logMax : 0;
      ctx.globalAlpha = (0.1 + intensity * 0.54) * dimmed;
      ctx.fillStyle = cell.side === "bid" ? up : down;
      ctx.fillRect(stripLeft + cell.x * stripWidth, cell.y - 2, Math.max(1.5, cell.width * stripWidth + 0.8), 4);
    }

    const latest = latestRef.current;
    const bestBid = latest?.bids[0]?.[0];
    const bestAsk = latest?.asks[0]?.[0];
    if (bestBid && bestAsk) {
      const bidY = viewport.priceToY(bestBid);
      const askY = viewport.priceToY(bestAsk);
      ctx.globalAlpha = 0.08 * dimmed;
      ctx.fillStyle = styles.getPropertyValue("--accent").trim() || "#53b7e8";
      ctx.fillRect(stripLeft, Math.min(bidY, askY), stripWidth, Math.max(1, Math.abs(askY - bidY)));
    }
    ctx.globalAlpha = 0.65;
    ctx.strokeStyle = line;
    ctx.beginPath();
    ctx.moveTo(stripLeft, plot.top);
    ctx.lineTo(stripLeft, plot.bottom);
    ctx.stroke();
    ctx.restore();
  }, [enabled, viewportRef]);

  const scheduleDraw = useCallback(() => {
    if (!enabled || rafRef.current !== undefined) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = undefined;
      draw();
    });
  }, [draw, enabled]);

  useEffect(() => {
    scheduleDraw();
  }, [renderKey, scheduleDraw]);

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
    framesRef.current = [];
    latestRef.current = undefined;
    if (!enabled) return;
    let socket: WebSocket | undefined;
    let stopped = false;
    let reconnectTimer: number | undefined;
    let staleTimer: number | undefined;
    let attempts = 0;
    let lastSnapshotAt = 0;
    let lastMetaAt = 0;

    const setStatus = (status: HeatmapMeta["status"], message: string) => {
      statusRef.current = status;
      setMeta((current) => ({ ...current, status, message }));
      scheduleDraw();
    };

    const connect = () => {
      if (stopped || document.hidden) return;
      setStatus(attempts > 0 ? "reconnecting" : "connecting", "");
      const currentSocket = createOrderBookSocket(symbol, exchange);
      socket = currentSocket;
      currentSocket.onopen = () => { attempts = 0; };
      currentSocket.onmessage = (event) => {
        let message: OrderBookStreamMessage;
        try { message = parseOrderBookStreamMessage(JSON.parse(String(event.data))); }
        catch {
          setStatus("error", "Invalid order book message");
          return;
        }
        if (message.type === "error") {
          setStatus("error", message.message);
          return;
        }
        if (message.type === "orderbook_status") {
          setStatus(message.status, message.message);
          return;
        }
        if (message.symbol !== symbol || message.exchange !== exchange) return;
        const now = Date.now();
        lastSnapshotAt = now;
        const frame: OrderBookFrame = { ...message, capturedAt: now };
        latestRef.current = message;
        framesRef.current = [...framesRef.current.filter((item) => item.capturedAt >= now - 60_000), frame].slice(-300);
        const wasConnected = statusRef.current === "connected";
        statusRef.current = "connected";
        if (now - lastMetaAt >= 1_000 || !wasConnected) {
          lastMetaAt = now;
          setMeta({
            status: "connected",
            message: `${exchange} public depth`,
            spreadBps: orderBookSpreadBps(message),
            levels: message.bids.length + message.asks.length
          });
        }
        scheduleDraw();
      };
      currentSocket.onclose = () => {
        if (currentSocket !== socket || stopped || document.hidden) return;
        framesRef.current = [];
        latestRef.current = undefined;
        attempts += 1;
        setStatus("reconnecting", "Backend depth stream disconnected");
        reconnectTimer = window.setTimeout(connect, Math.min(15_000, 500 * 2 ** Math.min(attempts, 5)));
      };
      currentSocket.onerror = () => setStatus("error", "Backend depth stream error");
    };

    const onVisibility = () => {
      if (document.hidden) {
        if (reconnectTimer) window.clearTimeout(reconnectTimer);
        socket?.close();
        setStatus("paused", "Page hidden");
      } else {
        framesRef.current = [];
        latestRef.current = undefined;
        connect();
      }
    };

    connect();
    document.addEventListener("visibilitychange", onVisibility);
    staleTimer = window.setInterval(() => {
      if (lastSnapshotAt > 0 && Date.now() - lastSnapshotAt > 10_000 && statusRef.current === "connected") {
        setStatus("stale", "No depth snapshot for 10 seconds");
      }
    }, 1_000);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (staleTimer) window.clearInterval(staleTimer);
      socket?.close();
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
    };
  }, [enabled, exchange, scheduleDraw, symbol]);

  if (!enabled) return null;
  const statusLabel = meta.status === "connected" ? t("depthLive")
    : meta.status === "connecting" ? t("depthConnecting")
      : meta.status === "reconnecting" ? t("depthReconnecting")
        : meta.status === "stale" ? t("depthStale")
          : meta.status === "paused" ? t("depthPaused") : t("depthError");
  return (
    <>
      <canvas ref={canvasRef} className="chart-canvas chart-canvas-layer orderbook-heatmap-canvas" aria-hidden="true" />
      <div className={`orderbook-heatmap-badge ${meta.status}`} title={meta.message} aria-label={`${t("orderBookHeatmap")}: ${statusLabel}`}>
        <strong>DEPTH20 · {exchange.toUpperCase()} · 60s</strong>
        <span>{statusLabel}{meta.spreadBps !== undefined ? ` · ${t("spread")} ${formatSpread(meta.spreadBps)} bp` : ""}</span>
        {meta.levels > 0 && <small>{meta.levels} {t("levels")}</small>}
      </div>
    </>
  );
});

function drawCurrentLadder(
  ctx: CanvasRenderingContext2D,
  snapshot: OrderBookSnapshotMessage | undefined,
  viewport: Viewport,
  left: number,
  width: number,
  up: string,
  down: string,
  dimmed: number
) {
  if (!snapshot) return;
  const levels = [...snapshot.bids.map((level) => ({ level, side: "bid" as const })), ...snapshot.asks.map((level) => ({ level, side: "ask" as const }))];
  const grouped = new Map<string, { y: number; side: "bid" | "ask"; notional: number }>();
  for (const { level: [price, size], side } of levels) {
    const baseY = Math.floor(viewport.priceToY(price) / 3) * 3;
    const y = baseY + (side === "bid" ? 1.35 : -1.35);
    const key = `${side}:${baseY}`;
    const existing = grouped.get(key);
    if (existing) existing.notional += price * size;
    else grouped.set(key, { y, side, notional: price * size });
  }
  const max = Math.max(...[...grouped.values()].map((level) => level.notional), 0);
  const logMax = Math.log1p(max);
  if (logMax <= 0) return;
  for (const { y, side, notional } of grouped.values()) {
    const intensity = Math.log1p(notional) / logMax;
    const barWidth = width * (0.18 + intensity * 0.82);
    ctx.globalAlpha = (0.08 + intensity * 0.28) * dimmed;
    ctx.fillStyle = side === "bid" ? up : down;
    ctx.fillRect(left + width - barWidth, y - 2, barWidth, 4);
  }
}

function formatSpread(value: number) {
  return value < 0.01 ? value.toFixed(3) : value.toFixed(2);
}
