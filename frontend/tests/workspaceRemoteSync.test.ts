// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureWorkspace, reviseWorkspace, type Workspace } from "../src/workspace/workspaces";
import { createWorkspaceRemoteSync, type RemoteWorkspace, type WorkspaceSyncStatus } from "../src/workspace/remoteSync";

const context = {
  symbol: "BTCUSDT",
  timeframe: "1h" as const,
  chartType: "candles" as const,
  cryptoExchange: "binance" as const,
  indicators: [],
  theme: "dark" as const
};
const OWNER_A = "00000000-0000-4000-8000-000000000031";

function remoteDocument(workspace: Workspace, revision = 1, status: RemoteWorkspace["status"] = "active"): RemoteWorkspace {
  return {
    id: `document-${workspace.id}`,
    clientId: workspace.id,
    revision,
    status,
    archivedAt: status === "archived" ? new Date(1_000 + revision).toISOString() : undefined,
    workspace: { ...workspace, archivedAt: undefined }
  };
}

function envelope(item: RemoteWorkspace) {
  return {
    id: item.id,
    clientId: item.clientId,
    revision: item.revision,
    status: item.status,
    archivedAt: item.archivedAt ?? null,
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

function page(body: Record<string, unknown>, hasMore: boolean, nextCursor: string | null): Record<string, unknown> {
  return {
    ...body,
    page: {
      itemLimit: 25,
      responseByteLimit: 4 * 1_048_576,
      returnedItems: Array.isArray(body.workspaces)
        ? body.workspaces.length
        : Array.isArray(body.revisions)
          ? body.revisions.length
          : 0,
      returnedPayloadBytes: 1,
      responseBytes: 1,
      hasMore,
      nextCursor
    }
  };
}

function harness(initialKnownIds: string[] = []) {
  const workspaces: Workspace[][] = [];
  const statuses: WorkspaceSyncStatus[] = [];
  const knownIds: string[][] = [];
  const migrationAcks = vi.fn();
  const sync = createWorkspaceRemoteSync(OWNER_A, {
    onWorkspaces: (next) => workspaces.push(next),
    onStatus: (next) => statuses.push(next),
    knownRemoteClientIds: initialKnownIds,
    onKnownRemoteClientIds: (next) => knownIds.push(next),
    onMigrationAcknowledged: migrationAcks
  });
  return { sync, workspaces, statuses, knownIds, migrationAcks };
}

function revised(workspace: Workspace, timeframe: "4h" | "1d", now: number): Workspace {
  return reviseWorkspace(workspace, { ...context, timeframe }, now);
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

  it("stops on optimistic conflict and writes only after an explicit retry", async () => {
    const server = captureWorkspace("Server", context, 100);
    const local = revised(server, "4h", 300);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [envelope(remoteDocument(server, 2))] }))
      .mockResolvedValueOnce(json({ workspace: envelope(remoteDocument(local, 3)) }));
    vi.stubGlobal("fetch", fetchMock);
    const { sync, workspaces, statuses } = harness();

    await sync.start([local]);
    expect(statuses.at(-1)).toMatchObject({ phase: "conflict", issue: { clientId: local.id } });
    await vi.runOnlyPendingTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    sync.resolveConflict("retry");
    await vi.runOnlyPendingTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ revision: 2, payload: { timeframe: "4h" } });
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("X-CSRF-Token")).toBe("workspace-test");
    expect(workspaces.at(-1)?.[0]).toMatchObject({ id: local.id, timeframe: "4h" });
    expect(statuses.at(-1)).toMatchObject({ phase: "saved", pendingCount: 0 });
    sync.dispose();
  });

  it("queues two simultaneous conflicts without overwriting either local decision", async () => {
    const serverA = captureWorkspace("Server A", context, 100);
    const serverB = captureWorkspace("Server B", context, 110);
    const localA = revised(serverA, "4h", 300);
    const localB = revised(serverB, "1d", 310);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [envelope(remoteDocument(serverA, 2)), envelope(remoteDocument(serverB, 5))] }))
      .mockResolvedValueOnce(json({ workspace: envelope(remoteDocument(localB, 6)) }));
    vi.stubGlobal("fetch", fetchMock);
    const { sync, workspaces, statuses } = harness();

    await sync.start([localA, localB]);
    expect(statuses.at(-1)?.issue?.clientId).toBe(localA.id);

    sync.resolveConflict("reload");
    expect(statuses.at(-1)).toMatchObject({ phase: "conflict", issue: { clientId: localB.id } });
    expect(workspaces.at(-1)?.find((item) => item.id === localA.id)?.timeframe).toBe("1h");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    sync.resolveConflict("retry");
    await vi.runOnlyPendingTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ revision: 5, payload: { timeframe: "1d" } });
    expect(workspaces.at(-1)?.find((item) => item.id === localB.id)?.timeframe).toBe("1d");
    expect(statuses.at(-1)?.phase).toBe("saved");
    sync.dispose();
  });

  it("exhausts list pages, deduplicates client IDs, and detects conflicts from later pages", async () => {
    const serverA = captureWorkspace("Server A", context, 100);
    const serverB = captureWorkspace("Server B", context, 110);
    const localB = revised(serverB, "4h", 300);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          page(
            { workspaces: [envelope(remoteDocument(serverA, 1))] },
            true,
            "00000000-0000-4000-8000-000000000101"
          )
        )
      )
      .mockResolvedValueOnce(
        json(
          page(
            {
              workspaces: [
                envelope(remoteDocument(serverA, 1)),
                envelope(remoteDocument(serverB, 4))
              ]
            },
            false,
            null
          )
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    const { sync, workspaces, statuses, knownIds } = harness();

    await sync.start([localB]);

    expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual([
      "/api/workspaces?status=all",
      "/api/workspaces?status=all&cursor=00000000-0000-4000-8000-000000000101"
    ]);
    expect(workspaces.at(-1)?.filter((item) => item.id === serverA.id)).toHaveLength(1);
    expect(statuses.at(-1)).toMatchObject({
      phase: "conflict",
      issue: { clientId: serverB.id }
    });
    expect(knownIds.at(-1)).toEqual(
      expect.arrayContaining([serverA.id, serverB.id])
    );
    sync.dispose();
  });

  it("keeps the newest local edit when a conflict is preserved as a copy", async () => {
    const server = captureWorkspace("Server", context, 100);
    const firstLocal = revised(server, "4h", 200);
    const newestLocal = reviseWorkspace(
      firstLocal,
      {
        ...context,
        timeframe: "1d",
        drawings: [
          {
            chartId: "chart-1",
            symbol: "BTCUSDT",
            drawings: [
              {
                id: "newest-line",
                tool: "hline",
                points: [{ time: 1, price: 123 }],
                style: { color: "#fff", width: 1 }
              }
            ]
          }
        ],
        selectedStrategy: {
          id: "newest-strategy",
          revision: 7,
          hash: "newest-hash",
          parameters: { period: 55 }
        }
      },
      300
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [envelope(remoteDocument(server, 2))] }));
    vi.stubGlobal("fetch", fetchMock);
    const { sync, workspaces, statuses } = harness();

    await sync.start([firstLocal]);
    expect(statuses.at(-1)?.phase).toBe("conflict");

    sync.update([newestLocal]);
    expect(statuses.at(-1)).toMatchObject({
      phase: "conflict",
      issue: {
        local: {
          timeframe: "1d",
          selectedStrategy: { id: "newest-strategy", revision: 7 }
        }
      }
    });

    sync.resolveConflict("keep-copy");
    const preserved = workspaces.at(-1)?.find((workspace) => workspace.id !== server.id);
    expect(preserved).toMatchObject({
      timeframe: "1d",
      selectedStrategy: { id: "newest-strategy", revision: 7, parameters: { period: 55 } }
    });
    expect(preserved?.drawings[0]?.drawings).toMatchObject([{ id: "newest-line" }]);
    sync.dispose();
  });

  it("does not let an older in-flight response overwrite a newer local edit", async () => {
    const server = captureWorkspace("Server", context, 100);
    const firstEdit = revised(server, "4h", 200);
    const secondEdit = revised(firstEdit, "1d", 300);
    let resolveFirstUpdate!: (response: Response) => void;
    const firstUpdate = new Promise<Response>((resolve) => {
      resolveFirstUpdate = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [envelope(remoteDocument(server, 2))] }))
      .mockReturnValueOnce(firstUpdate)
      .mockResolvedValueOnce(json({ workspace: envelope(remoteDocument(secondEdit, 4)) }));
    vi.stubGlobal("fetch", fetchMock);
    const { sync, workspaces } = harness();

    await sync.start([server]);
    sync.update([firstEdit]);
    await vi.advanceTimersByTimeAsync(900);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    sync.update([secondEdit]);
    sync.retry();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolveFirstUpdate(json({ workspace: envelope(remoteDocument(firstEdit, 3)) }));
    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({ revision: 3, payload: { timeframe: "1d" } });
    expect(workspaces.some((items) => items.some((item) => item.id === server.id && item.timeframe === "4h"))).toBe(false);
    expect(workspaces.at(-1)?.[0]?.timeframe).toBe("1d");
    sync.dispose();
  });

  it("retries pending offline edits against the known revision without a destructive pull", async () => {
    const server = captureWorkspace("Server", context, 100);
    const local = revised(server, "4h", 200);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [envelope(remoteDocument(server, 1))] }))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(json({ workspace: envelope(remoteDocument(local, 2)) }));
    vi.stubGlobal("fetch", fetchMock);
    const { sync, statuses, workspaces } = harness();

    await sync.start([server]);
    sync.update([local]);
    await sync.flushNow({ keepalive: true });
    expect(statuses.at(-1)?.phase).toBe("offline");
    expect(fetchMock.mock.calls[1]?.[1]?.keepalive).toBe(true);

    sync.retry();
    await vi.runOnlyPendingTimersAsync();

    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "PUT", "PUT"]);
    expect(statuses.at(-1)).toMatchObject({ phase: "saved", pendingCount: 0 });
    expect(workspaces.at(-1)?.[0]).toMatchObject({ timeframe: "4h" });
    sync.dispose();
  });

  it("keeps an edit made during a safe pull when the server baseline did not change", async () => {
    const server = captureWorkspace("Server", context, 100);
    const local = revised(server, "4h", 200);
    let resolvePull!: (response: Response) => void;
    const pullResponse = new Promise<Response>((resolve) => {
      resolvePull = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [envelope(remoteDocument(server, 1))] }))
      .mockReturnValueOnce(pullResponse)
      .mockResolvedValueOnce(json({ workspace: envelope(remoteDocument(local, 2)) }));
    vi.stubGlobal("fetch", fetchMock);
    const { sync, statuses } = harness();

    await sync.start([server]);
    sync.retry();
    sync.update([local]);
    resolvePull(json({ workspaces: [envelope(remoteDocument(server, 1))] }));
    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();

    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "GET", "PUT"]);
    expect(statuses.some((status) => status.phase === "conflict")).toBe(false);
    expect(statuses.at(-1)?.phase).toBe("saved");
    sync.dispose();
  });

  it("flushes the latest snapshot immediately with keepalive and reports Saved only after ACK", async () => {
    const server = captureWorkspace("Server", context, 100);
    const local = revised(server, "4h", 200);
    let resolveUpdate!: (response: Response) => void;
    const updateResponse = new Promise<Response>((resolve) => {
      resolveUpdate = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [envelope(remoteDocument(server, 1))] }))
      .mockReturnValueOnce(updateResponse);
    vi.stubGlobal("fetch", fetchMock);
    const { sync, statuses } = harness();

    await sync.start([server]);
    sync.markDirty();
    expect(statuses.at(-1)).toMatchObject({ phase: "saving", pendingCount: 1 });
    sync.retry();
    await vi.runOnlyPendingTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toMatchObject({ phase: "saving", pendingCount: 1 });
    sync.update([local]);
    expect(statuses.at(-1)).toMatchObject({ phase: "saving", pendingCount: 1 });

    const flushed = sync.flushNow({ keepalive: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.keepalive).toBe(true);
    expect(statuses.at(-1)?.phase).toBe("saving");

    resolveUpdate(json({ workspace: envelope(remoteDocument(local, 2)) }));
    await flushed;
    expect(statuses.at(-1)).toMatchObject({ phase: "saved", pendingCount: 0 });
    sync.dispose();
  });

  it("saves edited payload before archiving and uses the returned wrapper revision", async () => {
    const server = captureWorkspace("Server", context, 100);
    const archivedEdit = { ...revised(server, "4h", 200), archivedAt: 300 };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [envelope(remoteDocument(server, 1))] }))
      .mockResolvedValueOnce(json({ workspace: envelope(remoteDocument(archivedEdit, 2)) }))
      .mockResolvedValueOnce(json({ workspace: envelope(remoteDocument(archivedEdit, 3, "archived")) }));
    vi.stubGlobal("fetch", fetchMock);
    const { sync, workspaces, statuses } = harness();

    await sync.start([server]);
    sync.update([archivedEdit]);
    await vi.advanceTimersByTimeAsync(900);

    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "PUT", "POST"]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ revision: 1, payload: { timeframe: "4h" } });
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/archive");
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ revision: 2 });
    expect(workspaces.at(-1)?.[0]).toMatchObject({ timeframe: "4h", archivedAt: expect.any(Number) });
    expect(statuses.at(-1)?.phase).toBe("saved");
    sync.dispose();
  });

  it("saves a renamed workspace before archiving it", async () => {
    const server = captureWorkspace("Server", context, 100);
    const renamed = { ...server, name: "Renamed", updatedAt: 200, archivedAt: 300 };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [envelope(remoteDocument(server, 4))] }))
      .mockResolvedValueOnce(json({ workspace: envelope(remoteDocument(renamed, 5)) }))
      .mockResolvedValueOnce(json({ workspace: envelope(remoteDocument(renamed, 6, "archived")) }));
    vi.stubGlobal("fetch", fetchMock);
    const { sync } = harness();

    await sync.start([server]);
    sync.update([renamed]);
    await vi.advanceTimersByTimeAsync(900);

    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "PATCH", "POST"]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ revision: 4, name: "Renamed" });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ revision: 5 });
    sync.dispose();
  });

  it("preserves an edited archive after quota rejection and exposes keep-copy resolution", async () => {
    const server = captureWorkspace("Server", context, 100);
    const archivedEdit = { ...revised(server, "4h", 200), archivedAt: 300 };
    const quota = {
      activeCount: 20,
      activeLimit: 20,
      totalCount: 20,
      totalLimit: 100,
      payloadBytesUsed: 1_000,
      payloadBytesLimit: 2_000,
      maxDocumentBytes: 1_048_576,
      maxRevisions: 20
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [envelope(remoteDocument(server, 1))] }))
      .mockResolvedValueOnce(json({ code: "workspace_storage_quota_exceeded", quota }, 429));
    vi.stubGlobal("fetch", fetchMock);
    const { sync, workspaces, statuses } = harness();

    await sync.start([server]);
    sync.update([archivedEdit]);
    await vi.advanceTimersByTimeAsync(900);

    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "PUT"]);
    expect(statuses.at(-1)).toMatchObject({
      phase: "quota",
      issue: {
        code: "workspace_storage_quota_exceeded",
        local: { timeframe: "4h", archivedAt: 300 },
        current: { timeframe: "1h", archivedAt: undefined }
      }
    });

    sync.resolveConflict("keep-copy");
    const preserved = workspaces.at(-1)?.find((workspace) => workspace.id !== server.id);
    expect(preserved).toMatchObject({ timeframe: "4h", archivedAt: undefined });
    expect(workspaces.at(-1)?.find((workspace) => workspace.id === server.id)).toMatchObject({ timeframe: "1h", archivedAt: undefined });
    sync.dispose();
  });

  it("archives an active workspace before creating a quota-increasing document", async () => {
    const active = captureWorkspace("Active", context, 100);
    const archived = { ...active, archivedAt: 500 };
    const created = captureWorkspace("Created", context, 600);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [envelope(remoteDocument(active, 1))] }))
      .mockResolvedValueOnce(json({ workspace: envelope(remoteDocument(active, 2, "archived")) }))
      .mockResolvedValueOnce(json({ workspace: envelope(remoteDocument(created, 1)) }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const { sync } = harness();

    await sync.start([active]);
    sync.update([created, archived]);
    await vi.advanceTimersByTimeAsync(900);

    expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual([
      "/api/workspaces?status=all",
      `/api/workspaces/${remoteDocument(active).id}/archive`,
      "/api/workspaces"
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "POST", "POST"]);
    sync.dispose();
  });

  it("uses the server rename contract and can roll the renamed lineage back", async () => {
    const original = captureWorkspace("Original", context, 100);
    const renamedLocal = { ...original, name: "Renamed", updatedAt: 200 };
    const renamedServer = { ...renamedLocal, revision: 2, savedAt: 250, updatedAt: 250 };
    const rolledBack = { ...original, revision: 3, savedAt: 300, updatedAt: 300 };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [envelope(remoteDocument(original, 1))] }))
      .mockResolvedValueOnce(json({ workspace: envelope(remoteDocument(renamedServer, 2)) }))
      .mockResolvedValueOnce(json({
        revisions: [
          envelope(remoteDocument(renamedServer, 2)),
          envelope(remoteDocument(original, 1))
        ]
      }))
      .mockResolvedValueOnce(json({ workspace: envelope(remoteDocument(rolledBack, 3)) }));
    vi.stubGlobal("fetch", fetchMock);
    const { sync, workspaces } = harness();

    await sync.start([original]);
    sync.update([renamedLocal]);
    await vi.advanceTimersByTimeAsync(900);

    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(`/api/workspaces/${remoteDocument(original).id}/name`);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ revision: 1, name: "Renamed" });
    expect(workspaces.at(-1)?.[0]).toMatchObject({ name: "Renamed", revision: 2, savedAt: 250 });

    const restored = await sync.rollbackLatest(original.id);
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({ revision: 2, targetRevision: 1 });
    expect(restored).toMatchObject({ name: "Original", revision: 3 });
    sync.dispose();
  });

  it("discards a quota-rejected archived local-only workspace after an authoritative absence check", async () => {
    const local = captureWorkspace("Local only", context, 100);
    const quota = {
      activeCount: 20,
      activeLimit: 20,
      totalCount: 20,
      totalLimit: 100,
      payloadBytesUsed: 1_000,
      payloadBytesLimit: 2_000,
      maxDocumentBytes: 1_048_576,
      maxRevisions: 20
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [], quota }))
      .mockResolvedValueOnce(json({ code: "workspace_active_quota_exceeded", quota }, 429))
      .mockResolvedValueOnce(json({ workspaces: [], quota }));
    vi.stubGlobal("fetch", fetchMock);
    const { sync, workspaces, statuses } = harness();

    await sync.start([]);
    sync.update([local]);
    await vi.advanceTimersByTimeAsync(900);
    expect(statuses.at(-1)).toMatchObject({ phase: "quota", issue: { code: "workspace_active_quota_exceeded" } });

    sync.update([{ ...local, archivedAt: 500 }]);
    await expect(sync.purge(local.id)).resolves.toBe(true);

    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "POST", "GET"]);
    expect(workspaces.at(-1)).toEqual([]);
    expect(statuses.at(-1)).toMatchObject({ phase: "saved", pendingCount: 0 });
    sync.dispose();
  });

  it("does not conclude purge absence until every authoritative list page is exhausted", async () => {
    const local = captureWorkspace("Recovered remote", context, 100);
    const unrelated = captureWorkspace("Unrelated", context, 110);
    const remote = remoteDocument(local, 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [] }))
      .mockRejectedValueOnce(new TypeError("create response lost"))
      .mockResolvedValueOnce(
        json(
          page(
            { workspaces: [envelope(remoteDocument(unrelated, 1))] },
            true,
            "00000000-0000-4000-8000-000000000201"
          )
        )
      )
      .mockResolvedValueOnce(
        json(page({ workspaces: [envelope(remote)] }, false, null))
      )
      .mockResolvedValueOnce(
        json({
          workspace: envelope(remoteDocument(local, 2, "archived"))
        })
      )
      .mockResolvedValueOnce(json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { sync, workspaces } = harness();

    await sync.start([]);
    sync.update([local]);
    await vi.advanceTimersByTimeAsync(900);
    sync.update([{ ...local, archivedAt: 500 }]);

    await expect(sync.purge(local.id)).resolves.toBe(true);
    expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual([
      "/api/workspaces?status=all",
      "/api/workspaces",
      "/api/workspaces?status=all",
      "/api/workspaces?status=all&cursor=00000000-0000-4000-8000-000000000201",
      `/api/workspaces/${remote.id}/archive`,
      `/api/workspaces/${remote.id}/permanent?revision=2`
    ]);
    expect(workspaces.at(-1)).toEqual([]);
    sync.dispose();
  });

  it("acknowledges a legacy migration exactly once after explicit purge proves authoritative absence", async () => {
    const legacy = captureWorkspace("Legacy source", context, 100);
    const quota = {
      activeCount: 20,
      activeLimit: 20,
      totalCount: 20,
      totalLimit: 100,
      payloadBytesUsed: 1_000,
      payloadBytesLimit: 2_000,
      maxDocumentBytes: 1_048_576,
      maxRevisions: 20
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [], quota }))
      .mockResolvedValueOnce(json({ code: "workspace_active_quota_exceeded", quota }, 429))
      .mockResolvedValueOnce(json({ workspaces: [], quota }));
    vi.stubGlobal("fetch", fetchMock);
    const { sync, migrationAcks } = harness();

    await sync.start([legacy]);
    await vi.runOnlyPendingTimersAsync();
    expect(migrationAcks).not.toHaveBeenCalled();

    sync.update([{ ...legacy, archivedAt: 500 }]);
    await expect(sync.purge(legacy.id)).resolves.toBe(true);
    expect(migrationAcks).toHaveBeenCalledTimes(1);
    await expect(sync.purge(legacy.id)).resolves.toBe(false);
    expect(migrationAcks).toHaveBeenCalledTimes(1);
    sync.dispose();
  });

  it("acknowledges a completed legacy upload once and does not repeat the acknowledgement", async () => {
    const legacy = captureWorkspace("Legacy upload", context, 100);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [] }))
      .mockResolvedValueOnce(json({ workspace: envelope(remoteDocument(legacy, 1)) }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const { sync, migrationAcks } = harness();

    await sync.start([legacy]);
    await vi.runOnlyPendingTimersAsync();
    expect(migrationAcks).toHaveBeenCalledTimes(1);

    sync.update([legacy]);
    sync.retry();
    await vi.runOnlyPendingTimersAsync();
    expect(migrationAcks).toHaveBeenCalledTimes(1);
    sync.dispose();
  });

  it("acknowledges a legacy batch once after an explicit conflict discard", async () => {
    const server = captureWorkspace("Server version", context, 100);
    const legacy = revised(server, "4h", 200);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [envelope(remoteDocument(server, 2))] }));
    vi.stubGlobal("fetch", fetchMock);
    const { sync, migrationAcks, workspaces } = harness();

    await sync.start([legacy]);
    expect(migrationAcks).not.toHaveBeenCalled();

    sync.resolveConflict("reload");
    expect(workspaces.at(-1)?.[0]).toMatchObject({ timeframe: "1h" });
    expect(migrationAcks).toHaveBeenCalledTimes(1);
    sync.resolveConflict("reload");
    expect(migrationAcks).toHaveBeenCalledTimes(1);
    sync.dispose();
  });

  it("keeps the legacy source unacknowledged while an offline migration remains pending", async () => {
    const legacy = captureWorkspace("Offline legacy", context, 100);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [] }))
      .mockRejectedValueOnce(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const { sync, migrationAcks } = harness();

    await sync.start([legacy]);
    await vi.runOnlyPendingTimersAsync();

    expect(migrationAcks).not.toHaveBeenCalled();
    sync.dispose();
  });

  it("recovers a lost create response by archiving the authoritative active document before purge", async () => {
    const local = captureWorkspace("Lost response", context, 100);
    const remote = remoteDocument(local, 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [] }))
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(json({ workspaces: [envelope(remote)] }))
      .mockResolvedValueOnce(json({ workspace: envelope(remoteDocument(local, 2, "archived")) }))
      .mockResolvedValueOnce(json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { sync, workspaces } = harness();

    await sync.start([]);
    sync.update([local]);
    await vi.advanceTimersByTimeAsync(900);
    sync.update([{ ...local, archivedAt: 500 }]);

    await expect(sync.purge(local.id)).resolves.toBe(true);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "POST", "GET", "POST", "DELETE"]);
    expect(String(fetchMock.mock.calls[3]?.[0])).toBe(`/api/workspaces/${remote.id}/archive`);
    expect(String(fetchMock.mock.calls[4]?.[0])).toContain(`/api/workspaces/${remote.id}/permanent?revision=2`);
    expect(workspaces.at(-1)).toEqual([]);
    sync.dispose();
  });

  it("serializes purge behind an in-flight create and removes the acknowledged remote document", async () => {
    const local = captureWorkspace("Create then purge", context, 100);
    let resolveCreate!: (response: Response) => void;
    const createResponse = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [] }))
      .mockReturnValueOnce(createResponse)
      .mockResolvedValueOnce(json({ workspace: envelope(remoteDocument(local, 2, "archived")) }))
      .mockResolvedValueOnce(json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { sync, workspaces } = harness();

    await sync.start([]);
    sync.update([local]);
    await vi.advanceTimersByTimeAsync(900);
    sync.update([{ ...local, archivedAt: 500 }]);
    const purged = sync.purge(local.id);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveCreate(json({ workspace: envelope(remoteDocument(local, 1)) }, 201));
    await expect(purged).resolves.toBe(true);

    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "POST", "POST", "DELETE"]);
    expect(workspaces.at(-1)).toEqual([]);
    sync.dispose();
  });

  it("turns a cross-device deletion into an explicit conflict and preserves edits as a new copy", async () => {
    const local = revised(captureWorkspace("Edited stale copy", context, 100), "4h", 200);
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ workspaces: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { sync, workspaces, statuses } = harness([local.id]);

    await sync.start([local]);
    expect(statuses.at(-1)).toMatchObject({ phase: "conflict", issue: { code: "workspace_deleted", clientId: local.id } });
    expect(workspaces.at(-1)?.[0]).toMatchObject({ id: local.id, timeframe: "4h" });

    sync.resolveConflict("retry");
    expect(statuses.at(-1)?.phase).toBe("conflict");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    sync.resolveConflict("keep-copy");
    const preserved = workspaces.at(-1)?.[0];
    expect(preserved).toMatchObject({ timeframe: "4h", archivedAt: undefined });
    expect(preserved?.id).not.toBe(local.id);
    expect(workspaces.at(-1)?.some((workspace) => workspace.id === local.id)).toBe(false);
    expect(statuses.at(-1)).toMatchObject({ phase: "saving", pendingCount: 1 });
    sync.dispose();
  });

  it("keeps an existing conflict visible when an unrelated import is attempted", async () => {
    const local = captureWorkspace("Deleted elsewhere", context, 100);
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ workspaces: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { sync, statuses } = harness([local.id]);

    await sync.start([local]);
    await expect(sync.importDocument({ arbitrary: true })).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toMatchObject({ phase: "conflict", issue: { code: "workspace_deleted" } });
    sync.dispose();
  });

  it("ignores a late mutation response after the sync instance is disposed", async () => {
    const local = captureWorkspace("Old owner", context, 100);
    let resolveCreate!: (response: Response) => void;
    const createResponse = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [] }))
      .mockReturnValueOnce(createResponse);
    vi.stubGlobal("fetch", fetchMock);
    const { sync, workspaces, statuses, knownIds } = harness();

    await sync.start([]);
    sync.update([local]);
    await vi.advanceTimersByTimeAsync(900);
    const counts = { workspaces: workspaces.length, statuses: statuses.length, knownIds: knownIds.length };
    sync.dispose();
    resolveCreate(json({ workspace: envelope(remoteDocument(local, 1)) }, 201));
    await Promise.resolve();
    await Promise.resolve();

    expect(workspaces).toHaveLength(counts.workspaces);
    expect(statuses).toHaveLength(counts.statuses);
    expect(knownIds).toHaveLength(counts.knownIds);
  });

  it("does not retry an archived conflict as a destructive overwrite", async () => {
    const server = captureWorkspace("Server", context, 100);
    const local = revised(server, "4h", 200);
    const archivedRemote = remoteDocument(server, 3, "archived");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [envelope(remoteDocument(server, 2))] }))
      .mockResolvedValueOnce(json({ code: "workspace_archived", current: envelope(archivedRemote) }, 409));
    vi.stubGlobal("fetch", fetchMock);
    const { sync, workspaces, statuses } = harness();

    await sync.start([server]);
    sync.update([local]);
    await vi.advanceTimersByTimeAsync(900);
    expect(statuses.at(-1)).toMatchObject({ phase: "conflict", issue: { code: "workspace_archived" } });

    sync.resolveConflict("retry");
    await vi.runOnlyPendingTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)?.phase).toBe("conflict");

    sync.resolveConflict("reload");
    await vi.runOnlyPendingTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(workspaces.at(-1)?.[0]?.archivedAt).toBeTypeOf("number");
    expect(statuses.at(-1)?.phase).toBe("saved");
    sync.dispose();
  });

  it("rolls back through server history and refuses rollback while a local save is pending", async () => {
    const current = revised(captureWorkspace("Current", context, 100), "4h", 200);
    const previous = { ...captureWorkspace("Current", context, 100), id: current.id };
    const currentDocument = remoteDocument(current, 4);
    const savedRollback = remoteDocument({ ...previous, revision: 3, savedAt: 300, updatedAt: 300 }, 5);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [envelope(currentDocument)] }))
      .mockResolvedValueOnce(json({
        revisions: [
          envelope(currentDocument),
          envelope(remoteDocument(current, 3, "archived")),
          envelope(remoteDocument(previous, 2))
        ]
      }))
      .mockResolvedValueOnce(json({ workspace: envelope(savedRollback) }));
    vi.stubGlobal("fetch", fetchMock);
    const { sync, statuses } = harness();

    await sync.start([current]);
    const restored = await sync.rollbackLatest(current.id);

    expect(restored).toMatchObject({ id: current.id, timeframe: "1h" });
    expect(restored?.history.at(-1)).toMatchObject({ timeframe: "4h" });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ revision: 4, targetRevision: 2 });
    expect(statuses.at(-1)).toMatchObject({ phase: "saved", pendingCount: 0 });

    sync.update([revised(restored!, "1d", 400)]);
    await expect(sync.rollbackLatest(current.id)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    sync.dispose();
  });

  it("walks revision pages until it finds a materially different rollback target", async () => {
    const current = revised(captureWorkspace("Current", context, 100), "4h", 200);
    const previous = { ...captureWorkspace("Current", context, 100), id: current.id };
    const currentDocument = remoteDocument(current, 12);
    const sameContent = Array.from({ length: 4 }, (_, index) =>
      envelope(remoteDocument(current, 11 - index))
    );
    const target = remoteDocument(previous, 7);
    const savedRollback = remoteDocument(
      { ...previous, revision: 3, savedAt: 300, updatedAt: 300 },
      13
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ workspaces: [envelope(currentDocument)] }))
      .mockResolvedValueOnce(
        json(page({ revisions: sameContent }, true, "8"))
      )
      .mockResolvedValueOnce(
        json(page({ revisions: [envelope(target)] }, false, null))
      )
      .mockResolvedValueOnce(
        json({ workspace: envelope(savedRollback) })
      );
    vi.stubGlobal("fetch", fetchMock);
    const { sync } = harness();

    await sync.start([current]);
    const restored = await sync.rollbackLatest(current.id);

    expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual([
      "/api/workspaces?status=all",
      `/api/workspaces/${currentDocument.id}/revisions`,
      `/api/workspaces/${currentDocument.id}/revisions?cursor=8`,
      `/api/workspaces/${currentDocument.id}/rollback`
    ]);
    expect(
      JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))
    ).toEqual({ revision: 12, targetRevision: 7 });
    expect(restored).toMatchObject({ timeframe: "1h" });
    sync.dispose();
  });

  it("fails closed on a repeated pagination cursor instead of looping", async () => {
    const remote = captureWorkspace("Remote", context, 100);
    const cursor = "00000000-0000-4000-8000-000000000301";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json(page({ workspaces: [envelope(remoteDocument(remote, 1))] }, true, cursor))
      )
      .mockResolvedValueOnce(
        json(page({ workspaces: [] }, true, cursor))
      );
    vi.stubGlobal("fetch", fetchMock);
    const { sync, statuses } = harness();

    await sync.start([]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toMatchObject({
      phase: "failed",
      issue: { code: "workspace_request_failed" }
    });
    sync.dispose();
  });

  it("fails closed when the authenticated owner changes", async () => {
    const workspace = captureWorkspace("Owner A stale state", context, 100);
    const fetchMock = vi.fn().mockImplementation((_path: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("X-SBV2-Expected-User")).toBe(OWNER_A);
      return Promise.resolve(json({ code: "workspace_authorization_changed" }, 401));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { sync, workspaces, statuses } = harness();

    await sync.start([workspace]);
    sync.update([revised(workspace, "4h", 200)]);
    await vi.runOnlyPendingTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(workspaces).toEqual([]);
    expect(statuses.at(-1)).toMatchObject({ phase: "failed", issue: { code: "workspace_authorization_changed" } });
    sync.dispose();
  });
});
