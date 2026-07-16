import { useCallback, useEffect, useRef, type Dispatch, type PointerEvent as ReactPointerEvent, type RefObject, type SetStateAction } from "react";
import { createDrawing, TOOL_POINT_COUNT, type Anchor, type DrawingObject, type DrawingTool, type ShapeTool } from "../../chart/drawings";
import { hitTest } from "../../chart/objects/hitTest";
import type { DraftDrawing, Viewport } from "../../chart/types";
import type { Candle } from "../../types";
import { clampIndex, moveDrawing, pointerPoint, snapAnchor, snapDrawingAnchor } from "./drawingInteraction";
import type { ChartCanvasProps } from "./types";
import { CHART_LONG_PRESS_DELAY_MS, chartTouchMovementExceeded, useChartTouchNavigation, type ChartNavigationView, type ChartTouchMode } from "./useChartNavigation";

type Interaction = { mode: "pan"; startX: number; startOffset: number } | { mode: "edit"; id: string; part: number | "body"; last: Anchor } | { mode: "measure"; start: Anchor } | undefined;

interface TouchSession {
  pointerId: number;
  intent: "navigate" | "draw";
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startOffset: number;
  hit?: { id: string; part: number | "body" };
  drawingTool?: ShapeTool;
}

interface UseChartPointerInteractionInput {
  chartId: string;
  displayCandles: Candle[];
  draft?: { tool: ShapeTool; points: Anchor[] };
  drawingsRef: RefObject<DrawingObject[]>;
  interactionCanvasRef: RefObject<HTMLCanvasElement | null>;
  magnet: boolean;
  onLinkedCrosshairChange?: ChartCanvasProps["onLinkedCrosshairChange"];
  resetKey: string;
  selectedId?: string;
  setDraft: Dispatch<SetStateAction<{ tool: ShapeTool; points: Anchor[] } | undefined>>;
  setDrawings: Dispatch<SetStateAction<DrawingObject[]>>;
  setHoverAnchor: Dispatch<SetStateAction<Anchor | undefined>>;
  setHoveredId: Dispatch<SetStateAction<string | undefined>>;
  setHoverIndex: Dispatch<SetStateAction<number | undefined>>;
  setMenu: Dispatch<SetStateAction<{ x: number; y: number; id?: string; price?: number } | undefined>>;
  setQuickMeasure: Dispatch<SetStateAction<DraftDrawing | undefined>>;
  setQuickMeasureActive: Dispatch<SetStateAction<boolean>>;
  setSelectedId: Dispatch<SetStateAction<string | undefined>>;
  setTool: Dispatch<SetStateAction<DrawingTool>>;
  setView: Dispatch<SetStateAction<ChartNavigationView>>;
  tool: DrawingTool;
  view: ChartNavigationView;
  viewportRef: RefObject<Viewport | undefined>;
}

