import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { visibleCandles } from "../../chart/scales";
import type { PriceMode, Viewport } from "../../chart/types";
import type { Candle } from "../../types";

export const MIN_CHART_ZOOM = 0.4;
export const MAX_CHART_ZOOM = 4;
const WHEEL_DEAD_ZONE = 0.35;

export interface ChartNavigationView {
  zoom: number;
  offset: number;
  crosshair?: { x: number; y: number };
  priceMode: PriceMode;
}

interface WheelFrame {
  deltaX: number;
  deltaY: number;
  cursorX: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  dpr: number;
}

interface NavigationInput extends WheelFrame {
  view: ChartNavigationView;
  candles: Candle[];
  viewport?: Viewport;
}

/** Apply one normalized/coalesced trackpad or mouse-wheel frame. */
export function applyChartWheelNavigation(input: NavigationInput): ChartNavigationView {
  const { view, candles, viewport } = input;
  if (!viewport || candles.length === 0) return zoomOnly(view, input.deltaY, input.ctrlKey);
  const horizontalDelta = input.shiftKey && Math.abs(input.deltaX) < Math.abs(input.deltaY) ? input.deltaY : input.deltaX;
  const horizontal = Math.abs(horizontalDelta) > Math.abs(input.deltaY) * 1.15 || input.shiftKey;
  if (horizontal && Math.abs(horizontalDelta) >= WHEEL_DEAD_ZONE) {
    const bars = clamp(horizontalDelta, -120, 120) * input.dpr / viewport.barSpacing;
    const currentVisible = visibleCandles(candles, viewport.plot, view.zoom, view.offset);
    return { ...view, offset: clamp(Math.round(view.offset - bars), 0, currentVisible.maxOffset) };
  }
  if (Math.abs(input.deltaY) < WHEEL_DEAD_ZONE) return view;

  const nextZoom = zoomValue(view.zoom, input.deltaY, input.ctrlKey);
  if (nextZoom === view.zoom) return view;
  const indexBefore = viewport.xToIndex(input.cursorX);
  const nextVisible = visibleCandles(candles, viewport.plot, nextZoom, view.offset);
  const desiredStart = indexBefore - (input.cursorX - viewport.plot.left - nextVisible.step / 2) / nextVisible.step;
  const offset = candles.length - nextVisible.data.length - desiredStart;
  return { ...view, zoom: nextZoom, offset: clamp(Math.round(offset), 0, nextVisible.maxOffset) };
}

export function useChartWheelNavigation(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  viewportRef: RefObject<Viewport | undefined>,
  candles: Candle[],
  setView: Dispatch<SetStateAction<ChartNavigationView>>
) {
  const candlesRef = useRef(candles);
  candlesRef.current = candles;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame = 0;
    let pending: WheelFrame | undefined;

    const flush = () => {
      frame = 0;
      const input = pending;
      pending = undefined;
      if (!input) return;
      setView((view) => applyChartWheelNavigation({ ...input, view, candles: candlesRef.current, viewport: viewportRef.current ?? undefined }));
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? rect.height : 1;
      const next = {
        deltaX: event.deltaX * unit,
        deltaY: event.deltaY * unit,
        cursorX: (event.clientX - rect.left) * dpr,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        dpr
      };
      pending = pending
        ? { ...next, deltaX: pending.deltaX + next.deltaX, deltaY: pending.deltaY + next.deltaY }
        : next;
      if (!frame) frame = requestAnimationFrame(flush);
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [canvasRef, setView, viewportRef]);
}

function zoomOnly(view: ChartNavigationView, deltaY: number, ctrlKey: boolean): ChartNavigationView {
  const zoom = zoomValue(view.zoom, deltaY, ctrlKey);
  return zoom === view.zoom ? view : { ...view, zoom };
}

function zoomValue(current: number, deltaY: number, ctrlKey: boolean) {
  if (Math.abs(deltaY) < WHEEL_DEAD_ZONE) return current;
  const sensitivity = ctrlKey ? 0.012 : 0.0018;
  return Number(clamp(current * Math.exp(-clamp(deltaY, -96, 96) * sensitivity), MIN_CHART_ZOOM, MAX_CHART_ZOOM).toFixed(4));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
