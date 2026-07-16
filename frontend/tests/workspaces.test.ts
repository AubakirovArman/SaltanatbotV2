// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserSha256 } from "../src/security/browserSha256";
import { hydrateLegacyWorkspaceIndicators, missingLegacyWorkspaceIndicatorIds } from "../src/workspace/shellWorkspaceHelpers";
import { captureWorkspace, encodeWorkspaceFile, loadWorkspaces, MAX_WORKSPACE_DOCUMENT_BYTES, MAX_WORKSPACE_FILE_BYTES, parseWorkspaceFile, parseWorkspaceFileDetailed, removeMigratedWorkspaceSource, reviseWorkspace, rollbackWorkspace, saveWorkspaces, WORKSPACE_FILE_FORMAT, WORKSPACE_FILE_VERSION, WORKSPACE_SCHEMA_VERSION } from "../src/workspace/workspaces";
import { retryMigratedWorkspaceCleanup } from "../src/workspace/workspaceMigrationStorage";
import type { WorkspaceChart } from "../src/workspace/workspaces";

const context = {
  symbol: "BTCUSDT",
  timeframe: "1h" as const,
  chartType: "candles" as const,
  cryptoExchange: "binance" as const,
  indicators: [{ id: "ema", label: "EMA", enabled: true, kind: "ema" as const, period: 20, color: "#fff" }],
  compareOverlays: [{ id: "ETHUSDT", symbol: "ETHUSDT", timeframe: "1h" as const, chartType: "line" as const, color: "#abcdef", upColor: "#23c97a", downColor: "#ef5350" }],
  theme: "dark" as const
};