export function useChartPointerInteraction({
  chartId,
  displayCandles,
  draft,
  drawingsRef,
  interactionCanvasRef,
  magnet,
  onLinkedCrosshairChange,
  resetKey,
  selectedId,
  setDraft,
  setDrawings,
  setHoverAnchor,
  setHoveredId,
  setHoverIndex,
  setMenu,
  setQuickMeasure,
  setQuickMeasureActive,
  setSelectedId,
  setTool,
  setView,
  tool,
  view,
  viewportRef
}: UseChartPointerInteractionInput) {
  const interactionRef = useRef<Interaction>();
  const touchSessionRef = useRef<TouchSession>();
  const touchModeRef = useRef<ChartTouchMode>("idle");
  const longPressTimerRef = useRef<number>();
  const expectedCaptureReleaseRef = useRef(new Set<number>());

  const updateTouchMode = useCallback(
    (next: ChartTouchMode) => {
      touchModeRef.current = next;
      if (interactionCanvasRef.current) interactionCanvasRef.current.dataset.touchMode = next;
    },
    [interactionCanvasRef]
  );

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current === undefined) return;
    window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = undefined;
  }, []);

  const resetTouchTransient = useCallback(() => {
    clearLongPressTimer();
    touchSessionRef.current = undefined;
    interactionRef.current = undefined;
    setDraft(undefined);
    setHoverAnchor(undefined);
    setQuickMeasure(undefined);
    setQuickMeasureActive(false);
    setHoveredId(undefined);
    setHoverIndex(undefined);
    setMenu(undefined);
    setView((current) => (current.crosshair === undefined ? current : { ...current, crosshair: undefined }));
    onLinkedCrosshairChange?.();
    updateTouchMode("idle");
  }, [clearLongPressTimer, onLinkedCrosshairChange, setDraft, setHoverAnchor, setHoveredId, setHoverIndex, setMenu, setQuickMeasure, setQuickMeasureActive, setView, updateTouchMode]);

  const updateTouchCrosshair = useCallback(
    (x: number, y: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const index = clampIndex(Math.round(viewport.xToIndex(x)), displayCandles.length);
      setHoverIndex(index);
      setView((current) => ({ ...current, crosshair: { x, y } }));
      const candle = displayCandles[index];
      if (candle) onLinkedCrosshairChange?.({ sourceId: chartId, time: candle.time, price: viewport.yToPrice(y) });
    },
    [chartId, displayCandles, onLinkedCrosshairChange, setHoverIndex, setView, viewportRef]
  );

  const { gestureActiveRef, reset: resetTouchNavigation } = useChartTouchNavigation(interactionCanvasRef, viewportRef, displayCandles, view, setView, {
    onPinchStart: () => {
      clearLongPressTimer();
      touchSessionRef.current = undefined;
      interactionRef.current = undefined;
      setHoverAnchor(undefined);
      setQuickMeasure(undefined);
      setQuickMeasureActive(false);
      updateTouchMode("pinch");
    },
    onPinchEnd: () => updateTouchMode("idle"),
    onSingleTouchResume: (pointerId, point, offset) => {
      touchSessionRef.current = {
        pointerId,
        intent: "navigate",
        startX: point.x,
        startY: point.y,
        lastX: point.x,
        lastY: point.y,
        startOffset: offset
      };
      interactionRef.current = { mode: "pan", startX: point.x, startOffset: offset };
      updateTouchMode("pan");
    },
    onReset: resetTouchTransient
  });

  useEffect(() => {
    const resetForOrientationChange = () => {
      resetTouchNavigation();
      resetTouchTransient();
    };
    window.addEventListener("orientationchange", resetForOrientationChange);
    return () => window.removeEventListener("orientationchange", resetForOrientationChange);
  }, [resetTouchNavigation, resetTouchTransient]);

  useEffect(() => {
    resetTouchNavigation();
    resetTouchTransient();
  }, [resetKey, resetTouchNavigation, resetTouchTransient]);

  useEffect(() => () => clearLongPressTimer(), [clearLongPressTimer]);

  const commitTouchDrawing = (session: TouchSession, x: number, y: number) => {
    const viewport = viewportRef.current;
    const drawingTool = session.drawingTool;
    if (!viewport || !drawingTool) return;
    const anchor = snapDrawingAnchor(drawingTool, viewport, displayCandles, x, y, magnet);
    const committed = draft && draft.tool === drawingTool ? [...draft.points, anchor] : [anchor];
    if (committed.length >= TOOL_POINT_COUNT[drawingTool]) {
      const object = createDrawing(drawingTool, committed);
      setDrawings((current) => [...current, object]);
      setDraft(undefined);
      setHoverAnchor(undefined);
      setSelectedId(object.id);
      setTool("cursor");
    } else {
      setDraft({ tool: drawingTool, points: committed });
      setHoverAnchor(undefined);
    }
  };

  const scheduleLongPress = (pointerId: number) => {
    clearLongPressTimer();
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = undefined;
      const session = touchSessionRef.current;
      if (!session || session.pointerId !== pointerId || touchModeRef.current !== "pending-pan") return;
      if (chartTouchMovementExceeded({ x: session.startX, y: session.startY }, { x: session.lastX, y: session.lastY })) return;
      interactionRef.current = undefined;
      updateTouchMode("inspect");
      updateTouchCrosshair(session.lastX, session.lastY);
    }, CHART_LONG_PRESS_DELAY_MS);
  };

  const releaseExpectedCapture = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    expectedCaptureReleaseRef.current.add(event.pointerId);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } finally {
      window.setTimeout(() => expectedCaptureReleaseRef.current.delete(event.pointerId), 0);
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      resetTouchTransient();
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) return;
    const { x, y } = pointerPoint(event);

    if (event.pointerType === "touch") {
      clearLongPressTimer();
      interactionRef.current = undefined;
      setQuickMeasure(undefined);
      setQuickMeasureActive(false);

      if (tool !== "cursor") {
        touchSessionRef.current = {
          pointerId: event.pointerId,
          intent: "draw",
          drawingTool: tool,
          startX: x,
          startY: y,
          lastX: x,
          lastY: y,
          startOffset: view.offset
        };
        if (draft?.tool === tool) setHoverAnchor(snapDrawingAnchor(tool, viewport, displayCandles, x, y, magnet));
        updateTouchMode("pending-draw");
        return;
      }

      const hit = hitTest(viewport, drawingsRef.current ?? [], x, y, selectedId);
      if (hit) setSelectedId(hit.id);
      else setSelectedId(undefined);
      touchSessionRef.current = {
        pointerId: event.pointerId,
        intent: "navigate",
        startX: x,
        startY: y,
        lastX: x,
        lastY: y,
        startOffset: view.offset,
        hit: hit ?? undefined
      };
      updateTouchMode("pending-pan");
      scheduleLongPress(event.pointerId);
      return;
    }

    if (tool !== "cursor") {
      const anchor = snapDrawingAnchor(tool, viewport, displayCandles, x, y, magnet);
      const committed = draft && draft.tool === tool ? [...draft.points, anchor] : [anchor];
      if (committed.length >= TOOL_POINT_COUNT[tool]) {
        const object = createDrawing(tool, committed);
        setDrawings((current) => [...current, object]);
        setDraft(undefined);
        setHoverAnchor(undefined);
        setSelectedId(object.id);
        setTool("cursor");
      } else {
        setDraft({ tool, points: committed });
      }
      return;
    }

    if (event.shiftKey) {
      const start = snapAnchor(viewport, displayCandles, x, y, magnet);
      interactionRef.current = { mode: "measure", start };
      setQuickMeasure({ tool: "measure", points: [start, start] });
      setQuickMeasureActive(true);
      setSelectedId(undefined);
      return;
    }

    setQuickMeasure(undefined);
    const hit = hitTest(viewport, drawingsRef.current ?? [], x, y, selectedId);
    if (hit) {
      setSelectedId(hit.id);
      interactionRef.current = { mode: "edit", id: hit.id, part: hit.part, last: snapAnchor(viewport, displayCandles, x, y, magnet) };
    } else {
      setSelectedId(undefined);
      interactionRef.current = { mode: "pan", startX: x, startOffset: view.offset };
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === "touch" && gestureActiveRef.current) return;
    const viewport = viewportRef.current;
    const { x, y } = pointerPoint(event);

    if (event.pointerType === "touch") {
      const session = touchSessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      session.lastX = x;
      session.lastY = y;

      if (touchModeRef.current === "pending-pan") {
        if (!chartTouchMovementExceeded({ x: session.startX, y: session.startY }, { x, y })) return;
        clearLongPressTimer();
        if (session.hit && viewport) {
          interactionRef.current = {
            mode: "edit",
            id: session.hit.id,
            part: session.hit.part,
            last: snapAnchor(viewport, displayCandles, session.startX, session.startY, magnet)
          };
          updateTouchMode("edit");
        } else {
          interactionRef.current = { mode: "pan", startX: session.startX, startOffset: session.startOffset };
          updateTouchMode("pan");
        }
      } else if (touchModeRef.current === "inspect") {
        updateTouchCrosshair(x, y);
        return;
      } else if (touchModeRef.current === "pending-draw" || touchModeRef.current === "draw") {
        const drawingTool = session.drawingTool;
        if (viewport && drawingTool) {
          setHoverAnchor(snapDrawingAnchor(drawingTool, viewport, displayCandles, x, y, magnet));
          updateTouchCrosshair(x, y);
        }
        if (touchModeRef.current === "pending-draw" && chartTouchMovementExceeded({ x: session.startX, y: session.startY }, { x, y })) updateTouchMode("draw");
        return;
      }
    }

    if (viewport) setHoverIndex(clampIndex(Math.round(viewport.xToIndex(x)), displayCandles.length));
    if (viewport && onLinkedCrosshairChange) {
      const index = clampIndex(Math.round(viewport.xToIndex(x)), displayCandles.length);
      const candle = displayCandles[index];
      if (candle) onLinkedCrosshairChange({ sourceId: chartId, time: candle.time, price: viewport.yToPrice(y) });
    }

    if (tool !== "cursor" && draft && viewport && event.pointerType !== "touch") {
      setHoverAnchor(snapAnchor(viewport, displayCandles, x, y, magnet));
      setView((current) => ({ ...current, crosshair: { x, y } }));
      return;
    }

    const interaction = interactionRef.current;
    if (interaction?.mode === "measure" && viewport) {
      const end = snapAnchor(viewport, displayCandles, x, y, magnet);
      setQuickMeasure({ tool: "measure", points: [interaction.start, end] });
      setView((current) => ({ ...current, crosshair: { x, y } }));
      return;
    }
    if (interaction?.mode === "edit" && viewport) {
      const next = snapAnchor(viewport, displayCandles, x, y, magnet);
      const dt = next.time - interaction.last.time;
      const dp = next.price - interaction.last.price;
      setDrawings((current) => current.map((drawing) => (drawing.id === interaction.id ? moveDrawing(drawing, interaction.part, next, dt, dp) : drawing)));
      interaction.last = next;
      setView((current) => ({ ...current, crosshair: { x, y } }));
      return;
    }

    if (interaction?.mode === "pan") {
      const bar = viewport ? viewport.barSpacing : 8;
      const delta = Math.round((interaction.startX - x) / Math.max(1, bar));
      const visibleCount = Math.max(1, (viewport?.end ?? 0) - (viewport?.start ?? 0));
      const limit = Math.max(0, displayCandles.length - Math.min(24, visibleCount));
      setView((current) => ({ ...current, offset: Math.min(limit, Math.max(0, interaction.startOffset + delta)), crosshair: { x, y } }));
      return;
    }

    setView((current) => ({ ...current, crosshair: { x, y } }));
    if (viewport) {
      const hit = hitTest(viewport, drawingsRef.current ?? [], x, y, selectedId);
      setHoveredId(hit?.id);
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === "touch") {
      const session = touchSessionRef.current;
      if (session?.pointerId === event.pointerId) {
        clearLongPressTimer();
        const point = pointerPoint(event);
        session.lastX = point.x;
        session.lastY = point.y;
        if (session.intent === "draw" && (touchModeRef.current === "pending-draw" || touchModeRef.current === "draw")) {
          commitTouchDrawing(session, session.lastX, session.lastY);
        }
        if (touchModeRef.current === "inspect") {
          setView((current) => ({ ...current, crosshair: undefined }));
          setHoverIndex(undefined);
          onLinkedCrosshairChange?.();
        }
        touchSessionRef.current = undefined;
        interactionRef.current = undefined;
        updateTouchMode("idle");
      }
    } else {
      if (interactionRef.current?.mode === "measure") setQuickMeasureActive(false);
      interactionRef.current = undefined;
    }
    releaseExpectedCapture(event);
  };

  const onPointerCancel = () => {
    resetTouchNavigation();
    resetTouchTransient();
  };

  const onLostPointerCapture = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (expectedCaptureReleaseRef.current.delete(event.pointerId)) return;
    resetTouchNavigation();
    resetTouchTransient();
  };

  const onPointerLeave = () => {
    if (gestureActiveRef.current || touchModeRef.current !== "idle") return;
    setView((current) => ({ ...current, crosshair: undefined }));
    setHoveredId(undefined);
    setHoverIndex(undefined);
    onLinkedCrosshairChange?.();
  };

  return {
    onLostPointerCapture,
    onPointerCancel,
    onPointerDown,
    onPointerLeave,
    onPointerMove,
    onPointerUp
  };
}
