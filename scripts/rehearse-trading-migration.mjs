#!/usr/bin/env node
// Release-time SQLite migration rehearsal: copies a trading.db file, runs the
// real migrateTradingStore chain on the COPY only, and prints the applied
// versions as JSON. The source database is never opened for writing.
//
//   node scripts/rehearse-trading-migration.mjs <path/to/trading.db> [copy-path]
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = process.argv[2];
if (!sourcePath) {
  console.error("Usage: node scripts/rehearse-trading-migration.mjs <path/to/trading.db> [copy-path]");
  process.exit(2);
}
const source = resolve(sourcePath);
if (!existsSync(source)) {
  console.error(`Trading database not found: ${source}`);
  process.exit(2);
}
const copy = resolve(process.argv[3] ?? `${source}.rehearsal-${Date.now()}.db`);
if (copy === source) {
  console.error("The rehearsal copy path must differ from the source database.");
  process.exit(2);
}

const { migrateTradingStore, TRADING_SCHEMA_VERSION } = await loadStoreSchema();
mkdirSync(dirname(copy), { recursive: true });
for (const suffix of ["-wal", "-shm"]) rmSync(`${copy}${suffix}`, { force: true });
copyFileSync(source, copy);
for (const suffix of ["-wal", "-shm"]) {
  if (existsSync(`${source}${suffix}`)) copyFileSync(`${source}${suffix}`, `${copy}${suffix}`);
}

const database = new DatabaseSync(copy);
try {
  const result = migrateTradingStore(database);
  console.log(JSON.stringify({
    source,
    copy,
    supportedVersion: TRADING_SCHEMA_VERSION,
    fromVersion: result.fromVersion,
    toVersion: result.toVersion,
    applied: result.applied
  }, null, 2));
} finally {
  database.close();
}

/** Prefers the checked-out TypeScript source (via tsx) so the rehearsal always
 * matches this working tree; a compiled dist is only a fallback. */
async function loadStoreSchema() {
  try {
    const { tsImport } = await import("tsx/esm/api");
    return await tsImport(pathToFileURL(resolve(root, "backend/src/trading/storeSchema.ts")).href, import.meta.url);
  } catch {
    return import(pathToFileURL(resolve(root, "backend/dist/trading/storeSchema.js")).href);
  }
}
