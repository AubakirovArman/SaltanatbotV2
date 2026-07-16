import { useEffect, useRef, useState } from "react";
import { DRAWINGS_CHANGED_EVENT, type DrawingStorageEventDetail } from "../chart/drawingStore";
import type { WorkspaceChart } from "./workspaces";
import { drawingSnapshotKey, type DrawingSnapshotMap } from "./shellWorkspaceHelpers";

export function useWorkspaceDrawingSnapshots(charts: WorkspaceChart[], ownerId?: string): {
  revision: number;
  snapshots: DrawingSnapshotMap;
} {
  const snapshots = useRef<DrawingSnapshotMap>(new Map());
  const fingerprints = useRef(new Map<string, string>());
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    snapshots.current.clear();
    fingerprints.current.clear();
  }, [ownerId]);

  useEffect(() => {
    const onDrawingsChanged = (event: Event) => {
      const detail = (event as CustomEvent<DrawingStorageEventDetail>).detail;
      if (!detail || detail.ownerId !== ownerId) return;
      const key = drawingSnapshotKey(detail.chartId, detail.symbol);
      const fingerprint = JSON.stringify(detail.drawings);
      snapshots.current.set(key, detail.drawings);
      if (fingerprints.current.get(key) === fingerprint) return;
      fingerprints.current.set(key, fingerprint);
      if (charts.some((chart) => chart.id === detail.chartId && chart.symbol === detail.symbol)) setRevision((value) => value + 1);
    };
    window.addEventListener(DRAWINGS_CHANGED_EVENT, onDrawingsChanged);
    return () => window.removeEventListener(DRAWINGS_CHANGED_EVENT, onDrawingsChanged);
  }, [charts, ownerId]);

  return { revision, snapshots: snapshots.current };
}
