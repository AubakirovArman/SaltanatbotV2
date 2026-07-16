import { publishAuthSessionInvalidated } from "../auth/sessionSync";
import {
  type Workspace
} from "./workspaces";
import { createKeyedMutationQueue } from "./keyedMutationQueue";
import type {
  RemoteWorkspace,
  WorkspaceConflictAction,
  WorkspaceQuota,
  WorkspaceRemoteSync,
  WorkspaceRemoteSyncCallbacks,
  WorkspaceSyncStatus
} from "./remoteSyncTypes";
export type {
  RemoteWorkspace,
  WorkspaceConflictAction,
  WorkspaceQuota,
  WorkspaceRemoteSync,
  WorkspaceRemoteSyncCallbacks,
  WorkspaceSyncIssue,
  WorkspaceSyncPhase,
  WorkspaceSyncStatus
} from "./remoteSyncTypes";
import {
  isBlockingWorkspaceStatus,
  isNameOnlyWorkspaceUpdate,
  isNavigatorOffline,
  isWorkspaceConflictCode,
  isWorkspaceOffline,
  isWorkspaceQuotaCode,
  needsWorkspaceUpdate,
  nextWorkspaceMutation,
  orderQuotaReducingFirst,
  parseRemoteWorkspace,
  parseWorkspaceQuota,
  sameWorkspace,
  sameWorkspaceVersion,
  workspaceConflictCopy,
  workspaceRevisionSnapshot
} from "./remoteSyncSupport";
import {
  requestWorkspaceCollection,
  requestWorkspaceMutation,
  sendWorkspaceRequest,
  WORKSPACE_API,
  type RemoteBody,
  type WorkspaceMutationAction
} from "./remoteSyncTransport";
const SAVE_DELAY_MS = 900;

