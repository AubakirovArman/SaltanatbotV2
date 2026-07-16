import { useEffect, useRef } from "react";
import type { WorkspaceSyncPhase } from "./remoteSyncTypes";
import { loadLastActiveWorkspaceId, saveLastActiveWorkspaceId, type Workspace } from "./workspaces";

interface LastActiveWorkspaceOptions {
  applyWorkspace(id: string): unknown;
  authRequired: boolean;
  ownerId?: string;
  syncPhase: WorkspaceSyncPhase;
  workspaces: Workspace[];
}

export function useLastActiveWorkspace({
  applyWorkspace,
  authRequired,
  ownerId,
  syncPhase,
  workspaces
}: LastActiveWorkspaceOptions) {
  const lastActiveWorkspace = useRef(loadLastActiveWorkspaceId(ownerId));
  const restored = useRef(false);
  const scopedOwner = useRef(ownerId);
  const ownerChanged = scopedOwner.current !== ownerId;

  useEffect(() => {
    if (!ownerChanged) return;
    scopedOwner.current = ownerId;
    lastActiveWorkspace.current = loadLastActiveWorkspaceId(ownerId);
    restored.current = false;
  }, [ownerChanged, ownerId]);

  useEffect(() => {
    if (ownerChanged || restored.current) return;
    if (authRequired && (syncPhase === "idle" || syncPhase === "loading")) return;
    restored.current = true;
    const id = lastActiveWorkspace.current;
    const workspace = (id ? workspaces.find((item) => item.id === id && !item.archivedAt) : undefined)
      ?? workspaces.find((item) => !item.archivedAt);
    if (workspace) {
      lastActiveWorkspace.current = workspace.id;
      saveLastActiveWorkspaceId(workspace.id, ownerId);
      applyWorkspace(workspace.id);
    } else if (id) {
      lastActiveWorkspace.current = undefined;
      saveLastActiveWorkspaceId(undefined, ownerId);
    }
  }, [applyWorkspace, authRequired, ownerChanged, ownerId, syncPhase, workspaces]);

  return lastActiveWorkspace;
}
