import type { Pool } from "pg";
import { createDatabasePool, loadDatabaseConfig, migrateDatabase, verifyDatabaseConnection } from "../database/index.js";
import { configureIdentityAuth } from "../auth.js";
import { PostgresIdentityRepository } from "./postgresRepository.js";
import { IdentityService } from "./service.js";

export type AuthMode = "database" | "legacy";

export interface IdentityRuntime {
  mode: AuthMode;
  service?: IdentityService;
  pool?: Pool;
  database?: {
    database: string;
    user: string;
    serverVersionNumber: number;
  };
  close(): Promise<void>;
}

export function resolveAuthMode(env: NodeJS.ProcessEnv = process.env): AuthMode {
  const configured = env.AUTH_MODE?.trim().toLocaleLowerCase("en-US");
  if (configured === "database" || configured === "legacy") return configured;
  if (configured) throw new Error("AUTH_MODE must be 'database' or 'legacy'");
  if (env.NODE_ENV === "test") return "legacy";
  if ((env.DEMO_MODE === "1" || env.DEMO_MODE === "true") && env.AUTH_TOKEN?.trim()) return "legacy";
  return "database";
}

export async function initializeIdentityRuntime(env: NodeJS.ProcessEnv = process.env): Promise<IdentityRuntime> {
  const mode = resolveAuthMode(env);
  if (mode === "legacy") {
    configureIdentityAuth(undefined);
    return { mode, async close() {} };
  }

  const config = loadDatabaseConfig({ env });
  const pool = createDatabasePool(config);
  try {
    const connection = await verifyDatabaseConnection(pool);
    const migration = await migrateDatabase(pool);
    const service = new IdentityService(new PostgresIdentityRepository(pool), {
      sessionTtlMs: optionalNumber(env.AUTH_SESSION_TTL_MS),
      wsTicketTtlMs: optionalNumber(env.AUTH_WS_TICKET_TTL_MS),
      allowRegistration: env.AUTH_REGISTRATION_ENABLED !== "0" && env.AUTH_REGISTRATION_ENABLED !== "false",
      allowNonAdminTrading: env.AUTH_TRADING_ROLES_ENABLED !== "0" && env.AUTH_TRADING_ROLES_ENABLED !== "false"
    });
    configureIdentityAuth(service);
    console.log(
      `Identity database ready at ${config.description.host}:${config.description.port}/${connection.database} ` +
      `(schema ${migration.toVersion}, pool max ${config.description.poolMax}).`
    );
    return {
      mode,
      service,
      pool,
      database: {
        database: connection.database,
        user: connection.user,
        serverVersionNumber: connection.serverVersionNumber
      },
      async close() {
        configureIdentityAuth(undefined);
        await pool.end();
      }
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("Authentication TTL values must be positive numbers");
  return parsed;
}
