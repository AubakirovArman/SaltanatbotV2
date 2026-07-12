import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { linkedRangeFromViewport, viewForLinkedRange } from "../../chart/linkedTimeRange";
import type { LinkedTimeRange, Viewport } from "../../chart/types";
import type { Candle } from "../../types";
import type { ChartNavigationView } from "./useChartNavigation";

export function useLinkedTimeRange({ candles, chartId, linkedRange, onLinkedRangeChange, setView, view, viewportRef }: {
  candles: Candle[];
  chartId: string;
  linkedRange?: LinkedTimeRange;
  onLinkedRangeChange?: (range?: LinkedTimeRange) => void;
  setView: Dispatch<SetStateAction<ChartNavigationView>>;
  view: ChartNavigationView;
  viewportRef: RefObject<Viewport | undefined>;
}) {
  const suppressPublishRef = useRef(false);
  const previousViewRef = useRef({ zoom: view.zoom, offset: view.offset });
  const candlesRef = useRef(candles);
  candlesRef.current = candles;
  const firstTime = candles[0]?.time;
  const lastTime = candles.at(-1)?.time;

  useEffect(() => {
    if (!linkedRange || linkedRange.sourceId === chartId) return;
    const frame = requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const linkedView = viewForLinkedRange(candlesRef.current, viewport, linkedRange);
      if (!linkedView) return;
      setView((current) => {
        if (current.zoom === linkedView.zoom && current.offset === linkedView.offset) return current;
        suppressPublishRef.current = true;
        return { ...current, ...linkedView };
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [chartId, firstTime, linkedRange, setView, viewportRef]);

  useEffect(() => {
    const previous = previousViewRef.current;
    previousViewRef.current = { zoom: view.zoom, offset: view.offset };
    if (previous.zoom === view.zoom && previous.offset === view.offset) return;
    if (suppressPublishRef.current) {
      suppressPublishRef.current = false;
      return;
    }
    const frame = requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      const range = viewport ? linkedRangeFromViewport(viewport, chartId) : undefined;
      if (range) onLinkedRangeChange?.(range);
    });
    return () => cancelAnimationFrame(frame);
  }, [chartId, onLinkedRangeChange, view.offset, view.zoom, viewportRef]);

  useEffect(() => {
    if (!lastTime || linkedRange?.sourceId !== chartId || view.offset !== 0) return;
    const frame = requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      const range = viewport ? linkedRangeFromViewport(viewport, chartId) : undefined;
      if (range) onLinkedRangeChange?.(range);
    });
    return () => cancelAnimationFrame(frame);
  }, [chartId, lastTime, linkedRange?.sourceId, onLinkedRangeChange, view.offset, viewportRef]);
}
