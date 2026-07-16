import {
  Archive,
  ArchiveRestore,
  Cloud,
  CloudAlert,
  CloudOff,
  CloudUpload,
  Copy,
  Download,
  LayoutDashboard,
  Pencil,
  Plus,
  RotateCcw,
  Upload
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { WorkspaceImportOutcome, WorkspaceStrategyRestoreResult, WorkspaceTemplateKind } from "../../app/useAppShell";
import type { Locale } from "../../i18n";
import { shellText } from "../../i18n/shell";
import type { WorkspaceConflictAction, WorkspaceSyncStatus } from "../../workspace/remoteSync";
import { MAX_WORKSPACE_FILE_BYTES, type Workspace } from "../../workspace/workspaces";

export interface WorkspacesMenuProps {
  locale: Locale;
  workspaces: Workspace[];
  syncStatus: WorkspaceSyncStatus;
  strategyRestore: WorkspaceStrategyRestoreResult;
  migrationMissingIndicators: number;
  activeWorkspaceId?: string;
  onSave(name: string): void;
  onApply(id: string): WorkspaceStrategyRestoreResult;
  onArchive(id: string): void;
  onRestore(id: string): void;
  onPurge(id: string): Promise<boolean>;
  onRename(id: string, name: string): boolean;
  onDuplicate(id: string): boolean;
  onCreateTemplate(kind: WorkspaceTemplateKind): boolean;
  canCreatePaperTemplate: boolean;
  serverHistory: boolean;
  onExport(id: string): Promise<void>;
  onImport(raw: string): Promise<WorkspaceImportOutcome>;
  onRollback(id: string, revision: number): Promise<boolean>;
  onRetrySync(): void;
  onResolveConflict(action: WorkspaceConflictAction): void;
}

export function WorkspacesMenu({
  locale,
  workspaces,
  syncStatus,
  strategyRestore,
  migrationMissingIndicators,
  activeWorkspaceId,
  onSave,
  onApply,
  onArchive,
  onRestore,
  onPurge,
  onRename,
  onDuplicate,
  onCreateTemplate,
  canCreatePaperTemplate,
  serverHistory,
  onExport,
  onImport,
  onRollback,
  onRetrySync,
  onResolveConflict
}: WorkspacesMenuProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string }>();
  const [confirmPurgeId, setConfirmPurgeId] = useState<string>();
  const [purging, setPurging] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const activeTabRef = useRef<HTMLButtonElement | null>(null);
  const archivedTabRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  useEffect(() => {
    if (open) window.requestAnimationFrame(() => nameRef.current?.focus());
  }, [open]);

  const visibleWorkspaces = workspaces.filter((workspace) => Boolean(workspace.archivedAt) === showArchived);
  const activeCount = workspaces.filter((workspace) => !workspace.archivedAt).length;
  const archivedCount = workspaces.length - activeCount;
  const trigger = workspaceTriggerPresentation(locale, syncStatus);
  const TriggerIcon = trigger.Icon;
  const submitNew = () => {
    const name = newName.trim();
    if (!name) return;
    onSave(name);
    setNewName("");
  };
  const restoreListFocus = () => {
    window.requestAnimationFrame(() => (showArchived ? archivedTabRef.current : activeTabRef.current)?.focus());
  };

  return (
    <div className="charttype-menu-wrap workspaces-menu-wrap" ref={wrapRef}>
      <button ref={triggerRef} type="button" className={`icon-button workspace-trigger ${syncStatus.phase}`} onClick={() => setOpen((value) => !value)} title={`${shellText(locale, "savedWorkspaces")} · ${trigger.label}`} aria-label={`${shellText(locale, "savedWorkspaces")}: ${trigger.label}`} aria-controls="workspaces-popover" aria-expanded={open}>
        <TriggerIcon size={15} strokeWidth={1.75} aria-hidden="true" />
        <span className="workspace-trigger-state" aria-hidden="true" />
      </button>
      {open && (
        <div id="workspaces-popover" className="charttype-menu workspaces-menu" role="region" aria-label={shellText(locale, "savedWorkspaces")}>
          <WorkspaceSyncBanner locale={locale} status={syncStatus} onRetry={onRetrySync} onResolveConflict={onResolveConflict} />
          <StrategyRestoreNotice locale={locale} result={strategyRestore} />
          {migrationMissingIndicators > 0 && (
            <p className="workspace-strategy-warning" role="status">
              {shellText(locale, "workspaceMigrationIndicatorsMissing").replace("{count}", String(migrationMissingIndicators))}
            </p>
          )}
          <form
            className="workspace-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              submitNew();
            }}
          >
            <label>
              <span className="sr-only">{shellText(locale, "workspaceName")}</span>
              <input ref={nameRef} value={newName} maxLength={120} placeholder={shellText(locale, "saveLayoutPrompt")} aria-label={shellText(locale, "workspaceName")} onChange={(event) => setNewName(event.target.value)} />
            </label>
            <button type="submit" disabled={!newName.trim()} title={shellText(locale, "workspaceCreate")}>
              <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{shellText(locale, "workspaceCreate")}</span>
            </button>
          </form>
          <div className="workspace-templates" role="group" aria-label={shellText(locale, "workspaceTemplates")}>
            {(["monitoring", "research", "backtest", "paper-robot"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                disabled={kind === "paper-robot" && !canCreatePaperTemplate}
                title={kind === "paper-robot" && !canCreatePaperTemplate ? shellText(locale, "workspacePaperTemplateUnavailable") : undefined}
                onClick={() => onCreateTemplate(kind)}
              >
                {shellText(locale, templateLabelKey(kind))}
              </button>
            ))}
          </div>
          <button type="button" className="workspace-save" onClick={() => fileRef.current?.click()}>
            <Upload size={14} strokeWidth={1.75} aria-hidden="true" />
            {shellText(locale, "importWorkspace")}
          </button>
          <input
            ref={fileRef}
            className="sr-only"
            type="file"
            accept=".json,.saltanat-workspace.json,application/json"
            aria-label={shellText(locale, "importWorkspace")}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              if (file.size > MAX_WORKSPACE_FILE_BYTES) {
                setStatus(shellText(locale, "workspaceImportTooLarge"));
                return;
              }
              const result = await onImport(await file.text());
              setStatus(shellText(locale, result.ok ? "workspaceImported" : result.reason === "too_large" ? "workspaceImportTooLarge" : "workspaceImportInvalid"));
            }}
          />
          <span className="workspace-import-status" role="status" aria-live="polite">{status}</span>
          <div className="workspace-tabs" role="group" aria-label={shellText(locale, "savedWorkspaces")}>
            <button ref={activeTabRef} type="button" aria-pressed={!showArchived} className={!showArchived ? "active" : ""} onClick={() => setShowArchived(false)}>
              {shellText(locale, "workspaceActiveTab")} <span>{activeCount}</span>
            </button>
            <button ref={archivedTabRef} type="button" aria-pressed={showArchived} className={showArchived ? "active" : ""} onClick={() => setShowArchived(true)}>
              {shellText(locale, "workspaceArchivedTab")} <span>{archivedCount}</span>
            </button>
          </div>
          {visibleWorkspaces.length === 0 ? (
            <div className="workspace-empty">{shellText(locale, "noSavedWorkspaces")}</div>
          ) : (
            <div className="workspace-list">
              {visibleWorkspaces.map((workspace) => (
                <div className={`workspace-row ${workspace.id === activeWorkspaceId ? "active" : ""}`} key={workspace.id}>
                  {editing?.id === workspace.id ? (
                    <RenameForm locale={locale} workspace={workspace} editing={editing} onEditing={setEditing} onRename={onRename} />
                  ) : (
                    <>
                      <button
                        type="button"
                        className="workspace-apply"
                        disabled={Boolean(workspace.archivedAt)}
                        onClick={() => {
                          const result = onApply(workspace.id);
                          if (result === "none" || result === "restored") setOpen(false);
                        }}
                        title={`${workspace.symbol} · ${workspace.timeframe} · ${workspace.chartType}`}
                      >
                        <strong>{workspace.name}</strong>
                        <span>{workspace.symbol} · {workspace.timeframe} · {workspace.chartType} · v{workspace.revision}</span>
                      </button>
                      <WorkspaceActions
                        locale={locale}
                        workspace={workspace}
                        onEdit={() => setEditing({ id: workspace.id, name: workspace.name })}
                        onArchive={(id) => {
                          onArchive(id);
                          restoreListFocus();
                        }}
                        onRestore={(id) => {
                          onRestore(id);
                          restoreListFocus();
                        }}
                        onRequestPurge={() => setConfirmPurgeId(workspace.id)}
                        onDuplicate={onDuplicate}
                        onExport={onExport}
                        onRollback={async (id, revision) => {
                          const restored = await onRollback(id, revision);
                          if (!restored) setStatus(shellText(locale, "workspaceNoEarlierRevision"));
                          return restored;
                        }}
                        serverHistory={serverHistory}
                      />
                      {workspace.archivedAt && confirmPurgeId === workspace.id && (
                        <div className="workspace-purge-confirm" role="group" aria-label={shellText(locale, "workspacePurgeConfirm")}>
                          <p>{shellText(locale, "workspacePurgeConfirm")}</p>
                          <button
                            type="button"
                            disabled={purging}
                            onClick={async () => {
                              setPurging(true);
                              const removed = await onPurge(workspace.id);
                              setPurging(false);
                              if (removed) {
                                setConfirmPurgeId(undefined);
                                restoreListFocus();
                              }
                              else setStatus(shellText(locale, "workspacePurgeFailed"));
                            }}
                          >
                            {shellText(locale, purging ? "workspacePurging" : "workspacePurge")}
                          </button>
                          <button type="button" disabled={purging} onClick={() => setConfirmPurgeId(undefined)}>{shellText(locale, "workspacePurgeCancel")}</button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RenameForm({
  locale,
  workspace,
  editing,
  onEditing,
  onRename
}: {
  locale: Locale;
  workspace: Workspace;
  editing: { id: string; name: string };
  onEditing(value?: { id: string; name: string }): void;
  onRename(id: string, name: string): boolean;
}) {
  return (
    <form
      className="workspace-rename-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (onRename(workspace.id, editing.name)) onEditing(undefined);
      }}
    >
      <label>
        <span className="sr-only">{shellText(locale, "workspaceName")}</span>
        <input autoFocus maxLength={120} value={editing.name} onChange={(event) => onEditing({ id: workspace.id, name: event.target.value })} />
      </label>
      <button type="submit" disabled={!editing.name.trim()}>{shellText(locale, "workspaceSaved")}</button>
      <button type="button" onClick={() => onEditing(undefined)}>{shellText(locale, "workspaceCancelRename")}</button>
    </form>
  );
}

function WorkspaceActions({
  locale,
  workspace,
  onEdit,
  onArchive,
  onRestore,
  onRequestPurge,
  onDuplicate,
  onExport,
  onRollback,
  serverHistory
}: {
  locale: Locale;
  workspace: Workspace;
  onEdit(): void;
  onArchive(id: string): void;
  onRestore(id: string): void;
  onRequestPurge(): void;
  onDuplicate(id: string): boolean;
  onExport(id: string): Promise<void>;
  onRollback(id: string, revision: number): Promise<boolean>;
  serverHistory: boolean;
}) {
  return (
    <div className="workspace-actions">
      {!workspace.archivedAt && <Action label={shellText(locale, "workspaceRename")} name={workspace.name} onClick={onEdit}><Pencil size={13} aria-hidden="true" /></Action>}
      {!workspace.archivedAt && <Action label={shellText(locale, "workspaceDuplicate")} name={workspace.name} onClick={() => onDuplicate(workspace.id)}><Copy size={13} aria-hidden="true" /></Action>}
      {(workspace.history.length > 0 || serverHistory) && !workspace.archivedAt && (
        <Action label={shellText(locale, "rollbackWorkspace")} name={workspace.name} onClick={() => void onRollback(workspace.id, workspace.history.at(-1)?.revision ?? Math.max(1, workspace.revision - 1))}>
          <RotateCcw size={13} strokeWidth={1.75} aria-hidden="true" />
        </Action>
      )}
      <Action label={shellText(locale, "exportWorkspace")} name={workspace.name} onClick={() => void onExport(workspace.id)}><Download size={13} strokeWidth={1.75} aria-hidden="true" /></Action>
      <Action
        label={shellText(locale, workspace.archivedAt ? "workspaceRestore" : "workspaceArchive")}
        name={workspace.name}
        onClick={() => workspace.archivedAt ? onRestore(workspace.id) : onArchive(workspace.id)}
      >
        {workspace.archivedAt ? <ArchiveRestore size={13} aria-hidden="true" /> : <Archive size={13} aria-hidden="true" />}
      </Action>
      {workspace.archivedAt && <Action label={shellText(locale, "workspacePurge")} name={workspace.name} onClick={onRequestPurge}><Archive size={13} aria-hidden="true" /></Action>}
    </div>
  );
}

function Action({ label, name, onClick, children }: { label: string; name: string; onClick(): void; children: ReactNode }) {
  return <button type="button" onClick={onClick} title={label} aria-label={`${label} ${name}`}>{children}</button>;
}

function WorkspaceSyncBanner({
  locale,
  status,
  onRetry,
  onResolveConflict
}: {
  locale: Locale;
  status: WorkspaceSyncStatus;
  onRetry(): void;
  onResolveConflict(action: WorkspaceConflictAction): void;
}) {
  const config = status.phase === "saving" || status.phase === "loading"
    ? { label: shellText(locale, "workspaceSaving"), Icon: CloudUpload }
    : status.phase === "offline"
      ? { label: shellText(locale, "workspaceOffline"), Icon: CloudOff }
      : status.phase === "conflict"
        ? { label: shellText(locale, "workspaceConflict"), Icon: CloudAlert }
        : status.phase === "quota"
          ? { label: shellText(locale, "workspaceQuota"), Icon: CloudAlert }
          : status.phase === "failed"
            ? { label: shellText(locale, "workspaceFailed"), Icon: CloudAlert }
            : { label: shellText(locale, "workspaceSaved"), Icon: Cloud };
  const quota = status.quota;
  const actionableIssue = status.phase === "conflict"
    || (status.phase === "quota" && Boolean(status.issue?.local && status.issue.current));
  return (
    <section className={`workspace-sync-banner ${status.phase}`} aria-live="polite" aria-atomic="true">
      <div><config.Icon size={14} aria-hidden="true" /><strong>{config.label}</strong>{status.pendingCount > 0 && <span>{status.pendingCount}</span>}</div>
      {quota && (
        <>
          <small>
            {shellText(locale, "workspaceQuotaUsage")
              .replace("{active}", String(quota.activeCount))
              .replace("{activeLimit}", String(quota.activeLimit))
              .replace("{total}", String(quota.totalCount))
              .replace("{totalLimit}", String(quota.totalLimit))}
          </small>
          <small>
            {shellText(locale, "workspaceStorageUsage")
              .replace("{used}", formatBytes(quota.payloadBytesUsed))
              .replace("{limit}", formatBytes(quota.payloadBytesLimit))
              .replace("{document}", formatBytes(quota.maxDocumentBytes))}
          </small>
        </>
      )}
      {actionableIssue && (
        <div className="workspace-conflict-actions">
          <p>{shellText(locale, status.issue?.code === "workspace_deleted" ? "workspaceDeletedHelp" : "workspaceConflictHelp")}</p>
          <button type="button" onClick={() => onResolveConflict("reload")}>{shellText(locale, status.issue?.code === "workspace_deleted" ? "workspaceAcceptDeletion" : "workspaceReloadServer")}</button>
          <button type="button" onClick={() => onResolveConflict("keep-copy")}>{shellText(locale, "workspaceKeepConflictCopy")}</button>
          {status.issue?.code !== "workspace_archived" && status.issue?.code !== "workspace_deleted" && <button type="button" onClick={() => onResolveConflict("retry")}>{shellText(locale, "workspaceRetryOverwrite")}</button>}
        </div>
      )}
      {(status.phase === "offline" || status.phase === "failed" || (status.phase === "quota" && !actionableIssue)) && <button type="button" className="workspace-retry" onClick={onRetry}>{shellText(locale, "workspaceRetry")}</button>}
    </section>
  );
}

function StrategyRestoreNotice({ locale, result }: { locale: Locale; result: WorkspaceStrategyRestoreResult }) {
  if (result === "none" || result === "restored") return null;
  const key = result === "missing"
    ? "workspaceStrategyMissing"
    : result === "revision_mismatch"
      ? "workspaceStrategyRevisionMismatch"
      : "workspaceStrategyHashMismatch";
  return <p className="workspace-strategy-warning" role="status">{shellText(locale, key)}</p>;
}

function templateLabelKey(kind: WorkspaceTemplateKind): "workspaceTemplateMonitoring" | "workspaceTemplateResearch" | "workspaceTemplateBacktest" | "workspaceTemplatePaperRobot" {
  return kind === "monitoring"
    ? "workspaceTemplateMonitoring"
    : kind === "research"
      ? "workspaceTemplateResearch"
      : kind === "backtest"
        ? "workspaceTemplateBacktest"
        : "workspaceTemplatePaperRobot";
}

function workspaceTriggerPresentation(locale: Locale, status: WorkspaceSyncStatus) {
  if (status.phase === "saving" || status.phase === "loading") return { label: shellText(locale, "workspaceSaving"), Icon: CloudUpload };
  if (status.phase === "offline") return { label: shellText(locale, "workspaceOffline"), Icon: CloudOff };
  if (status.phase === "conflict") return { label: shellText(locale, "workspaceConflict"), Icon: CloudAlert };
  if (status.phase === "quota") return { label: shellText(locale, "workspaceQuota"), Icon: CloudAlert };
  if (status.phase === "failed") return { label: shellText(locale, "workspaceFailed"), Icon: CloudAlert };
  return { label: shellText(locale, "workspaceSaved"), Icon: LayoutDashboard };
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(value < 10_240 ? 1 : 0)} KiB`;
  return `${(value / 1_048_576).toFixed(value < 10_485_760 ? 1 : 0)} MiB`;
}
