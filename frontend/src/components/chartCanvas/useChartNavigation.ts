import { useCallback, useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { visibleCandles } from "../../chart/scales";
import type { PriceMode, Viewport } from "../../chart/types";
import type { Candle } from "../../types";

export const MIN_CHART_ZOOM = 0.4;
export const MAX_CHART_ZOOM = 4;
export const CHART_LONG_PRESS_DELAY_MS = 500;
export const CHART_TOUCH_MOVEMENT_SLOP_PX = 10;
const WHEEL_DEAD_ZONE = 0.35;

export interface ChartNavigationView {
  zoom: number;
  offset: number;
  crosshair?: { x: number; y: number };
  priceMode: PriceMode;
  priceZoom: number;
}

interface WheelFrame {
  deltaX: number;
  deltaY: number;
  cursorX: number;
  ctrlKey: boolean;
  shiftKey: boolean;
}

interface NavigationInput extends WheelFrame {
  view: ChartNavigationView;
  candles: Candle[];
  viewport?: Viewport;
}

export interface ChartTouchPoint {
  x: number;
  y: number;
}

export type ChartTouchMode = "idle" | "pending-pan" | "pan" | "inspect" | "pending-draw" | "draw" | "edit" | "measure" | "pinch";

export interface ChartPinchGesture {
  anchorIndex: number;
  startDistance: number;
  startOffset: number;
  startZoom: number;
}

interface PinchNavigationInput {
  gesture: ChartPinchGesture;
  points: readonly [ChartTouchPoint, ChartTouchPoint];
  view: ChartNavigationView;
  candles: Candle[];
  viewport?: Viewport;
}

interface ChartTouchNavigationCallbacks {
  onPinchStart?: () => void;
  onPinchEnd?: () => void;
  onSingleTouchResume?: (pointerId: number, point: ChartTouchPoint, offset: number) => void;
  onReset?: (reason: "pointercancel" | "lostpointercapture") => void;
}

export function chartTouchMovementExceeded(start: ChartTouchPoint, current: ChartTouchPoint, slop = CHART_TOUCH_MOVEMENT_SLOP_PX) {
  return Math.hypot(current.x - start.x, current.y - start.y) > Math.max(0, slop);
}

/** Apply one normalized/coalesced trackpad or mouse-wheel frame. */
export function applyChartWheelNavigation(input: NavigationInput): ChartNavigationView {
  const { view, candles, viewport } = input;
  if (!viewport || candles.length === 0) return zoomOnly(view, input.deltaY, input.ctrlKey);
  const horizontalDelta = input.shiftKey && Math.abs(input.deltaX) < Math.abs(input.deltaY) ? input.deltaY : input.deltaX;
  const horizontal = Math.abs(horizontalDelta) > Math.abs(input.deltaY) * 1.15 || input.shiftKey;
  if (horizontal && Math.abs(horizontalDelta) >= WHEEL_DEAD_ZONE) {
    const bars = clamp(horizontalDelta, -120, 120) / viewport.barSpacing;
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

/** Capture the data-space anchor below the midpoint of a two-finger gesture. */
export function beginChartPinchGesture(
  points: readonly [ChartTouchPoint, ChartTouchPoint],
  view: ChartNavigationView,
  viewport: Viewport
): ChartPinchGesture {
  const distance = touchDistance(points);
  const midpoint = midpointX(points);
  const anchorIndex = viewport.xToIndex(midpoint);
  return {
    anchorIndex: Number.isFinite(anchorIndex) ? anchorIndex : viewport.start,
    startDistance: Number.isFinite(distance) ? Math.max(8, distance) : 8,
    startOffset: finiteOr(view.offset, 0),
    startZoom: clamp(finiteOr(view.zoom, 1), MIN_CHART_ZOOM, MAX_CHART_ZOOM)
  };
}

/** Apply simultaneous touch pinch and horizontal pan while keeping the midpoint data-anchored. */
export function applyChartPinchNavigation(input: PinchNavigationInput): ChartNavigationView {
  const { gesture, points, view, candles, viewport } = input;
  const distance = touchDistance(points);
  if (!Number.isFinite(distance) || !Number.isFinite(gesture.startDistance) || gesture.startDistance <= 0) return withoutCrosshair(view);
  const distanceRatio = distance / gesture.startDistance;
  const zoom = Number(clamp(gesture.startZoom * distanceRatio, MIN_CHART_ZOOM, MAX_CHART_ZOOM).toFixed(4));
  if (!viewport || candles.length === 0) return zoom === view.zoom ? withoutCrosshair(view) : { ...view, zoom, crosshair: undefined };

  const nextVisible = visibleCandles(candles, viewport.plot, zoom, gesture.startOffset);
  const midpoint = midpointX(points);
  if (!Number.isFinite(midpoint) || !Number.isFinite(gesture.anchorIndex)) return withoutCrosshair(view);
  const desiredStart = gesture.anchorIndex - (midpoint - viewport.plot.left - nextVisible.step / 2) / nextVisible.step;
  const offset = candles.length - nextVisible.data.length - desiredStart;
  const nextOffset = clamp(Math.round(offset), 0, nextVisible.maxOffset);
  if (zoom === view.zoom && nextOffset === view.offset && view.crosshair === undefined) return view;
  return {
    ...view,
    zoom,
    offset: nextOffset,
    crosshair: undefined
  };
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
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? rect.height : 1;
      const next = {
        deltaX: event.deltaX * unit,
        deltaY: event.deltaY * unit,
        cursorX: event.clientX - rect.left,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
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

export function useChartTouchNavigation(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  viewportRef: RefObject<Viewport | undefined>,
  candles: Candle[],
  view: ChartNavigationView,
  setView: Dispatch<SetStateAction<ChartNavigationView>>,
  callbacks: ChartTouchNavigationCallbacks = {}
) {
  const candlesRef = useRef(candles);
  const viewRef = useRef(view);
  const callbacksRef = useRef(callbacks);
  const resetRef = useRef<() => void>(() => undefined);
  candlesRef.current = candles;
  viewRef.current = view;
  callbacksRef.current = callbacks;
  const gestureActiveRef = useRef(false);
  const reset = useCallback(() => resetRef.current(), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const points = new Map<number, ChartTouchPoint>();
    let gesture: ChartPinchGesture | undefined;
    let disposed = false;

    const pointFromEvent = (event: PointerEvent): ChartTouchPoint => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const pair = (): [ChartTouchPoint, ChartTouchPoint] | undefined => {
      const current = [...points.values()];
      return current.length >= 2 ? [current[0], current[1]] : undefined;
    };
    const contain = (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const resetState = () => {
      const captured = [...points.keys()];
      points.clear();
      gesture = undefined;
      gestureActiveRef.current = false;
      for (const pointerId of captured) {
        try {
          if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
        } catch {
          // The browser may already have released a cancelled pointer.
        }
      }
    };
    resetRef.current = resetState;
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      if (gesture || points.size >= 2) {
        contain(event);
        return;
      }
      points.set(event.pointerId, pointFromEvent(event));
      const currentPair = pair();
      if (!currentPair) return;
      contain(event);
      if (!viewportRef.current) return;
      if (!canvas.hasPointerCapture(event.pointerId)) {
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch {
          points.delete(event.pointerId);
          return;
        }
      }
      gesture = beginChartPinchGesture(currentPair, viewRef.current, viewportRef.current);
      gestureActiveRef.current = true;
      callbacksRef.current.onPinchStart?.();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      if (!points.has(event.pointerId)) {
        if (gesture) contain(event);
        return;
      }
      points.set(event.pointerId, pointFromEvent(event));
      const currentPair = pair();
      if (!gesture || !currentPair) return;
      // React may evaluate a functional state updater after pointerup has
      // cleared the mutable gesture variable. Snapshot the gesture for this
      // frame so a fast/coalesced mobile sequence cannot read undefined.
      const activeGesture = gesture;
      contain(event);
      setView((current) => {
        const next = applyChartPinchNavigation({
          gesture: activeGesture,
          points: currentPair,
          view: current,
          candles: candlesRef.current,
          viewport: viewportRef.current ?? undefined
        });
        viewRef.current = next;
        return next;
      });
    };
    const finishPointer = (event: PointerEvent, resume: boolean) => {
      if (event.pointerType !== "touch" || !points.has(event.pointerId)) return;
      const wasGesture = gesture !== undefined;
      points.delete(event.pointerId);
      if (!wasGesture) return;
      contain(event);
      gesture = undefined;
      gestureActiveRef.current = false;
      callbacksRef.current.onPinchEnd?.();
      const remaining = resume ? points.entries().next().value as [number, ChartTouchPoint] | undefined : undefined;
      if (remaining !== undefined) {
        queueMicrotask(() => {
          if (!disposed && points.size === 1 && points.has(remaining[0]) && gesture === undefined) {
            callbacksRef.current.onSingleTouchResume?.(remaining[0], remaining[1], viewRef.current.offset);
          }
        });
      }
    };
    const onPointerUp = (event: PointerEvent) => finishPointer(event, true);
    const onPointerCancel = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || !points.has(event.pointerId)) return;
      contain(event);
      resetState();
      callbacksRef.current.onReset?.("pointercancel");
    };
    const onLostPointerCapture = (event: PointerEvent) => {
      if (!points.has(event.pointerId)) return;
      resetState();
      callbacksRef.current.onReset?.("lostpointercapture");
    };

    canvas.addEventListener("pointerdown", onPointerDown, { passive: false });
    canvas.addEventListener("pointermove", onPointerMove, { passive: false });
    canvas.addEventListener("pointerup", onPointerUp, { passive: false });
    canvas.addEventListener("pointercancel", onPointerCancel, { passive: false });
    canvas.addEventListener("lostpointercapture", onLostPointerCapture);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("lostpointercapture", onLostPointerCapture);
      disposed = true;
      resetState();
      resetRef.current = () => undefined;
    };
  }, [canvasRef, setView, viewportRef]);

  return { gestureActiveRef, reset };
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

function midpointX(points: readonly [ChartTouchPoint, ChartTouchPoint]) {
  return (points[0].x + points[1].x) / 2;
}

function touchDistance(points: readonly [ChartTouchPoint, ChartTouchPoint]) {
  return Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
}

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function withoutCrosshair(view: ChartNavigationView): ChartNavigationView {
  return view.crosshair === undefined ? view : { ...view, crosshair: undefined };
}
