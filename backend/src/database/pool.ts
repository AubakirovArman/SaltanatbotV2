import { Pool, type PoolConfig } from "pg";
import type { DatabaseConfig } from "./config.js";

export interface DatabasePoolOptions {
  onIdleClientError?: (error: Error) => void;
}

export interface DatabaseConnectionInfo {
  readonly database: string;
  readonly user: string;
  readonly serverVersionNumber: number;
  readonly serverTime: Date;
}

interface ConnectionInfoRow {
  database: string;
  user_name: string;
  server_version_number: string;
  server_time: Date;
}

function unwrapPoolConfig(config: DatabaseConfig | PoolConfig): PoolConfig {
  return "pool" in config ? config.pool : config;
}

/** Creates an isolated pool. It never reads or opens any SQLite database. */
export function createDatabasePool(
  config: DatabaseConfig | PoolConfig,
  options: DatabasePoolOptions = {}
): Pool {
  const pool = new Pool(unwrapPoolConfig(config));
  pool.on("error", (error) => {
    if (options.onIdleClientError) options.onIdleClientError(error);
    else console.error(`PostgreSQL idle client error: ${error.message}`);
  });
  return pool;
}

export async function verifyDatabaseConnection(pool: Pool): Promise<DatabaseConnectionInfo> {
  const result = await pool.query<ConnectionInfoRow>(`
    SELECT
      current_database() AS database,
      current_user AS user_name,
      current_setting('server_version_num') AS server_version_number,
      clock_timestamp() AS server_time
  `);
  const row = result.rows[0];
  if (!row) throw new Error("PostgreSQL connection check returned no rows");
  const serverVersionNumber = Number(row.server_version_number);
  if (!Number.isSafeInteger(serverVersionNumber)) {
    throw new Error("PostgreSQL returned an invalid server version");
  }
  return {
    database: row.database,
    user: row.user_name,
    serverVersionNumber,
    serverTime: row.server_time
  };
}
