import type { Workspace } from "./workspaces";

export interface WorkspaceQuota {
  activeCount: number;
  activeLimit: number;
  totalCount: number;
  totalLimit: number;
  payloadBytesUsed: number;
  payloadBytesLimit: number;
  maxDocumentBytes: number;
  maxDatabaseDocumentBytes?: number;
  maxRevisions: number;
}

export interface RemoteWorkspace {
  id: string;
  clientId: string;
  revision: number;
  status: "active" | "archived";
  archivedAt?: string;
  workspace: Workspace;
}

export type WorkspaceSyncPhase =
  | "idle"
  | "loading"
  | "saving"
  | "saved"
  | "offline"
  | "conflict"
  | "quota"
  | "failed";

export interface WorkspaceSyncIssue {
  code: string;
  clientId?: string;
  message?: string;
  local?: Workspace;
  current?: Workspace;
}

export interface WorkspaceSyncStatus {
  phase: WorkspaceSyncPhase;
  pendingCount: number;
  lastSavedAt?: number;
  issue?: WorkspaceSyncIssue;
  quota?: WorkspaceQuota;
}

export type WorkspaceConflictAction = "reload" | "keep-copy" | "retry";

export interface WorkspaceRemoteSync {
  start: (workspaces: Workspace[]) => Promise<void>;
  update: (workspaces: Workspace[]) => void;
  markDirty: () => void;
  flushNow: (options?: { keepalive?: boolean }) => Promise<void>;
  purge: (clientId: string) => Promise<boolean>;
  importDocument: (document: unknown, clientId?: string) => Promise<boolean>;
  rollbackLatest: (clientId: string) => Promise<Workspace | undefined>;
  retry: () => void;
  resolveConflict: (action: WorkspaceConflictAction) => void;
  dispose: () => void;
}

export interface WorkspaceRemoteSyncCallbacks {
  onWorkspaces(workspaces: Workspace[]): void;
  onStatus(status: WorkspaceSyncStatus): void;
  onMigrationAcknowledged?(): void;
  knownRemoteClientIds?: readonly string[];
  onKnownRemoteClientIds?(ids: string[]): void;
  hydrateWorkspace?(workspace: Workspace): Workspace;
}
