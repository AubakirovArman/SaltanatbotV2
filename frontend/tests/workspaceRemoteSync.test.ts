// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureWorkspace, reviseWorkspace, type Workspace } from "../src/workspace/workspaces";
import { createWorkspaceRemoteSync, mergeRemoteWorkspaces, type RemoteWorkspace } from "../src/workspace/remoteSync";

const context = {
  symbol: "BTCUSDT",
  timeframe: "1h" as const,
  chartType: "candles" as const,
  cryptoExchange: "binance" as const,
  indicators: [],
  theme: "dark" as const
};
const OWNER_A = "00000000-0000-4000-8000-000000000031";

function remoteDocument(workspace: Workspace, revision = 1): RemoteWorkspace {
  return {
    id: "123e4567-e89b-42d3-a456-426614174000",
    clientId: workspace.id,
    revision,
    workspace
  };
}

function envelope(item: RemoteWorkspace) {
  return {
    id: item.id,
    clientId: item.clientId,
    revision: item.revision,
    name: item.workspace.name,
    schemaVersion: item.workspace.schemaVersion,
    payload: item.workspace,
    createdAt: new Date(item.workspace.createdAt).toISOString(),
    updatedAt: new Date(item.workspace.updatedAt).toISOString()
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("authenticated workspace background sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.cookie = "sbv2_csrf=workspace-test";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("merges by client id and keeps the payload with the newest updatedAt", () => {
    const first = captureWorkspace("Local winner", context, 200);
    const older = { ...first, name: "Old server copy", updatedAt: 100 };
    const second = captureWorkspace("Remote only", context, 300);

    expect(mergeRemoteWorkspaces([first], [remoteDocument(older), remoteDocument(second)])).toMatchObject([
      { id: first.id, name: "Local winner" },
      { id: second.id, name: "Remote only" }
    ]);
    const aliased = { ...remoteDocument({ ...older, id: "payload-id" }), clientId: first.id };
    expect(mergeRemoteWorkspaces([{ ...first, updatedAt: 50 }], [aliased])[0]).toMatchObject({ id: first.id, name: "Old server copy" });
  });

  it("debounces updates and retries one optimistic 409 without losing the newer local copy", async () => {
    const server = captureWorkspace("Server", context, 100);
    const local = reviseWorkspace(server, { ...context, timeframe: "4h" }, 300);
    const conflict = { ...server, name: "Concurrent server", updatedAt: 200 };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [envelope(remoteDocument(server, 2))] }))
      .mockResolvedValueOnce(json({ code: "workspace_conflict", current: envelope(remoteDocument(conflict, 3)) }, 409))
      .mockResolvedValueOnce(json({ workspace: envelope(remoteDocument(local, 4)) }));
    vi.stubGlobal("fetch", fetchMock);
    const received: Workspace[][] = [];
    const sync = createWorkspaceRemoteSync(OWNER_A, (next) => received.push(next));

    await sync.start([local]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(899);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const firstUpdate = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { revision: number };
    const retry = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as { revision: number };
    expect([firstUpdate.revision, retry.revision]).toEqual([2, 3]);
    expect(firstUpdate).not.toHaveProperty("ownerId");
    expect(received.at(-1)?.[0]).toMatchObject({ timeframe: "4h", updatedAt: 300 });
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("X-CSRF-Token")).toBe("workspace-test");
    expect(fetchMock.mock.calls.every(([, init]) => new Headers(init?.headers).get("X-SBV2-Expected-User") === OWNER_A)).toBe(true);
    sync.dispose();
  });

  it("synchronizes current-session deletion and absorbs network failures", async () => {
    const workspace = captureWorkspace("Delete", context, 100);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [envelope(remoteDocument(workspace, 1))] }))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(json({ workspaces: [envelope(remoteDocument(workspace, 1))] }))
      .mockResolvedValueOnce(json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const sync = createWorkspaceRemoteSync(OWNER_A, () => undefined);

    await expect(sync.start([workspace])).resolves.toBeUndefined();
    sync.remove(workspace.id);
    await vi.runOnlyPendingTimersAsync();
    sync.retry();
    await vi.runOnlyPendingTimersAsync();

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2);
    expect(fetchMock.mock.calls.every(([, init]) => new Headers(init?.headers).get("X-SBV2-Expected-User") === OWNER_A)).toBe(true);
    sync.dispose();
  });

  it("sends the immutable expected owner on GET and POST when creating a remote workspace", async () => {
    const workspace = captureWorkspace("New remote", context, 100);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [] }))
      .mockResolvedValueOnce(json({ workspace: envelope(remoteDocument(workspace, 1)) }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const sync = createWorkspaceRemoteSync(OWNER_A, () => undefined);

    await sync.start([workspace]);
    await vi.advanceTimersByTimeAsync(900);

    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "POST"]);
    expect(fetchMock.mock.calls.every(([, init]) => new Headers(init?.headers).get("X-SBV2-Expected-User") === OWNER_A)).toBe(true);
    sync.dispose();
  });

  it("keeps initial network failure out of the local workspace flow", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const sync = createWorkspaceRemoteSync(OWNER_A, () => undefined);
    const workspace = captureWorkspace("Offline", context, 100);

    await expect(sync.start([workspace])).resolves.toBeUndefined();
    expect(() => sync.update([workspace])).not.toThrow();
    expect(() => sync.remove(workspace.id)).not.toThrow();
    sync.dispose();
  });

  it("fails closed when stale owner A state is sent with owner B's authenticated cookie", async () => {
    const staleOwnerWorkspace = captureWorkspace("Owner A stale state", context, 100);
    const fetchMock = vi.fn().mockImplementation((_path: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("X-SBV2-Expected-User")).toBe(OWNER_A);
      return Promise.resolve(json({ code: "workspace_owner_mismatch" }, 409));
    });
    vi.stubGlobal("fetch", fetchMock);
    const received = vi.fn();
    const sync = createWorkspaceRemoteSync(OWNER_A, received);

    await sync.start([staleOwnerWorkspace]);
    sync.update([reviseWorkspace(staleOwnerWorkspace, { ...context, timeframe: "4h" }, 200)]);
    await vi.runOnlyPendingTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();
    expect(received).not.toHaveBeenCalled();
    sync.dispose();
  });
});
