import { normalizeWorkspace, workspaceContentFingerprint, type Workspace, type WorkspaceRevision } from "./workspaces";
import type { RemoteWorkspace, WorkspaceQuota, WorkspaceSyncStatus } from "./remoteSync";
import type { WorkspaceMutationAction } from "./remoteSyncTransport";

export function parseRemoteWorkspace(value: unknown): RemoteWorkspace | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const workspace = normalizeWorkspace(item.payload);
  if (!workspace || !validString(item.id) || !validString(item.clientId) || !positiveInteger(item.revision)) return undefined;
  const status = item.status === "archived" ? "archived" : "active";
  const archivedAt = typeof item.archivedAt === "string" ? item.archivedAt : undefined;
  return {
    id: item.id,
    clientId: item.clientId,
    revision: item.revision,
    status,
    archivedAt,
    workspace: {
      ...workspace,
      id: item.clientId,
      name: typeof item.name === "string" ? item.name : workspace.name,
      archivedAt: status === "archived" ? Date.parse(archivedAt ?? "") || workspace.updatedAt : undefined
    }
  };
}

export function parseWorkspaceQuota(value: unknown): WorkspaceQuota | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const keys: (keyof WorkspaceQuota)[] = ["activeCount", "activeLimit", "totalCount", "totalLimit", "payloadBytesUsed", "payloadBytesLimit", "maxDocumentBytes", "maxRevisions"];
  if (!keys.every((key) => typeof item[key] === "number" && Number.isSafeInteger(item[key]) && Number(item[key]) >= 0)) return undefined;
  const quota = Object.fromEntries(keys.map((key) => [key, Number(item[key])])) as unknown as WorkspaceQuota;
  if (
    typeof item.maxDatabaseDocumentBytes === "number" &&
    Number.isSafeInteger(item.maxDatabaseDocumentBytes) &&
    item.maxDatabaseDocumentBytes >= 0
  ) {
    quota.maxDatabaseDocumentBytes = item.maxDatabaseDocumentBytes;
  }
  return quota;
}

export function sameWorkspace(left: Workspace, right: Workspace): boolean {
  return left.name === right.name
    && Boolean(left.archivedAt) === Boolean(right.archivedAt)
    && sameWorkspaceVersion(left, right);
}

export function sameWorkspaceVersion(left: Workspace, right: Workspace): boolean {
  return left.name === right.name && workspaceContentFingerprint(left) === workspaceContentFingerprint(right);
}

export function needsWorkspaceUpdate(workspace: Workspace, document: RemoteWorkspace): boolean {
  return workspace.name !== document.workspace.name || workspaceContentFingerprint(workspace) !== workspaceContentFingerprint(document.workspace);
}

export function isNameOnlyWorkspaceUpdate(workspace: Workspace, document: RemoteWorkspace): boolean {
  return workspace.name !== document.workspace.name
    && workspaceContentFingerprint(workspace) === workspaceContentFingerprint(document.workspace);
}

export function workspaceConflictCopy(workspace: Workspace, all: Workspace[]): Workspace {
  const now = Date.now();
  const stem = workspace.id.slice(0, 130);
  let id = `${stem}-conflict-${now}`;
  let suffix = 1;
  const ids = new Set(all.map((item) => item.id));
  while (ids.has(id)) id = `${stem}-conflict-${now}-${suffix++}`;
  return { ...workspace, id, name: `${workspace.name} (conflict copy)`.slice(0, 120), archivedAt: undefined, createdAt: now, updatedAt: now };
}

export function isWorkspaceQuotaCode(code: string): boolean {
  return code === "workspace_active_quota_exceeded"
    || code === "workspace_total_quota_exceeded"
    || code === "workspace_storage_quota_exceeded"
    || code === "workspace_document_too_large"
    || code === "workspace_database_document_too_large"
    || code === "workspace_envelope_too_large";
}

export function isWorkspaceConflictCode(code: string): boolean {
  return code === "workspace_conflict" || code === "workspace_archived" || code === "workspace_not_archived";
}

export function orderQuotaReducingFirst(local: Workspace[], documents: Map<string, RemoteWorkspace>): Workspace[] {
  return [...local].sort((left, right) => operationPriority(left, documents.get(left.id)) - operationPriority(right, documents.get(right.id)));
}

export function nextWorkspaceMutation(workspace: Workspace, document?: RemoteWorkspace): WorkspaceMutationAction | "none" {
  if (!document) return workspace.archivedAt ? "none" : "create";
  if (document.status === "active" && workspace.archivedAt) {
    if (isNameOnlyWorkspaceUpdate(workspace, document)) return "rename";
    if (needsWorkspaceUpdate(workspace, document)) return "update";
    return "archive";
  }
  if (document.status === "archived" && !workspace.archivedAt) return "restore";
  if (isNameOnlyWorkspaceUpdate(workspace, document)) return "rename";
  return needsWorkspaceUpdate(workspace, document) ? "update" : "none";
}

function operationPriority(workspace: Workspace, document?: RemoteWorkspace): number {
  if (document?.status === "active" && workspace.archivedAt) return 0;
  if (!document) return 2;
  if (document.status === "archived" && !workspace.archivedAt) return 3;
  return 1;
}

export function workspaceRevisionSnapshot(workspace: Workspace): WorkspaceRevision {
  return {
    revision: workspace.revision,
    savedAt: workspace.savedAt,
    mode: workspace.mode,
    symbol: workspace.symbol,
    timeframe: workspace.timeframe,
    chartType: workspace.chartType,
    cryptoExchange: workspace.cryptoExchange,
    enabledIndicators: [...workspace.enabledIndicators],
    indicators: workspace.indicators.map((indicator) => ({ ...indicator })),
    compareOverlays: workspace.compareOverlays.map((overlay) => ({ ...overlay })),
    theme: workspace.theme,
    layout: { ...workspace.layout },
    charts: workspace.charts.map((chart) => ({ ...chart })),
    activeChartId: workspace.activeChartId,
    drawings: workspace.drawings.map((scope) => ({ ...scope, drawings: scope.drawings.map((drawing) => ({ ...drawing, style: { ...drawing.style }, points: drawing.points.map((point) => ({ ...point })) as typeof drawing.points })) })),
    selectedStrategy: workspace.selectedStrategy ? { ...workspace.selectedStrategy, parameters: { ...workspace.selectedStrategy.parameters } } : undefined
  };
}

export function isWorkspaceOffline(error: unknown): boolean {
  return isNavigatorOffline() || error instanceof TypeError;
}

export function isNavigatorOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export function isBlockingWorkspaceStatus(status: WorkspaceSyncStatus): boolean {
  return status.phase === "quota" || status.phase === "failed" || status.phase === "offline";
}

function validString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
