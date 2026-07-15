import { describe, expect, it } from "vitest";
import { TENANT_LOCAL_LEGACY_OWNER_KEY } from "../app/tenantLocalStorage";
import { deleteScannerPreset, LEGACY_SCANNER_WORKSPACE_STORAGE_KEY, loadScannerWorkspace, saveScannerPreset, SCANNER_WORKSPACE_STORAGE_KEY, storeScannerWorkspace } from "./scannerPrefs";

const COLUMNS = ["route", "net", "capacity", "actions"];
const DEFAULTS = [...COLUMNS];
const REQUIRED = ["route", "actions"];

describe("scanner workspace preferences", () => {
  it("migrates a bounded v1 workspace and keeps required columns", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      LEGACY_SCANNER_WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        workspaces: {
          basis: {
            columns: ["net", "unknown", "net"],
            view: "heatmap",
            compareIds: ["route-a", "route-a"],
            selectedPresetId: "legacy",
            presets: [{ id: "legacy", name: "  Legacy view  ", filters: { minEdge: 75, bad_key: "ignored" }, columns: ["capacity"], view: "compare", compareIds: ["a", "b"], updatedAt: 42 }]
          }
        }
      })
    );

    const value = loadScannerWorkspace("basis", COLUMNS, DEFAULTS, REQUIRED, storage);

    expect(value).toMatchObject({
      columns: ["route", "net", "actions"],
      visualization: "heatmap",
      compareIds: ["route-a", ""],
      selectedPresetId: "legacy"
    });
    expect(value.presets[0]).toMatchObject({ name: "Legacy view", columns: ["route", "capacity", "actions"], visualization: "compare", filters: { minEdge: 75 } });
    expect(JSON.parse(storage.getItem(SCANNER_WORKSPACE_STORAGE_KEY) ?? "null").version).toBe(2);
    expect(storage.getItem(LEGACY_SCANNER_WORKSPACE_STORAGE_KEY)).toBeNull();
  });

  it("fails closed on malformed and oversized local data", () => {
    const malformed = new MemoryStorage();
    malformed.setItem(SCANNER_WORKSPACE_STORAGE_KEY, "{");
    expect(loadScannerWorkspace("native", COLUMNS, DEFAULTS, REQUIRED, malformed)).toMatchObject({ columns: DEFAULTS, visualization: "table", presets: [] });

    const oversized = new MemoryStorage();
    oversized.setItem(SCANNER_WORKSPACE_STORAGE_KEY, `{"version":2,"modes":{},"padding":"${"x".repeat(70_000)}"}`);
    expect(loadScannerWorkspace("basis", COLUMNS, DEFAULTS, REQUIRED, oversized).columns).toEqual(DEFAULTS);
  });

  it("bounds preset count, names, filters, numeric values and compare IDs", () => {
    const storage = new MemoryStorage();
    let value = loadScannerWorkspace("basis", COLUMNS, DEFAULTS, REQUIRED, storage);
    value = { ...value, columns: ["route", "net", "actions"], visualization: "compare", compareIds: ["a".repeat(200), "b".repeat(200)] };
    for (let index = 0; index < 15; index += 1) {
      value = saveScannerPreset(
        value,
        `  Preset ${index} ${"x".repeat(80)}  `,
        {
          minEdge: Number.MAX_VALUE,
          search: "z".repeat(200),
          enabled: true,
          invalid_key: "drop",
          invalidNumber: Number.NaN
        },
        index + 1
      );
    }
    value = storeScannerWorkspace("basis", value, COLUMNS, DEFAULTS, REQUIRED, storage);

    expect(value.presets).toHaveLength(12);
    expect(value.presets[0].name.length).toBeLessThanOrEqual(40);
    expect(value.presets[0].filters).toEqual({ minEdge: 1_000_000_000_000, search: "z".repeat(80), enabled: true });
    expect(value.presets[0].compareIds[0]).toHaveLength(120);
    expect(value.presets[0].compareIds[1]).toHaveLength(120);
    expect(JSON.stringify(JSON.parse(storage.getItem(SCANNER_WORKSPACE_STORAGE_KEY) ?? "null")).length).toBeLessThan(65_536);

    const selected = value.selectedPresetId;
    expect(deleteScannerPreset(value, selected)).toMatchObject({ selectedPresetId: "", presets: expect.not.arrayContaining([expect.objectContaining({ id: selected })]) });
  });

  it("keeps in-memory defaults when storage access is denied", () => {
    const denied = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
      removeItem() {
        throw new Error("denied");
      }
    };
    const loaded = loadScannerWorkspace("triangular", COLUMNS, DEFAULTS, REQUIRED, denied);
    expect(() => storeScannerWorkspace("triangular", loaded, COLUMNS, DEFAULTS, REQUIRED, denied)).not.toThrow();
    expect(loaded.columns).toEqual(DEFAULTS);
  });

  it("drops unrelated oversized mode baggage before losing the active workspace write", () => {
    const storage = new MemoryStorage();
    storage.setItem(SCANNER_WORKSPACE_STORAGE_KEY, JSON.stringify({ version: 2, modes: { native: { padding: "x".repeat(65_380) } } }));
    const basis = loadScannerWorkspace("basis", COLUMNS, DEFAULTS, REQUIRED, storage);
    storeScannerWorkspace("basis", { ...basis, visualization: "heatmap" }, COLUMNS, DEFAULTS, REQUIRED, storage);
    const stored = JSON.parse(storage.getItem(SCANNER_WORKSPACE_STORAGE_KEY) ?? "null");
    expect(stored.modes.basis.visualization).toBe("heatmap");
    expect(stored.modes.native).toBeUndefined();
  });

  it("claims a legacy workspace once and isolates authenticated owners", () => {
    const storage = new MemoryStorage();
    storage.setItem(TENANT_LOCAL_LEGACY_OWNER_KEY, "roman");
    storage.setItem(SCANNER_WORKSPACE_STORAGE_KEY, JSON.stringify({ version: 2, modes: { basis: { columns: ["route", "net", "actions"], visualization: "heatmap" } } }));

    const roman = loadScannerWorkspace("basis", COLUMNS, DEFAULTS, REQUIRED, storage, "roman");
    const arman = loadScannerWorkspace("basis", COLUMNS, DEFAULTS, REQUIRED, storage, "arman");

    expect(roman.visualization).toBe("heatmap");
    expect(arman.visualization).toBe("table");
    expect(storage.getItem(TENANT_LOCAL_LEGACY_OWNER_KEY)).toBe("roman");
    expect(storage.getItem(`${SCANNER_WORKSPACE_STORAGE_KEY}:roman`)).not.toBeNull();

    storeScannerWorkspace("basis", { ...arman, visualization: "compare" }, COLUMNS, DEFAULTS, REQUIRED, storage, "arman");
    expect(loadScannerWorkspace("basis", COLUMNS, DEFAULTS, REQUIRED, storage, "arman").visualization).toBe("compare");
    expect(loadScannerWorkspace("basis", COLUMNS, DEFAULTS, REQUIRED, storage, "roman").visualization).toBe("heatmap");
  });

  it("fails closed for an empty database-auth owner", () => {
    const storage = new MemoryStorage();
    storage.setItem(SCANNER_WORKSPACE_STORAGE_KEY, JSON.stringify({ version: 2, modes: { basis: { columns: ["route", "net", "actions"], visualization: "heatmap" } } }));

    const unavailable = loadScannerWorkspace("basis", COLUMNS, DEFAULTS, REQUIRED, storage, "");
    storeScannerWorkspace("basis", { ...unavailable, visualization: "compare" }, COLUMNS, DEFAULTS, REQUIRED, storage, "");

    expect(unavailable.visualization).toBe("table");
    expect(storage.getItem(TENANT_LOCAL_LEGACY_OWNER_KEY)).toBeNull();
    expect(loadScannerWorkspace("basis", COLUMNS, DEFAULTS, REQUIRED, storage).visualization).toBe("heatmap");
  });
});

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
