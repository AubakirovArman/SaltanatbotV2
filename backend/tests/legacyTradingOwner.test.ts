import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveLegacyTradingOwnerUserId,
  tradingStoreRequiresLegacyOwner
} from "../src/identity/legacyTradingOwner.js";
import type { IdentityRuntime } from "../src/identity/runtime.js";
import { LEGACY_TRADING_OWNER_ID } from "../src/trading/storeSchema.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function databasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "saltanat-legacy-owner-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "trading.db");
}

function databaseRuntime(users: Array<{ id: string; appRole: "admin" | "user" }>): IdentityRuntime {
  return {
    mode: "database",
    service: {
      repository: {
        listUsers: async () => users,
        findUserById: async (id: string) => users.find((user) => user.id === id)
      }
    }
  } as unknown as IdentityRuntime;
}

describe("legacy trading owner resolution", () => {
  it("fails closed when non-empty pre-v6 data has no unambiguous administrator", async () => {
    await expect(resolveLegacyTradingOwnerUserId(databaseRuntime([]), {}, true)).rejects.toThrow(/no administrator/i);
    await expect(resolveLegacyTradingOwnerUserId(databaseRuntime([
      { id: "admin-a", appRole: "admin" },
      { id: "admin-b", appRole: "admin" }
    ]), {}, true)).rejects.toThrow(/multiple administrators/i);
  });

  it("does not block an already migrated store merely because it has multiple administrators", async () => {
    const resolved = await resolveLegacyTradingOwnerUserId(databaseRuntime([
      { id: "admin-a", appRole: "admin" },
      { id: "admin-b", appRole: "admin" }
    ]), {}, false);

    expect(resolved).toBe(LEGACY_TRADING_OWNER_ID);
  });

  it("accepts the sole or explicitly configured administrator for a required migration", async () => {
    expect(await resolveLegacyTradingOwnerUserId(
      databaseRuntime([{ id: "admin-a", appRole: "admin" }]),
      {},
      true
    )).toBe("admin-a");
    expect(await resolveLegacyTradingOwnerUserId(
      databaseRuntime([
        { id: "admin-a", appRole: "admin" },
        { id: "admin-b", appRole: "admin" }
      ]),
      { TRADING_LEGACY_OWNER_USER_ID: "admin-b" },
      true
    )).toBe("admin-b");
  });

  it("requires an owner only for a non-empty pre-v6 SQLite store", () => {
    const file = databasePath();
    const database = new DatabaseSync(file);
    database.exec(`
      CREATE TABLE bots (id TEXT PRIMARY KEY);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, encrypted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE arbitrage_history (routeId TEXT);
      PRAGMA user_version = 5;
    `);
    database.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("arbitrage:public-feed-state", "{}");
    database.prepare("INSERT INTO arbitrage_history (routeId) VALUES (?)").run("public-route");
    database.close();
    expect(tradingStoreRequiresLegacyOwner(file)).toBe(false);

    const populated = new DatabaseSync(file);
    populated.prepare("INSERT INTO bots (id) VALUES (?)").run("legacy-bot");
    populated.close();
    expect(tradingStoreRequiresLegacyOwner(file)).toBe(true);

    const migrated = new DatabaseSync(file);
    migrated.exec("PRAGMA user_version = 6;");
    migrated.close();
    expect(tradingStoreRequiresLegacyOwner(file)).toBe(false);
  });
});