describe("versioned chart workspaces", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("migrates legacy snapshots into the current layout schema", () => {
    localStorage.setItem("sbv2:workspaces", JSON.stringify([{ id: "old", name: "Legacy", symbol: "ETHUSDT", timeframe: "4h", chartType: "line", enabledIndicators: [], createdAt: 10 }]));
    expect(loadWorkspaces()[0]).toMatchObject({
      id: "old",
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      revision: 1,
      cryptoExchange: "binance",
      compareOverlays: [],
      layout: { preset: "single", leftOpen: true, rightOpen: true },
      charts: [{ symbol: "ETHUSDT", timeZone: "local", linkChartType: true, linkCrosshair: true, linkTimeRange: true, linkIndicators: true, linkCompare: true }]
    });
  });

  it("preserves legacy independent secondary chart types while keeping the primary canonical", () => {
    localStorage.setItem(
      "sbv2:workspaces",
      JSON.stringify([
        {
          id: "v5",
          name: "Legacy panes",
          schemaVersion: 5,
          symbol: "BTCUSDT",
          timeframe: "1h",
          chartType: "candles",
          enabledIndicators: [],
          createdAt: 10,
          layout: { preset: "split-vertical" },
          charts: [
            { id: "chart-1", symbol: "BTCUSDT", timeframe: "1h", chartType: "candles" },
            { id: "chart-2", symbol: "ETHUSDT", timeframe: "1h", chartType: "line" }
          ]
        }
      ])
    );
    expect(loadWorkspaces()[0]).toMatchObject({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      charts: [
        { timeZone: "local", linkChartType: true },
        { chartType: "line", timeZone: "local", linkChartType: false }
      ]
    });
  });

  it("autosaves changed state as bounded immutable revisions and rolls back", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    const initial = captureWorkspace("Research", context, 100);
    expect(reviseWorkspace(initial, context, 150)).toBe(initial);
    const changed = reviseWorkspace(initial, { ...context, timeframe: "4h", layout: { preset: "split-vertical", leftOpen: false } }, 200);
    expect(changed).toMatchObject({ revision: 2, timeframe: "4h", history: [{ revision: 1, timeframe: "1h" }] });
    const restored = rollbackWorkspace(changed, 1, 300);
    expect(restored).toMatchObject({ revision: 3, timeframe: "1h", updatedAt: 300 });
    saveWorkspaces([restored!]);
    expect(loadWorkspaces()[0]).toMatchObject({ revision: 3, timeframe: "1h" });
  });

  it("round-trips signed export files and rejects checksum tampering", async () => {
    const workspace = captureWorkspace("Portable", context, 100);
    const encoded = await encodeWorkspaceFile(workspace, 200);
    await expect(parseWorkspaceFile(encoded)).resolves.toMatchObject({ name: "Portable", symbol: "BTCUSDT" });
    const tampered = encoded.replace("BTCUSDT", "ETHUSDT");
    await expect(parseWorkspaceFile(tampered)).resolves.toBeUndefined();
  });

  it("bounds local history so a near-limit export remains importable under the payload contract", async () => {
    const drawings = Array.from({ length: 500 }, (_, index) => ({
      id: `line-${index}`,
      tool: "hline" as const,
      points: [{ time: 1_700_000_000_000 + index, price: 50_000 + index }],
      style: { color: "#4db6ff", width: 1.5 }
    }));
    const withDrawings = { ...context, drawings: [{ chartId: "chart-1", symbol: "BTCUSDT", drawings }] };
    let workspace = captureWorkspace("Near boundary", withDrawings, 100);
    for (let index = 0; index < 20; index += 1) {
      workspace = reviseWorkspace(workspace, { ...withDrawings, timeframe: index % 2 === 0 ? "4h" : "1h" }, 200 + index);
    }
    expect(workspace.history).toHaveLength(20);

    const encoded = await encodeWorkspaceFile(workspace, 500);
    const document = JSON.parse(encoded);
    const payloadBytes = new TextEncoder().encode(JSON.stringify(document.workspace)).byteLength;
    const fileBytes = new TextEncoder().encode(encoded).byteLength;

    expect(payloadBytes).toBeLessThanOrEqual(MAX_WORKSPACE_DOCUMENT_BYTES);
    expect(fileBytes).toBeLessThanOrEqual(MAX_WORKSPACE_FILE_BYTES);
    expect(document.workspace.history.length).toBeGreaterThan(0);
    expect(document.workspace.history.length).toBeLessThan(workspace.history.length);
    const parsed = await parseWorkspaceFile(encoded);
    expect(parsed?.name).toBe("Near boundary");
    expect(parsed?.drawings[0]?.drawings.some((drawing) => drawing.id === "line-499")).toBe(true);
  });

  it("keeps SHA-256 export/import available on public HTTP without Web Crypto", async () => {
    vi.stubGlobal("crypto", {});
    await expect(browserSha256("abc")).resolves.toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const encoded = await encodeWorkspaceFile(captureWorkspace("HTTP fallback", context, 100), 200);
    await expect(parseWorkspaceFile(encoded)).resolves.toMatchObject({ name: "HTTP fallback" });
  });

  it("rejects signed v8 documents that drift from the exact backend contract", async () => {
    const workspace = captureWorkspace("Strict", context, 100);
    const invalidOverride = structuredClone(workspace) as unknown as Record<string, unknown>;
    const chart = ((invalidOverride.charts as Record<string, unknown>[])[0]);
    chart.indicatorOverrides = [{ id: "ema", enabled: true, period: "55" }];
    await expect(parseWorkspaceFileDetailed(await signedWorkspaceFile(invalidOverride))).resolves.toEqual({ ok: false, reason: "invalid_workspace" });

    const archivedPayload = { ...structuredClone(workspace), archivedAt: 123 };
    await expect(parseWorkspaceFileDetailed(await signedWorkspaceFile(archivedPayload))).resolves.toEqual({ ok: false, reason: "invalid_workspace" });

    const invalidLayout = structuredClone(workspace) as unknown as Record<string, unknown>;
    (invalidLayout.layout as Record<string, unknown>).leftOpen = "true";
    await expect(parseWorkspaceFileDetailed(await signedWorkspaceFile(invalidLayout))).resolves.toEqual({ ok: false, reason: "invalid_workspace" });
  });

  it("accepts only exact, payload-consistent optional export metadata", async () => {
    const workspace = captureWorkspace("Metadata", context, 100);
    await expect(parseWorkspaceFile(await signedWorkspaceFile(workspace, {
      clientId: workspace.id,
      name: workspace.name,
      schemaVersion: workspace.schemaVersion
    }))).resolves.toMatchObject({ id: workspace.id, name: workspace.name });
    await expect(parseWorkspaceFileDetailed(await signedWorkspaceFile(workspace, { garbage: true }))).resolves.toEqual({ ok: false, reason: "invalid_envelope" });
    await expect(parseWorkspaceFileDetailed(await signedWorkspaceFile(workspace, {
      clientId: workspace.id,
      name: "Different",
      schemaVersion: workspace.schemaVersion
    }))).resolves.toEqual({ ok: false, reason: "invalid_envelope" });
  });

  it("imports only the exact v7 legacy shape and hydrates available indicator definitions", async () => {
    const current = captureWorkspace("Legacy v7", context, 100);
    const legacy = legacyV7Workspace(current);
    const parsed = await parseWorkspaceFile(await signedWorkspaceFile(legacy));
    expect(parsed).toMatchObject({ schemaVersion: 8, enabledIndicators: ["ema", "missing"], indicators: [] });
    expect(missingLegacyWorkspaceIndicatorIds([parsed!], context.indicators)).toEqual(["missing"]);
    expect(hydrateLegacyWorkspaceIndicators([parsed!], context.indicators)[0]).toMatchObject({
      enabledIndicators: ["ema"],
      indicators: [{ id: "ema", enabled: true }]
    });

    await expect(parseWorkspaceFileDetailed(await signedWorkspaceFile({ ...legacy, mode: "chart" }))).resolves.toEqual({ ok: false, reason: "invalid_workspace" });
  });

  it("preserves price-compressed chart types across local workspace storage", () => {
    const workspace = captureWorkspace("Line Break", { ...context, chartType: "linebreak" }, 100);
    saveWorkspaces([workspace]);
    expect(loadWorkspaces()[0]).toMatchObject({ chartType: "linebreak", charts: [{ chartType: "linebreak" }] });
  });

  it("claims legacy local data once and keeps database-auth owners isolated", () => {
    const legacy = captureWorkspace("Legacy", context, 100);
    saveWorkspaces([legacy]);
    localStorage.setItem("sbv2:tenant-local-data:legacy-owner:v1", "user-a");
    localStorage.setItem("sbv2:workspaces:legacy-owner", "user-a");

    expect(loadWorkspaces("user-a")).toMatchObject([{ name: "Legacy" }]);
    saveWorkspaces([{ ...legacy, name: "Private A" }], "user-a");
    expect(loadWorkspaces("user-a")).toMatchObject([{ name: "Private A" }]);
    expect(loadWorkspaces("user-b")).toEqual([]);
    expect(loadWorkspaces()).toMatchObject([{ name: "Legacy" }]);
  });

  it("retries a partially failed migrated-source cleanup without re-claiming legacy data", () => {
    const values = new Map<string, string>([
      ["sbv2:workspaces", "legacy-base"],
      ["sbv2:workspaces:user-a", "legacy-scoped"],
      ["sbv2:workspaces:legacy-owner", "user-a"]
    ]);
    let failBaseRemoval = true;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => {
        if (key === "sbv2:workspaces" && failBaseRemoval) throw new Error("quota");
        values.delete(key);
      }
    };

    removeMigratedWorkspaceSource("user-a", storage);
    expect(values.has("sbv2:workspaces:user-a")).toBe(false);
    expect(values.get("sbv2:workspaces")).toBe("legacy-base");
    expect([...values.keys()].some((key) => key.includes("migration-cleanup-pending"))).toBe(true);

    failBaseRemoval = false;
    expect(retryMigratedWorkspaceCleanup("user-a", storage)).toBe(false);
    expect(values.has("sbv2:workspaces")).toBe(false);
    expect(values.has("sbv2:workspaces:legacy-owner")).toBe(false);
    expect([...values.keys()].some((key) => key.includes("migration-cleanup-pending"))).toBe(false);
  });

  it("still removes migrated sources when a quota-full store rejects the cleanup marker", () => {
    const values = new Map<string, string>([
      ["sbv2:workspaces", "legacy-base"],
      ["sbv2:workspaces:user-a", "legacy-scoped"],
      ["sbv2:workspaces:legacy-owner", "user-a"]
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: (key: string) => {
        values.delete(key);
      }
    };

    removeMigratedWorkspaceSource("user-a", storage);
    expect(values.size).toBe(0);
  });

  it("versions, exports and restores independent pane indicator settings", async () => {
    const charts: WorkspaceChart[] = [
      { id: "chart-1", symbol: "BTCUSDT", timeframe: "1h", chartType: "candles", timeZone: "UTC", linkChartType: true, linkSymbol: true, linkTimeframe: true, linkCrosshair: true, linkTimeRange: true, linkIndicators: true, linkCompare: true },
      {
        id: "chart-2",
        symbol: "ETHUSDT",
        timeframe: "4h",
        chartType: "line",
        timeZone: "Asia/Almaty",
        linkChartType: false,
        linkSymbol: false,
        linkTimeframe: false,
        linkCrosshair: true,
        linkTimeRange: true,
        linkIndicators: false,
        indicatorOverrides: [{ id: "ema", enabled: true, period: 55 }],
        linkCompare: false,
        compareOverlays: [{ id: "SOLUSDT", symbol: "SOLUSDT", timeframe: "1h", chartType: "line", color: "#abcdef", upColor: "#23c97a", downColor: "#ef5350" }]
      }
    ];
    const initial = captureWorkspace("Independent indicators", { ...context, charts, layout: { preset: "split-vertical" } }, 100);
    const changedCharts = charts.map((chart) => (chart.id === "chart-2" ? { ...chart, indicatorOverrides: [{ id: "ema", enabled: false, period: 89 }] } : chart)) as WorkspaceChart[];
    const revised = reviseWorkspace(initial, { ...context, charts: changedCharts, layout: { preset: "split-vertical" } }, 200);
    expect(revised).toMatchObject({
      revision: 2,
      compareOverlays: [{ symbol: "ETHUSDT" }],
      charts: [
        { timeZone: "UTC", linkIndicators: true, linkCompare: true },
        { timeZone: "Asia/Almaty", linkIndicators: false, indicatorOverrides: [{ id: "ema", enabled: false, period: 89 }], linkCompare: false, compareOverlays: [{ symbol: "SOLUSDT" }] }
      ]
    });
    saveWorkspaces([revised]);
    expect(loadWorkspaces()[0]).toMatchObject({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      charts: [
        { linkChartType: true, linkIndicators: true, linkCompare: true },
        { linkChartType: false, indicatorOverrides: [{ id: "ema", enabled: false, period: 89 }], compareOverlays: [{ symbol: "SOLUSDT" }] }
      ]
    });
    await expect(parseWorkspaceFile(await encodeWorkspaceFile(revised, 250))).resolves.toMatchObject({
      charts: [
        { linkIndicators: true, linkCompare: true },
        { indicatorOverrides: [{ id: "ema", enabled: false, period: 89 }], compareOverlays: [{ symbol: "SOLUSDT" }] }
      ]
    });
    expect(rollbackWorkspace(revised, 1, 300)).toMatchObject({ charts: [{ linkIndicators: true }, { indicatorOverrides: [{ id: "ema", enabled: true, period: 55 }] }] });
  });
});

async function signedWorkspaceFile(workspace: unknown, metadata?: unknown): Promise<string> {
  return JSON.stringify({
    format: WORKSPACE_FILE_FORMAT,
    version: WORKSPACE_FILE_VERSION,
    algorithm: "SHA-256",
    checksum: await browserSha256(canonicalStringify(workspace)),
    exportedAt: 200,
    workspace,
    ...(metadata === undefined ? {} : { metadata })
  });
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function legacyV7Workspace(workspace: ReturnType<typeof captureWorkspace>) {
  return {
    schemaVersion: 7,
    id: workspace.id,
    name: workspace.name,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    history: [],
    revision: workspace.revision,
    savedAt: workspace.savedAt,
    symbol: workspace.symbol,
    timeframe: workspace.timeframe,
    chartType: workspace.chartType,
    cryptoExchange: workspace.cryptoExchange,
    enabledIndicators: ["ema", "missing"],
    compareOverlays: workspace.compareOverlays,
    theme: workspace.theme,
    layout: workspace.layout,
    charts: workspace.charts
  };
}
