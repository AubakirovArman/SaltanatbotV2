import { getCsrfToken } from "../auth/client";
import { normalizeWorkspace, type Workspace } from "./workspaces";

const API = "/api/workspaces";

export interface RemoteWorkspace {
  id: string;
  clientId: string;
  revision: number;
  workspace: Workspace;
}

interface RemoteBody {
  current?: unknown;
  workspace?: unknown;
  workspaces?: unknown;
}

export interface WorkspaceRemoteSync {
  start: (workspaces: Workspace[]) => Promise<void>;
  update: (workspaces: Workspace[]) => void;
  remove: (clientId: string) => void;
  retry: () => void;
  dispose: () => void;
}

export function mergeWorkspaceUpdates(local: Workspace[], incoming: Workspace[]): Workspace[] {
  const merged = new Map(local.map((workspace) => [workspace.id, workspace]));
  for (const workspace of incoming) {
    if ((merged.get(workspace.id)?.updatedAt ?? -1) < workspace.updatedAt) merged.set(workspace.id, workspace);
  }
  return [...merged.values()];
}

export function mergeRemoteWorkspaces(local: Workspace[], remote: RemoteWorkspace[]): Workspace[] {
  return mergeWorkspaceUpdates(local, remote.map((item) => {
    const id = local.find((workspace) => workspace.id === item.clientId || workspace.id === item.workspace.id)?.id;
    return id && id !== item.workspace.id ? { ...item.workspace, id } : item.workspace;
  }));
}

/** Local state is authoritative while this owner-scoped, authenticated sync runs in the background. */
export function createWorkspaceRemoteSync(onRemote: (workspaces: Workspace[]) => void): WorkspaceRemoteSync {
  const documents = new Map<string, RemoteWorkspace>();
  const deleted = new Set<string>();
  let workspaces: Workspace[] = [];
  let timer: number | undefined;
  let ready = false;
  let active = true;
  let queue = Promise.resolve();

  const parse = (value: unknown): RemoteWorkspace | undefined => {
    const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const workspace = normalizeWorkspace(item.payload);
    return workspace && typeof item.id === "string" && typeof item.clientId === "string"
      && typeof item.revision === "number" && Number.isSafeInteger(item.revision) && item.revision > 0
      ? { id: item.id, clientId: item.clientId, revision: item.revision, workspace }
      : undefined;
  };
  const keep = (document: RemoteWorkspace) => {
    documents.set(document.clientId, document);
    documents.set(document.workspace.id, document);
  };
  const forget = (document: RemoteWorkspace) => {
    documents.delete(document.clientId);
    documents.delete(document.workspace.id);
  };
  const send = async (path: string, init?: RequestInit): Promise<[Response, RemoteBody]> => {
    const csrf = init?.method && getCsrfToken();
    const response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) }
    });
    return [response, await response.json().catch(() => ({})) as RemoteBody];
  };

  const remove = async (clientId: string, retry = true): Promise<void> => {
    const document = documents.get(clientId);
    if (!document) return;
    const [response, body] = await send(`${API}/${encodeURIComponent(document.id)}?revision=${document.revision}`, { method: "DELETE" });
    if (response.ok || response.status === 404) {
      forget(document);
      return;
    }
    const current = response.status === 409 ? parse(body.current) : undefined;
    if (current) {
      keep(current);
      if (retry) await remove(clientId, false);
    }
  };

  const save = async (workspace: Workspace, document?: RemoteWorkspace, retry = true): Promise<void> => {
    const [response, body] = await send(document ? `${API}/${encodeURIComponent(document.id)}` : API, {
      method: document ? "PUT" : "POST",
      body: JSON.stringify({ clientId: workspace.id, name: workspace.name, schemaVersion: workspace.schemaVersion,
        payload: workspace, ...(document ? { revision: document.revision } : {}) })
    });
    const current = parse(response.ok ? body.workspace : response.status === 409 ? body.current : undefined);
    if (!current) return;
    keep(current);
    if (deleted.has(workspace.id)) return remove(workspace.id);
    if (response.status !== 409) return;
    if (current.workspace.updatedAt > workspace.updatedAt) {
      if (active) onRemote([current.workspace]);
    } else if (retry) await save(workspace, current, false);
  };

  const flush = async () => {
    if (!active || !ready) return;
    try {
      for (const id of deleted) await remove(id).catch(() => undefined);
      for (const workspace of workspaces) {
        if (deleted.has(workspace.id)) continue;
        const document = documents.get(workspace.id);
        if (!document || document.workspace.updatedAt < workspace.updatedAt) await save(workspace, document).catch(() => undefined);
        else if (document.workspace.updatedAt > workspace.updatedAt && active) onRemote([document.workspace]);
      }
    } catch {
      // Network and session failures never escape into the local UI.
    }
  };
  const schedule = (delay = 900) => {
    if (!active || !ready) return;
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      queue = queue.then(flush, flush);
    }, delay);
  };
  const pull = async () => {
    try {
      const [response, body] = await send(API);
      if (!active || !response.ok || !Array.isArray(body.workspaces)) return;
      const remote = body.workspaces.map(parse).filter((item): item is RemoteWorkspace => item !== undefined);
      remote.forEach(keep);
      ready = true;
      workspaces = mergeRemoteWorkspaces(workspaces, remote.filter((item) => !deleted.has(item.clientId) && !deleted.has(item.workspace.id)));
      onRemote(workspaces);
      schedule();
    } catch {
      // The online event invokes pull again.
    }
  };

  return {
    start: async (value) => {
      workspaces = value;
      await pull();
    },
    update: (value) => {
      workspaces = value;
      schedule();
    },
    remove: (id) => {
      deleted.add(id);
      schedule(0);
    },
    retry: () => {
      void pull().finally(() => schedule(0));
    },
    dispose: () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    }
  };
}
