import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { DRAWINGS_RESTORED_EVENT, drawingStorageKey, loadDrawings, publishDrawingsChanged, saveDrawings, type DrawingStorageEventDetail } from "../../chart/drawingStore";
import type { DrawingObject } from "../../chart/drawings";
import { tenantLocalStorageKey } from "../../app/tenantLocalStorage";

interface DrawingState {
  key: string;
  drawings: DrawingObject[];
}

/** Keeps the storage identity and drawing snapshot atomic during symbol changes. */
export function usePersistentDrawings(symbol: string, chartId: string, ownerId?: string): [DrawingObject[], Dispatch<SetStateAction<DrawingObject[]>>, string] {
  const baseKey = drawingStorageKey(symbol, chartId);
  const key = tenantLocalStorageKey(baseKey, ownerId) ?? `tenant-storage-unavailable:${chartId}:${symbol}`;
  const [state, setState] = useState<DrawingState>(() => ({ key, drawings: loadDrawings(symbol, chartId, ownerId) }));
  const publishedState = useRef(state);
  const committedSnapshots = useRef(new Map([[state.key, state.drawings]]));
  const dirtyScopes = useRef(new Set<string>());
  const suppressPublish = useRef(false);

  // React discards this render and retries immediately, so effects never observe
  // the previous pane's drawings paired with the next pane's storage key.
  if (state.key !== key) setState({ key, drawings: loadDrawings(symbol, chartId, ownerId) });

  useLayoutEffect(() => {
    const previous = publishedState.current;
    publishedState.current = state;
    committedSnapshots.current.set(state.key, state.drawings);
    if (suppressPublish.current) {
      suppressPublish.current = false;
      return;
    }
    if (previous.key === state.key && previous.drawings !== state.drawings) {
      dirtyScopes.current.add(state.key);
      publishDrawingsChanged(symbol, state.drawings, chartId, ownerId);
    }
  }, [chartId, ownerId, state, symbol]);

  useEffect(() => {
    if (state.key !== key || !dirtyScopes.current.has(key)) return;
    const id = window.setTimeout(() => {
      saveDrawings(symbol, state.drawings, chartId, ownerId);
      dirtyScopes.current.delete(key);
    }, 250);
    return () => window.clearTimeout(id);
  }, [chartId, key, ownerId, state, symbol]);

  useEffect(() => {
    const flush = () => {
      if (!dirtyScopes.current.has(key)) return;
      saveDrawings(symbol, committedSnapshots.current.get(key) ?? [], chartId, ownerId);
      dirtyScopes.current.delete(key);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }, [chartId, key, ownerId, symbol]);

  useEffect(() => {
    const restore = (event: Event) => {
      const detail = (event as CustomEvent<DrawingStorageEventDetail>).detail;
      if (!detail || detail.chartId !== chartId || detail.symbol !== symbol || detail.ownerId !== ownerId) return;
      suppressPublish.current = true;
      setState({ key, drawings: detail.drawings });
    };
    window.addEventListener(DRAWINGS_RESTORED_EVENT, restore);
    return () => window.removeEventListener(DRAWINGS_RESTORED_EVENT, restore);
  }, [chartId, key, ownerId, symbol]);

  const setDrawings = useCallback<Dispatch<SetStateAction<DrawingObject[]>>>(
    (action) => {
      setState((current) => {
        const drawings = current.key === key ? current.drawings : loadDrawings(symbol, chartId, ownerId);
        const next = typeof action === "function" ? action(drawings) : action;
        return { key, drawings: next };
      });
    },
    [chartId, key, ownerId, symbol]
  );

  return [state.drawings, setDrawings, key];
}
