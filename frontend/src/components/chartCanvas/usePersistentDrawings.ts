import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { drawingStorageKey, loadDrawings, saveDrawings } from "../../chart/drawingStore";
import type { DrawingObject } from "../../chart/drawings";

interface DrawingState {
  key: string;
  drawings: DrawingObject[];
}

/** Keeps the storage identity and drawing snapshot atomic during symbol changes. */
export function usePersistentDrawings(symbol: string, chartId: string): [DrawingObject[], Dispatch<SetStateAction<DrawingObject[]>>, string] {
  const key = drawingStorageKey(symbol, chartId);
  const [state, setState] = useState<DrawingState>(() => ({ key, drawings: loadDrawings(symbol, chartId) }));

  // React discards this render and retries immediately, so effects never observe
  // the previous pane's drawings paired with the next pane's storage key.
  if (state.key !== key) setState({ key, drawings: loadDrawings(symbol, chartId) });

  useEffect(() => {
    if (state.key !== key) return;
    const id = window.setTimeout(() => saveDrawings(symbol, state.drawings, chartId), 250);
    return () => {
      window.clearTimeout(id);
      saveDrawings(symbol, state.drawings, chartId);
    };
  }, [chartId, key, state, symbol]);

  const setDrawings = useCallback<Dispatch<SetStateAction<DrawingObject[]>>>((action) => {
    setState((current) => {
      const drawings = current.key === key ? current.drawings : loadDrawings(symbol, chartId);
      return { key, drawings: typeof action === "function" ? action(drawings) : action };
    });
  }, [chartId, key, symbol]);

  return [state.drawings, setDrawings, key];
}
