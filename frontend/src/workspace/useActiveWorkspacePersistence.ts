import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { WorkspaceRemoteSync } from "./remoteSyncTypes";
import { reviseWorkspace, saveWorkspaces, type Workspace, type WorkspaceContext } from "./workspaces";

const AUTOMATIC_PERSIST_DELAY_MS = 120;

interface ActiveWorkspacePersistenceOptions {
  activeWorkspaceId?: string;
  captureContext(): WorkspaceContext;
  enabled: boolean;
  ownerId?: string;
  revisionSignal: number;
  setWorkspaces: Dispatch<SetStateAction<Workspace[]>>;
  syncRef: MutableRefObject<WorkspaceRemoteSync | undefined>;
  workspaces: Workspace[];
}

/** Keeps local workspace state immediate while remote writes remain coalesced by the sync layer. */
export function useActiveWorkspacePersistence({
  activeWorkspaceId,
  captureContext,
  enabled,
  ownerId,
  revisionSignal,
  setWorkspaces,
  syncRef,
  workspaces
}: ActiveWorkspacePersistenceOptions) {
  const workspacesRef = useRef(workspaces);
  const directlyPersisted = useRef<Workspace[]>();
  const drawingRevision = useRef(revisionSignal);
  const observedContext = useRef({ activeWorkspaceId, captureContext });
  const automaticTimer = useRef<number>();
  const lifecycleFlushes = useRef(new Map<string, () => Workspace[]>());
  workspacesRef.current = workspaces;

  useEffect(() => {
    if (!enabled) return;
    if (directlyPersisted.current === workspaces) {
      directlyPersisted.current = undefined;
      return;
    }
    directlyPersisted.current = undefined;
    saveWorkspaces(workspaces, ownerId);
    syncRef.current?.update(workspaces);
  }, [enabled, ownerId, syncRef, workspaces]);

  const flushActiveWorkspace = useCallback((): Workspace[] => {
    if (automaticTimer.current !== undefined) {
      window.clearTimeout(automaticTimer.current);
      automaticTimer.current = undefined;
    }
    const current = workspacesRef.current;
    if (!enabled || !activeWorkspaceId) return current;
    const workspace = current.find((item) => item.id === activeWorkspaceId);
    if (!workspace || workspace.archivedAt) return current;
    const revised = reviseWorkspace(workspace, captureContext());
    if (revised === workspace) {
      syncRef.current?.update(current);
      return current;
    }
    const next = current.map((item) => (item.id === activeWorkspaceId ? revised : item));
    workspacesRef.current = next;
    directlyPersisted.current = next;
    saveWorkspaces(next, ownerId);
    syncRef.current?.update(next);
    setWorkspaces(next);
    return next;
  }, [activeWorkspaceId, captureContext, enabled, ownerId, setWorkspaces, syncRef]);

  const scheduleAutomaticFlush = useCallback(() => {
    const workspace = workspacesRef.current.find((item) => item.id === activeWorkspaceId);
    if (!enabled || !workspace || workspace.archivedAt) return;
    syncRef.current?.markDirty();
    if (automaticTimer.current !== undefined) window.clearTimeout(automaticTimer.current);
    automaticTimer.current = window.setTimeout(() => {
      automaticTimer.current = undefined;
      flushActiveWorkspace();
    }, AUTOMATIC_PERSIST_DELAY_MS);
  }, [activeWorkspaceId, enabled, flushActiveWorkspace, syncRef]);

  useEffect(() => {
    const previous = observedContext.current;
    observedContext.current = { activeWorkspaceId, captureContext };
    if (previous.activeWorkspaceId !== activeWorkspaceId || previous.captureContext === captureContext) return;
    scheduleAutomaticFlush();
  }, [activeWorkspaceId, captureContext, scheduleAutomaticFlush]);

  useEffect(() => {
    if (drawingRevision.current === revisionSignal) return;
    drawingRevision.current = revisionSignal;
    scheduleAutomaticFlush();
  }, [revisionSignal, scheduleAutomaticFlush]);

  const lifecycleScope = ownerId === undefined ? "__public__" : ownerId || "__unresolved__";
  lifecycleFlushes.current.set(lifecycleScope, flushActiveWorkspace);
  useEffect(() => {
    const flushForLifecycle = () => {
      lifecycleFlushes.current.get(lifecycleScope)?.();
      void syncRef.current?.flushNow({ keepalive: true });
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushForLifecycle();
    };
    window.addEventListener("pagehide", flushForLifecycle);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flushForLifecycle);
      document.removeEventListener("visibilitychange", onVisibility);
      flushForLifecycle();
      lifecycleFlushes.current.delete(lifecycleScope);
    };
  }, [lifecycleScope, syncRef]);

  return { flushActiveWorkspace, workspacesRef };
}
