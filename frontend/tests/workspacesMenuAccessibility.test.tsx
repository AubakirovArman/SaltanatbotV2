// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspacesMenu } from "../src/components/topbar/WorkspacesMenu";
import { captureWorkspace } from "../src/workspace/workspaces";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const workspace = captureWorkspace("Mobile workspace", {
  symbol: "BTCUSDT",
  timeframe: "1h",
  chartType: "candles",
  cryptoExchange: "binance",
  indicators: [],
  theme: "dark"
}, 100);

describe("WorkspacesMenu accessibility", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("keeps deleted-workspace choices valid and restores trigger focus on Escape", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onResolveConflict = vi.fn();

    await act(async () => root.render(
      <WorkspacesMenu
        locale="en"
        workspaces={[workspace]}
        syncStatus={{ phase: "conflict", pendingCount: 1, issue: { code: "workspace_deleted", clientId: workspace.id, local: workspace } }}
        strategyRestore="none"
        migrationMissingIndicators={0}
        onSave={() => {}}
        onApply={() => "none"}
        onArchive={() => {}}
        onRestore={() => {}}
        onPurge={async () => false}
        onRename={() => true}
        onDuplicate={() => true}
        onCreateTemplate={() => true}
        canCreatePaperTemplate
        serverHistory
        onExport={async () => {}}
        onImport={async () => ({ ok: false, reason: "invalid_json" })}
        onRollback={async () => false}
        onRetrySync={() => {}}
        onResolveConflict={onResolveConflict}
      />
    ));

    const trigger = host.querySelector<HTMLButtonElement>(".workspace-trigger");
    await act(async () => trigger?.click());
    const region = host.querySelector<HTMLElement>('[role="region"]');
    expect(region?.getAttribute("aria-label")).toBe("Saved workspaces");
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(region?.textContent).toContain("Accept server deletion");
    expect(region?.textContent).toContain("Keep my changes as a copy");
    expect(region?.textContent).not.toContain("Retry my version");

    const accept = Array.from(region?.querySelectorAll("button") ?? []).find((button) => button.textContent === "Accept server deletion");
    await act(async () => accept?.click());
    expect(onResolveConflict).toHaveBeenCalledWith("reload");

    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(host.querySelector('[role="region"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => root.unmount());
  });

  it("moves focus to the current lifecycle tab after archive, restore and permanent purge", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    function Harness() {
      const [items, setItems] = useState([workspace]);
      return (
        <WorkspacesMenu
          locale="en"
          workspaces={items}
          syncStatus={{ phase: "saved", pendingCount: 0 }}
          strategyRestore="none"
          migrationMissingIndicators={0}
          onSave={() => {}}
          onApply={() => "none"}
          onArchive={(id) => setItems((current) => current.map((item) => item.id === id ? { ...item, archivedAt: 200 } : item))}
          onRestore={(id) => setItems((current) => current.map((item) => item.id === id ? { ...item, archivedAt: undefined } : item))}
          onPurge={async (id) => {
            setItems((current) => current.filter((item) => item.id !== id));
            return true;
          }}
          onRename={() => true}
          onDuplicate={() => true}
          onCreateTemplate={() => true}
          canCreatePaperTemplate
          serverHistory={false}
          onExport={async () => {}}
          onImport={async () => ({ ok: true })}
          onRollback={async () => false}
          onRetrySync={() => {}}
          onResolveConflict={() => {}}
        />
      );
    }

    await act(async () => root.render(<Harness />));
    await act(async () => host.querySelector<HTMLButtonElement>(".workspace-trigger")?.click());
    const button = (name: string) => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.getAttribute("aria-label") === name || item.textContent?.trim() === name);

    await act(async () => button("Archive workspace Mobile workspace")?.click());
    expect(document.activeElement?.textContent).toContain("Active");
    await act(async () => button("Archived 1")?.click());
    await act(async () => button("Restore workspace Mobile workspace")?.click());
    expect(document.activeElement?.textContent).toContain("Archived");

    await act(async () => button("Active 1")?.click());
    await act(async () => button("Archive workspace Mobile workspace")?.click());
    await act(async () => button("Archived 1")?.click());
    await act(async () => button("Delete permanently Mobile workspace")?.click());
    await act(async () => button("Delete permanently")?.click());
    expect(document.activeElement?.textContent).toContain("Archived");
    await act(async () => root.unmount());
  });

  it("offers explicit discard, keep-copy and retry actions for an edited archive rejected by quota", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onResolveConflict = vi.fn();

    await act(async () => root.render(
      <WorkspacesMenu
        locale="en"
        workspaces={[workspace]}
        syncStatus={{
          phase: "quota",
          pendingCount: 1,
          issue: { code: "workspace_storage_quota_exceeded", clientId: workspace.id, local: { ...workspace, archivedAt: 200 }, current: workspace }
        }}
        strategyRestore="none"
        migrationMissingIndicators={0}
        onSave={() => {}}
        onApply={() => "none"}
        onArchive={() => {}}
        onRestore={() => {}}
        onPurge={async () => false}
        onRename={() => true}
        onDuplicate={() => true}
        onCreateTemplate={() => true}
        canCreatePaperTemplate
        serverHistory={false}
        onExport={async () => {}}
        onImport={async () => ({ ok: true })}
        onRollback={async () => false}
        onRetrySync={() => {}}
        onResolveConflict={onResolveConflict}
      />
    ));
    await act(async () => host.querySelector<HTMLButtonElement>(".workspace-trigger")?.click());
    const labels = Array.from(host.querySelectorAll<HTMLButtonElement>(".workspace-conflict-actions button")).map((button) => button.textContent);
    expect(labels).toEqual(["Reload server copy", "Keep my changes as a copy", "Retry my version"]);

    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Keep my changes as a copy")?.click());
    expect(onResolveConflict).toHaveBeenCalledWith("keep-copy");
    await act(async () => root.unmount());
  });
});
