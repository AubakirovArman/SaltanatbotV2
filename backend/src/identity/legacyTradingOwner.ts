import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LEGACY_TRADING_OWNER_ID, TRADING_SCHEMA_VERSION } from "../trading/storeSchema.js";
import type { IdentityRuntime } from "./runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultTradingDatabasePath = path.resolve(__dirname, "../../data/trading.db");
const legacyDataTables = [
  "bots",
  "fills",
  "orders",
  "order_events",
  "logs",
  "audit_log",
  "positions",
  "strategy_runs",
  "paper_events",
  "trading_accounts"
] as const;

/** Select the only database user allowed to inherit pre-tenant SQLite data. */
export async function resolveLegacyTradingOwnerUserId(
  runtime: IdentityRuntime,
  env: NodeJS.ProcessEnv = process.env,
  legacyOwnershipRequired?: boolean
): Promise<string> {
  if (runtime.mode === "legacy" || !runtime.service) return LEGACY_TRADING_OWNER_ID;
  const ownershipRequired = legacyOwnershipRequired ?? tradingStoreRequiresLegacyOwner();
  const configured = env.TRADING_LEGACY_OWNER_USER_ID?.trim();
  if (configured) {
    const user = await runtime.service.repository.findUserById(configured);
    if (!user || user.appRole !== "admin") {
      throw new Error("TRADING_LEGACY_OWNER_USER_ID must identify an existing application administrator.");
    }
    return user.id;
  }
  const administrators = (await runtime.service.repository.listUsers()).filter((user) => user.appRole === "admin");
  if (!ownershipRequired) return administrators.length === 1 ? administrators[0]!.id : LEGACY_TRADING_OWNER_ID;
  if (administrators.length === 0) {
    throw new Error("Legacy trading data exists but no administrator can inherit it; bootstrap an administrator before migration.");
  }
  if (administrators.length > 1) {
    throw new Error("Multiple administrators exist; set TRADING_LEGACY_OWNER_USER_ID before migrating legacy trading data.");
  }
  return administrators[0]!.id;
}

/** True only while a non-empty pre-tenant store still needs an explicit owner. */
export function tradingStoreRequiresLegacyOwner(databasePath = defaultTradingDatabasePath): boolean {
  if (!existsSync(databasePath)) return false;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const version = Number((database.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)?.user_version ?? 0);
    if (version >= TRADING_SCHEMA_VERSION) return false;
    const tables = new Set(
      (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map((row) => row.name)
    );
    if (legacyDataTables.some((table) => tables.has(table) && database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined)) {
      return true;
    }
    if (!tables.has("settings")) return false;
    return database.prepare(`
      SELECT 1 FROM settings
      WHERE key IN (
        'keys:binance', 'keys:bybit', 'liveTradingEnabled', 'liveSpotEnabled',
        'notify', 'tradingEmergencyStop', 'mutedBots'
      )
      OR key LIKE 'paper:%'
      OR key LIKE 'state:%'
      OR key LIKE 'inventory:%'
      OR key LIKE 'futures-exposure:%'
      OR key LIKE 'owner:%'
      LIMIT 1
    `).get() !== undefined;
  } finally {
    database.close();
  }
}
