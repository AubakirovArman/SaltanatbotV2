// @vitest-environment jsdom
import { act, useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrawingObject } from "../src/chart/drawings";
import { useActiveWorkspacePersistence } from "../src/workspace/useActiveWorkspacePersistence";
import type { WorkspaceRemoteSync } from "../src/workspace/remoteSyncTypes";
import { captureWorkspace, loadWorkspaces, type Workspace, type WorkspaceContext } from "../src/workspace/workspaces";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const baseContext: WorkspaceContext = {
  symbol: "BTCUSDT",
  timeframe: "1h",
  chartType: "candles",
  cryptoExchange: "binance",
  indicators: [],
  theme: "dark"
};
const workspace = captureWorkspace("Owner workspace", baseContext, 100);
const latestDrawing: DrawingObject = {
  id: "latest-before-logout",
  tool: "hline",
  points: [{ time: 1, price: 100 }],
  style: { color: "#fff", width: 1 }
};

describe("active workspace lifecycle persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("flushes the departing owner's exact drawing snapshot on immediate unmount", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => root.render(
      <Harness ownerId="user-a" drawings={[]} revision={0} />
    ));
    await act(async () => root.render(
      <Harness ownerId="user-a" drawings={[latestDrawing]} revision={1} />
    ));
    expect(loadWorkspaces("user-a").find((item) => item.id === workspace.id)?.drawings[0]?.drawings ?? []).toEqual([]);

    await act(async () => root.unmount());
    const persisted = loadWorkspaces("user-a").find((item) => item.id === workspace.id);
    expect(persisted?.drawings[0]?.drawings).toMatchObject([{ id: "latest-before-logout" }]);
    expect(persisted?.revision).toBe(2);
  });

  it("flushes an owner switch only into the departing owner scope", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => root.render(
      <Harness ownerId="user-a" drawings={[]} revision={0} />
    ));
    await act(async () => root.render(
      <Harness ownerId="user-a" drawings={[latestDrawing]} revision={1} />
    ));
    await act(async () => root.render(
      <Harness ownerId="user-b" drawings={[]} revision={1} enabled={false} />
    ));

    expect(loadWorkspaces("user-a").find((item) => item.id === workspace.id)?.drawings[0]?.drawings).toMatchObject([{ id: "latest-before-logout" }]);
    expect(localStorage.getItem("sbv2:workspace-cache:v1:user-b")).toBeNull();
    await act(async () => root.unmount());
  });

  it("coalesces resize bursts into one exact workspace update on pagehide", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const sync = mockSync();

    await act(async () => root.render(
      <Harness ownerId="user-a" drawings={[]} revision={0} rightSize={280} sync={sync} />
    ));
    vi.mocked(sync.update).mockClear();
    for (let rightSize = 300; rightSize < 320; rightSize += 1) {
      await act(async () => root.render(
        <Harness ownerId="user-a" drawings={[]} revision={0} rightSize={rightSize} sync={sync} />
      ));
    }
    expect(sync.update).not.toHaveBeenCalled();

    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(sync.update).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sync.update).mock.calls[0]?.[0]?.[0]).toMatchObject({ layout: { rightSize: 319 } });
    expect(sync.flushNow).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });
});

function Harness({
  ownerId,
  drawings,
  revision,
  enabled = true,
  rightSize = 280,
  sync
}: {
  ownerId: string;
  drawings: DrawingObject[];
  revision: number;
  enabled?: boolean;
  rightSize?: number;
  sync?: WorkspaceRemoteSync;
}) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([workspace]);
  const syncRef = useRef<WorkspaceRemoteSync>();
  syncRef.current = sync;
  const captureContext = useCallback((): WorkspaceContext => ({
    ...baseContext,
    layout: { rightSize },
    drawings: [{ chartId: "chart-1", symbol: "BTCUSDT", drawings }]
  }), [drawings, rightSize]);
  useActiveWorkspacePersistence({
    activeWorkspaceId: workspace.id,
    captureContext,
    enabled,
    ownerId,
    revisionSignal: revision,
    setWorkspaces,
    syncRef,
    workspaces
  });
  return null;
}

function mockSync(): WorkspaceRemoteSync {
  return {
    start: vi.fn(async () => {}),
    update: vi.fn(),
    markDirty: vi.fn(),
    flushNow: vi.fn(async () => {}),
    purge: vi.fn(async () => false),
    importDocument: vi.fn(async () => false),
    rollbackLatest: vi.fn(async () => undefined),
    retry: vi.fn(),
    resolveConflict: vi.fn(),
    dispose: vi.fn()
  };
}