export function createWorkspaceRemoteSync(expectedUserId: string, callbacks: WorkspaceRemoteSyncCallbacks): WorkspaceRemoteSync {
  const documents = new Map<string, RemoteWorkspace>();
  const mutations = createKeyedMutationQueue();
  const knownRemoteClientIds = new Set(callbacks.knownRemoteClientIds ?? []);
  let local: Workspace[] = [];
  let timer: number | undefined;
  let active = true;
  let ready = false;
  let flushing = false;
  let pulling = false;
  let dirtyHint = false;
  let hasSuccessfulPull = false;
  let migrationIds = new Set<string>();
  let migrationStarted = false;
  let migrationAcknowledged = false;
  let conflicts: { code: string; local: Workspace; current?: RemoteWorkspace }[] = [];
  let status: WorkspaceSyncStatus = { phase: "idle", pendingCount: 0 };

  const publishStatus = (patch: Partial<WorkspaceSyncStatus>) => {
    if (!active) return;
    status = { ...status, ...patch };
    callbacks.onStatus(status);
  };
  const parse = (value: unknown) => {
    const document = parseRemoteWorkspace(value);
    return document && callbacks.hydrateWorkspace
      ? { ...document, workspace: callbacks.hydrateWorkspace(document.workspace) }
      : document;
  };
  const publishWorkspaces = () => {
    if (active) callbacks.onWorkspaces([...local]);
  };
  const keep = (document: RemoteWorkspace) => {
    if (!active) return;
    documents.set(document.clientId, document);
    if (!knownRemoteClientIds.has(document.clientId)) {
      knownRemoteClientIds.add(document.clientId);
      callbacks.onKnownRemoteClientIds?.([...knownRemoteClientIds]);
    }
  };
  const replaceLocal = (workspace: Workspace) => {
    const index = local.findIndex((item) => item.id === workspace.id);
    if (index === -1) local = [workspace, ...local];
    else local = local.map((item, itemIndex) => (itemIndex === index ? workspace : item));
    publishWorkspaces();
  };
  const send = async (path: string, init?: RequestInit): Promise<[Response, RemoteBody]> => {
    const result = await sendWorkspaceRequest(expectedUserId, path, init);
    if (!active) throw new Error("Workspace sync disposed");
    return result;
  };

  const fail = (error: unknown, clientId?: string) => {
    if (!active) return;
    const offline = isWorkspaceOffline(error);
    publishStatus({
      phase: offline ? "offline" : "failed",
      issue: { code: offline ? "workspace_offline" : "workspace_request_failed", clientId, message: error instanceof Error ? error.message : undefined }
    });
  };

  function publishConflictStatus(): boolean {
    const selected = conflicts[0];
    if (!selected) return false;
    publishStatus({
      phase: isWorkspaceQuotaCode(selected.code) ? "quota" : "conflict",
      pendingCount: pendingOperations(),
      issue: {
        code: selected.code,
        clientId: selected.local.id,
        local: selected.local,
        current: selected.current?.workspace
      }
    });
    return true;
  }

  function publishSettledStatus(): void {
    if (publishConflictStatus()) return;
    const pendingCount = Math.max(dirtyHint ? 1 : 0, pendingOperations());
    publishStatus({
      phase: pendingCount ? "saving" : "saved",
      pendingCount,
      lastSavedAt: pendingCount ? status.lastSavedAt : Date.now(),
      issue: undefined
    });
    if (pendingCount && !dirtyHint) schedule(0);
  }

  const handleRejected = (response: Response, body: RemoteBody, workspace?: Workspace): boolean => {
    const code = typeof body.code === "string" ? body.code : `http_${response.status}`;
    if (response.status === 401 || code === "workspace_authorization_changed") {
      if (timer !== undefined) window.clearTimeout(timer);
      publishStatus({ phase: "failed", issue: { code } });
      active = false;
      publishAuthSessionInvalidated();
      return true;
    }
    const responseCurrent = parse(body.current ?? body.currentMetadata);
    if (response.status === 409 && isWorkspaceConflictCode(code) && workspace && responseCurrent) {
      keep(responseCurrent);
      conflicts = [{ code, local: workspace, current: responseCurrent }, ...conflicts.filter((item) => item.local.id !== workspace.id)];
      publishStatus({
        phase: "conflict",
        pendingCount: pendingOperations(),
        issue: { code, clientId: workspace.id, local: workspace, current: responseCurrent.workspace }
      });
      return true;
    }
    if (isWorkspaceQuotaCode(code) || response.status === 413 || response.status === 429) {
      const current = responseCurrent ?? (workspace ? documents.get(workspace.id) : undefined);
      if (workspace && current) {
        keep(current);
        conflicts = [{ code, local: workspace, current }, ...conflicts.filter((item) => item.local.id !== workspace.id)];
      }
      publishStatus({
        phase: "quota",
        issue: {
          code,
          clientId: workspace?.id,
          message: typeof body.error === "string" ? body.error : undefined,
          local: workspace,
          current: current?.workspace
        },
        quota: parseWorkspaceQuota(body.quota) ?? status.quota
      });
      return true;
    }
    publishStatus({
      phase: "failed",
      issue: { code, clientId: workspace?.id, message: typeof body.error === "string" ? body.error : undefined }
    });
    return true;
  };

  const mutate = async (
    action: WorkspaceMutationAction,
    workspace: Workspace,
    document?: RemoteWorkspace,
    keepalive = false
  ): Promise<boolean> => {
    const [response, body] = await requestWorkspaceMutation(send, action, workspace, document, keepalive);
    if (!response.ok) return !handleRejected(response, body, workspace);
    const saved = parse(body.workspace);
    if (!saved) throw new Error(`Invalid workspace ${action} response`);
    acceptSavedWorkspace(workspace, saved);
    updateQuota(body);
    return true;
  };

  const flush = async (keepalive = false) => {
    if (!active || !ready || flushing || pulling || dirtyHint || conflicts.length) return;
    flushing = true;
    try {
      let pending = pendingOperations();
      publishStatus({ phase: pending ? "saving" : "saved", pendingCount: pending, issue: undefined });
      const ordered = orderQuotaReducingFirst(local, documents);
      for (const candidate of ordered) {
        if (!active || conflicts.length) break;
        const completed = await mutations.run(candidate.id, async () => {
          for (let step = 0; step < 3; step += 1) {
            if (!active || conflicts.length) return true;
            const workspace = local.find((item) => item.id === candidate.id);
            if (!workspace) return true;
            const document = documents.get(workspace.id);
            const action = nextWorkspaceMutation(workspace, document);
            if (action === "none") return true;
            if (!(await mutate(action, workspace, document, keepalive))) return false;
          }
          return false;
        });
        if (!completed || isBlockingWorkspaceStatus(status)) break;
      }
      pending = pendingOperations();
      if (!conflicts.length && !isBlockingWorkspaceStatus(status)) {
        publishStatus({ phase: pending ? "saving" : "saved", pendingCount: pending, lastSavedAt: pending ? status.lastSavedAt : Date.now(), issue: undefined });
      }
      if (pending && !conflicts.length && !isBlockingWorkspaceStatus(status)) schedule(0);
      acknowledgeMigration();
    } catch (error) {
      fail(error);
    } finally {
      flushing = false;
    }
  };

  const pull = async () => {
    if (!active || pulling || flushing) return;
    pulling = true;
    const localAtPull = new Map(local.map((workspace) => [workspace.id, workspace]));
    publishStatus({ phase: "loading", issue: undefined });
    try {
      const [response, body] = await requestWorkspaceCollection(
        send,
        `${WORKSPACE_API}?status=all`,
        "workspaces"
      );
      if (!active) return;
      if (!response.ok) {
        handleRejected(response, body);
        return;
      }
      if (!Array.isArray(body.workspaces)) throw new Error("Invalid workspace list response");
      const remoteByClientId = new Map<string, RemoteWorkspace>();
      body.workspaces
        .map(parse)
        .filter((item): item is RemoteWorkspace => item !== undefined)
        .forEach((item) => remoteByClientId.set(item.clientId, item));
      const remote = [...remoteByClientId.values()];
      documents.clear();
      conflicts = [];
      remote.forEach(keep);
      updateQuota(body);
      ready = true;
      hasSuccessfulPull = true;
      const next: Workspace[] = [];
      for (const workspace of local) {
        const document = documents.get(workspace.id);
        if (!document) {
          if (knownRemoteClientIds.has(workspace.id)) {
            conflicts.push({ code: "workspace_deleted", local: workspace });
          }
          next.push(workspace);
          continue;
        }
        const started = localAtPull.get(workspace.id);
        if (started && sameWorkspace(started, document.workspace) && !sameWorkspace(workspace, started)) {
          next.push(workspace);
          continue;
        }
        if (sameWorkspace(workspace, document.workspace)) next.push({ ...document.workspace, history: workspace.history });
        else {
          conflicts.push({ code: "workspace_conflict", local: workspace, current: document });
          next.push(workspace);
        }
      }
      const known = new Set(next.map((workspace) => workspace.id));
      remote.forEach((document) => {
        if (!known.has(document.clientId)) next.push(document.workspace);
      });
      local = next;
      publishWorkspaces();
      if (!publishConflictStatus()) {
        const pendingCount = Math.max(dirtyHint ? 1 : 0, pendingOperations());
        publishStatus({ phase: pendingCount ? "saving" : "saved", pendingCount, lastSavedAt: Date.now(), issue: undefined });
        if (!dirtyHint) schedule(0);
      }
      acknowledgeMigration();
    } catch (error) {
      ready = true;
      fail(error);
    } finally {
      pulling = false;
    }
  };

  const pendingOperations = (): number =>
    local.reduce((count, workspace) => {
      const document = documents.get(workspace.id);
      if (!document && workspace.archivedAt) return count;
      return count + (!document || Boolean(workspace.archivedAt) !== (document.status === "archived") || needsWorkspaceUpdate(workspace, document) ? 1 : 0);
    }, 0);

  const schedule = (delay = SAVE_DELAY_MS) => {
    if (!active || !ready || conflicts.length) return;
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      void flush();
    }, delay);
  };

  const acknowledgeMigration = () => {
    if (!migrationStarted || migrationAcknowledged) return;
    const acknowledged = [...migrationIds].every((id) => {
      const workspace = local.find((item) => item.id === id);
      const document = documents.get(id);
      return workspace && document && sameWorkspace(workspace, document.workspace);
    });
    if (!acknowledged) return;
    migrationAcknowledged = true;
    migrationIds.clear();
    callbacks.onMigrationAcknowledged?.();
  };

  const updateQuota = (body: RemoteBody) => {
    const quota = parseWorkspaceQuota(body.quota);
    if (quota) publishStatus({ quota });
  };

  return {
    start: async (workspaces) => {
      if (!active) return;
      local = [...workspaces];
      migrationIds = new Set(workspaces.filter((workspace) => !knownRemoteClientIds.has(workspace.id)).map((workspace) => workspace.id));
      migrationStarted = migrationIds.size > 0;
      migrationAcknowledged = false;
      await pull();
    },
    update: (workspaces) => {
      if (!active) return;
      dirtyHint = false;
      local = [...workspaces];
      if (conflicts.length) {
        const latestById = new Map(local.map((workspace) => [workspace.id, workspace]));
        conflicts = conflicts.map((conflict) => ({
          ...conflict,
          local: latestById.get(conflict.local.id) ?? conflict.local
        }));
        publishConflictStatus();
        return;
      }
      const pendingCount = pendingOperations();
      publishStatus({ phase: pendingCount ? (isNavigatorOffline() ? "offline" : "saving") : "saved", pendingCount });
      schedule();
    },
    markDirty: () => {
      if (!active || conflicts.length) return;
      dirtyHint = true;
      if (status.phase === "saving" && status.pendingCount > 0) return;
      publishStatus({
        phase: isNavigatorOffline() ? "offline" : "saving",
        pendingCount: Math.max(1, pendingOperations()),
        issue: undefined
      });
    },
    flushNow: async (options) => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      await flush(options?.keepalive === true);
    },
    purge: async (clientId) => {
      if (!active || conflicts.length) return false;
      return mutations.run(clientId, async () => {
        const workspace = local.find((item) => item.id === clientId);
        if (!active || conflicts.length || !workspace?.archivedAt) return false;
        publishStatus({ phase: "saving", pendingCount: Math.max(1, pendingOperations()), issue: undefined });
        try {
          let document = documents.get(clientId);
          if (!document) {
            const [listResponse, listBody] = await requestWorkspaceCollection(
              send,
              `${WORKSPACE_API}?status=all`,
              "workspaces"
            );
            if (!listResponse.ok || !Array.isArray(listBody.workspaces)) {
              handleRejected(listResponse, listBody, workspace);
              return false;
            }
            const authoritative = new Map<string, RemoteWorkspace>();
            listBody.workspaces
              .map(parse)
              .filter((item): item is RemoteWorkspace => item !== undefined)
              .forEach((item) => authoritative.set(item.clientId, item));
            authoritative.forEach(keep);
            updateQuota(listBody);
            document = documents.get(clientId);
            if (!document) {
              local = local.filter((item) => item.id !== clientId);
              migrationIds.delete(clientId);
              publishWorkspaces();
              publishSettledStatus();
              acknowledgeMigration();
              return true;
            }
          }
          if (document.status === "active") {
            if (!(await mutate("archive", workspace, document))) return false;
            document = documents.get(clientId);
          }
          if (!document || document.status !== "archived") return false;
          const [response, body] = await send(`${WORKSPACE_API}/${encodeURIComponent(document.id)}/permanent?revision=${document.revision}`, { method: "DELETE" });
          if (!response.ok) {
            handleRejected(response, body, workspace);
            return false;
          }
          documents.delete(clientId);
          local = local.filter((item) => item.id !== clientId);
          migrationIds.delete(clientId);
          publishWorkspaces();
          updateQuota(body);
          publishSettledStatus();
          acknowledgeMigration();
          return true;
        } catch (error) {
          fail(error, clientId);
          return false;
        }
      });
    },
    importDocument: async (document, clientId) => {
      if (!active || conflicts.length) return false;
      return mutations.run(clientId ?? "__workspace_import__", async () => {
        if (!active || conflicts.length) return false;
        publishStatus({ phase: "saving", pendingCount: Math.max(1, pendingOperations()), issue: undefined });
        try {
          const [response, body] = await send(`${WORKSPACE_API}/import`, {
            method: "POST",
            body: JSON.stringify({ document, ...(clientId ? { clientId } : {}) })
          });
          if (!response.ok) {
            handleRejected(response, body);
            return false;
          }
          const imported = parse(body.workspace);
          if (!imported) throw new Error("Invalid workspace import response");
          keep(imported);
          replaceLocal(imported.workspace);
          updateQuota(body);
          publishSettledStatus();
          return true;
        } catch (error) {
          fail(error, clientId);
          return false;
        }
      });
    },
    rollbackLatest: async (clientId) => {
      if (!active || conflicts.length || status.phase !== "saved" || status.pendingCount !== 0) return undefined;
      return mutations.run(clientId, async () => {
        const document = documents.get(clientId);
        const current = local.find((workspace) => workspace.id === clientId);
        if (!active || conflicts.length || !document || !current || current.archivedAt || pendingOperations()) return undefined;
        publishStatus({ phase: "saving", pendingCount: 1, issue: undefined });
        try {
          let target: RemoteWorkspace | undefined;
          const [revisionResponse, revisionBody] =
            await requestWorkspaceCollection(
              send,
              `${WORKSPACE_API}/${encodeURIComponent(document.id)}/revisions`,
              "revisions",
              (items) => {
                target = items
                  .map(parse)
                  .filter(
                    (item): item is RemoteWorkspace => item !== undefined
                  )
                  .find(
                    (revision) =>
                      revision.revision < document.revision &&
                      !sameWorkspaceVersion(current, revision.workspace)
                  );
                return target !== undefined;
              }
            );
          if (!revisionResponse.ok || !Array.isArray((revisionBody as { revisions?: unknown }).revisions)) {
            handleRejected(revisionResponse, revisionBody, current);
            return undefined;
          }
          target ??= ((revisionBody as { revisions: unknown[] }).revisions)
            .map(parse)
            .filter((item): item is RemoteWorkspace => item !== undefined)
            .find(
              (revision) =>
                revision.revision < document.revision &&
                !sameWorkspaceVersion(current, revision.workspace)
            );
          if (!target) {
            publishSettledStatus();
            return undefined;
          }
          const latestDocument = documents.get(clientId);
          const latestLocal = local.find((workspace) => workspace.id === clientId);
          if (!latestDocument || latestDocument.revision !== document.revision || !latestLocal || !sameWorkspace(latestLocal, current)) {
            publishSettledStatus();
            return undefined;
          }
          const [response, body] = await send(`${WORKSPACE_API}/${encodeURIComponent(document.id)}/rollback`, {
            method: "POST",
            body: JSON.stringify({ revision: document.revision, targetRevision: target.revision })
          });
          if (!response.ok) {
            handleRejected(response, body, current);
            return undefined;
          }
          const saved = parse(body.workspace);
          if (!saved) throw new Error("Invalid workspace rollback response");
          keep(saved);
          const restored: Workspace = {
            ...saved.workspace,
            history: [...current.history, workspaceRevisionSnapshot(current)].slice(-20)
          };
          replaceLocal(restored);
          updateQuota(body);
          publishSettledStatus();
          return restored;
        } catch (error) {
          fail(error, clientId);
          return undefined;
        }
      });
    },
    retry: () => {
      if (!active || conflicts.length || pulling || flushing || dirtyHint) return;
      if (hasSuccessfulPull && pendingOperations() > 0) {
        publishStatus({ phase: "saving", pendingCount: pendingOperations(), issue: undefined });
        schedule(0);
        return;
      }
      void pull();
    },
    resolveConflict: (action) => {
      if (!active) return;
      const selected = conflicts.shift();
      if (!selected) return;
      if (action === "retry" && (selected.code === "workspace_archived" || selected.code === "workspace_deleted")) {
        conflicts.unshift(selected);
        publishConflictStatus();
        return;
      }
      if (action === "reload") {
        if (selected.current) replaceLocal(selected.current.workspace);
        else {
          local = local.filter((workspace) => workspace.id !== selected.local.id);
          migrationIds.delete(selected.local.id);
          publishWorkspaces();
        }
      } else if (action === "keep-copy") {
        const copy = workspaceConflictCopy(selected.local, local);
        local = selected.current
          ? local.map((workspace) => (workspace.id === selected.local.id ? selected.current!.workspace : workspace))
          : local.filter((workspace) => workspace.id !== selected.local.id);
        local = [copy, ...local];
        if (migrationIds.delete(selected.local.id)) migrationIds.add(copy.id);
        publishWorkspaces();
      } else {
        if (selected.current) keep(selected.current);
      }
      publishSettledStatus();
      acknowledgeMigration();
    },
    dispose: () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    }
  };

  function acceptSavedWorkspace(sent: Workspace, saved: RemoteWorkspace): void {
    keep(saved);
    const current = local.find((workspace) => workspace.id === sent.id);
    if (!current || !sameWorkspace(current, sent)) return;
    if (Boolean(current.archivedAt) !== (saved.status === "archived")) return;
    if (!sameWorkspaceVersion(current, saved.workspace)) return;
    replaceLocal({ ...saved.workspace, history: current.history });
  }
}
