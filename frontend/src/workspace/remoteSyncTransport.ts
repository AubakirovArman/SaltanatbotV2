import { getCsrfToken } from "../auth/client";
import type { RemoteWorkspace } from "./remoteSyncTypes";
import { workspaceRemotePayload, type Workspace } from "./workspaces";

export const WORKSPACE_API = "/api/workspaces";

export interface RemoteBody {
  code?: unknown;
  error?: unknown;
  current?: unknown;
  currentMetadata?: unknown;
  workspace?: unknown;
  workspaces?: unknown;
  revisions?: unknown;
  quota?: unknown;
  page?: unknown;
}

export type WorkspaceMutationAction = "create" | "update" | "rename" | "archive" | "restore";
export type WorkspaceSend = (path: string, init?: RequestInit) => Promise<[Response, RemoteBody]>;

const MAX_WORKSPACE_PAGE_RESPONSE_BYTES = 4 * 1_048_576;
const MAX_WORKSPACE_COLLECTION_BYTES = 80 * 1_048_576;
const MAX_WORKSPACE_LIST_PAGES = 128;
const MAX_WORKSPACE_REVISION_PAGES = 32;

function workspaceInput(workspace: Workspace) {
  return {
    clientId: workspace.id,
    name: workspace.name,
    schemaVersion: workspace.schemaVersion,
    payload: workspaceRemotePayload(workspace)
  };
}

export async function sendWorkspaceRequest(expectedUserId: string, path: string, init?: RequestInit): Promise<[Response, RemoteBody]> {
  const csrf = init?.method && init.method !== "GET" ? getCsrfToken() : undefined;
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      "X-SBV2-Expected-User": expectedUserId,
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...init?.headers
    }
  });
  return [response, (await response.json().catch(() => ({}))) as RemoteBody];
}

export function requestWorkspaceMutation(
  send: WorkspaceSend,
  action: WorkspaceMutationAction,
  workspace: Workspace,
  document: RemoteWorkspace | undefined,
  keepalive = false
): Promise<[Response, RemoteBody]> {
  if (action === "create") {
    return send(WORKSPACE_API, { method: "POST", keepalive, body: JSON.stringify(workspaceInput(workspace)) });
  }
  if (!document) throw new Error(`Workspace ${action} requires a remote document`);
  const path = `${WORKSPACE_API}/${encodeURIComponent(document.id)}`;
  if (action === "update") {
    return send(path, {
      method: "PUT",
      keepalive,
      body: JSON.stringify({ ...workspaceInput(workspace), revision: document.revision })
    });
  }
  if (action === "rename") {
    return send(`${path}/name`, {
      method: "PATCH",
      keepalive,
      body: JSON.stringify({ revision: document.revision, name: workspace.name })
    });
  }
  return send(`${path}/${action}`, {
    method: "POST",
    keepalive,
    body: JSON.stringify({ revision: document.revision })
  });
}

export async function requestWorkspaceCollection(
  send: WorkspaceSend,
  path: string,
  key: "workspaces" | "revisions",
  stopAfterPage?: (items: unknown[]) => boolean
): Promise<[Response, RemoteBody]> {
  const all: unknown[] = [];
  const seenItems = new Set<string>();
  const seenCursors = new Set<string>();
  const maxPages =
    key === "workspaces"
      ? MAX_WORKSPACE_LIST_PAGES
      : MAX_WORKSPACE_REVISION_PAGES;
  let aggregateBytes = 0;
  let nextPath = path;
  let latestResponse: Response | undefined;
  let previousCursor: string | undefined;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const [response, body] = await send(nextPath);
    latestResponse = response;
    if (!response.ok) return [response, body];
    const items = body[key];
    if (!Array.isArray(items)) {
      throw new Error(`Invalid workspace ${key} response`);
    }
    const responseBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    if (responseBytes > MAX_WORKSPACE_PAGE_RESPONSE_BYTES) {
      throw new Error(`Workspace ${key} page exceeds the response limit`);
    }
    aggregateBytes += responseBytes;
    if (aggregateBytes > MAX_WORKSPACE_COLLECTION_BYTES) {
      throw new Error(`Workspace ${key} collection exceeds the client limit`);
    }
    for (const item of items) {
      const itemKey = collectionItemKey(item, key);
      if (itemKey !== undefined && seenItems.has(itemKey)) continue;
      if (itemKey !== undefined) seenItems.add(itemKey);
      all.push(item);
    }
    if (stopAfterPage?.(items)) {
      return [response, { ...body, [key]: all }];
    }
    const cursor = nextCursor(body.page);
    if (cursor === undefined || cursor === null) {
      return [response, { ...body, [key]: all }];
    }
    if (seenCursors.has(cursor)) {
      throw new Error(`Workspace ${key} pagination cursor did not advance`);
    }
    if (
      previousCursor !== undefined &&
      ((key === "workspaces" && cursor <= previousCursor) ||
        (key === "revisions" && Number(cursor) >= Number(previousCursor)))
    ) {
      throw new Error(`Workspace ${key} pagination cursor did not advance`);
    }
    seenCursors.add(cursor);
    previousCursor = cursor;
    nextPath = withCursor(path, cursor);
  }
  if (!latestResponse) throw new Error(`Workspace ${key} pagination failed`);
  throw new Error(`Workspace ${key} pagination exceeded ${maxPages} pages`);
}

function nextCursor(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") {
    throw new Error("Invalid workspace page metadata");
  }
  const page = value as Record<string, unknown>;
  if (page.hasMore === false) return null;
  if (page.hasMore !== true) throw new Error("Invalid workspace page metadata");
  const cursor = page.nextCursor;
  if (
    (typeof cursor !== "string" || cursor.length === 0) &&
    (!Number.isSafeInteger(cursor) || Number(cursor) < 1)
  ) {
    throw new Error("Invalid workspace page cursor");
  }
  return String(cursor);
}

function collectionItemKey(
  value: unknown,
  key: "workspaces" | "revisions"
): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (key === "workspaces") {
    return typeof item.clientId === "string" && item.clientId.length > 0
      ? item.clientId
      : undefined;
  }
  return Number.isSafeInteger(item.revision) && Number(item.revision) > 0
    ? String(item.revision)
    : undefined;
}

function withCursor(path: string, cursor: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}cursor=${encodeURIComponent(cursor)}`;
}
