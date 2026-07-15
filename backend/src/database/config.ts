import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { PoolConfig } from "pg";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 55_434;
const DEFAULT_DATABASE = "saltanatbotv2";
const DEFAULT_USER = "saltanatbotv2";
const MAX_SECRET_BYTES = 8 * 1024;

export interface DatabaseConfig {
  readonly source: "database-url" | "parameters";
  readonly pool: PoolConfig;
  readonly description: Readonly<{
    host: string;
    port: number;
    database: string;
    user: string;
    sslMode: string;
    poolMax: number;
  }>;
}

export interface DatabaseConfigOptions {
  env?: NodeJS.ProcessEnv;
  readSecret?: (absolutePath: string) => string;
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number
): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function requiredText(value: string | undefined, fallback: string, name: string): string {
  const normalized = value?.trim() || fallback;
  if (normalized.includes("\0")) throw new Error(`${name} contains an invalid NUL byte`);
  if (normalized.length > 255) throw new Error(`${name} is too long`);
  return normalized;
}

function defaultSecretReader(absolutePath: string): string {
  const metadata = statSync(absolutePath);
  if (!metadata.isFile()) throw new Error("password file is not a regular file");
  if (metadata.size > MAX_SECRET_BYTES) throw new Error("password file is too large");
  return readFileSync(absolutePath, "utf8");
}

function readPasswordFile(filePath: string, readSecret: (absolutePath: string) => string): string {
  if (filePath.includes("\0") || filePath.length > 4_096) {
    throw new Error("PGPASSWORD_FILE is invalid");
  }
  if (!path.isAbsolute(filePath)) throw new Error("PGPASSWORD_FILE must be an absolute path");

  let contents: string;
  try {
    contents = readSecret(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Unable to read PGPASSWORD_FILE: ${message}`);
  }
  if (Buffer.byteLength(contents, "utf8") > MAX_SECRET_BYTES) {
    throw new Error("PGPASSWORD_FILE is too large");
  }
  const password = contents.replace(/\r?\n$/, "");
  if (password.length === 0) throw new Error("PGPASSWORD_FILE is empty");
  if (password.includes("\0")) throw new Error("PGPASSWORD_FILE contains an invalid NUL byte");
  return password;
}

function parseDatabaseUrl(raw: string): URL {
  if (raw.length > 8_192 || raw.includes("\0")) throw new Error("DATABASE_URL is invalid");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol");
  }
  if (!parsed.hostname) throw new Error("DATABASE_URL must include a hostname");
  return parsed;
}

function safelyDecodeUrlPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function commonPoolConfig(env: NodeJS.ProcessEnv): Pick<PoolConfig,
  | "max"
  | "idleTimeoutMillis"
  | "connectionTimeoutMillis"
  | "query_timeout"
  | "statement_timeout"
  | "idle_in_transaction_session_timeout"
  | "keepAlive"
  | "application_name"
> {
  return {
    max: parseInteger(env.PGPOOL_MAX, 12, "PGPOOL_MAX", 1, 100),
    idleTimeoutMillis: parseInteger(env.PGPOOL_IDLE_TIMEOUT_MS, 30_000, "PGPOOL_IDLE_TIMEOUT_MS", 1_000, 3_600_000),
    connectionTimeoutMillis: parseInteger(
      env.PGPOOL_CONNECTION_TIMEOUT_MS,
      5_000,
      "PGPOOL_CONNECTION_TIMEOUT_MS",
      250,
      120_000
    ),
    query_timeout: parseInteger(env.PG_QUERY_TIMEOUT_MS, 30_000, "PG_QUERY_TIMEOUT_MS", 250, 3_600_000),
    statement_timeout: parseInteger(
      env.PG_STATEMENT_TIMEOUT_MS,
      30_000,
      "PG_STATEMENT_TIMEOUT_MS",
      250,
      3_600_000
    ),
    idle_in_transaction_session_timeout: parseInteger(
      env.PG_IDLE_TRANSACTION_TIMEOUT_MS,
      15_000,
      "PG_IDLE_TRANSACTION_TIMEOUT_MS",
      250,
      3_600_000
    ),
    keepAlive: true,
    application_name: requiredText(env.PGAPPNAME, "saltanatbotv2-api", "PGAPPNAME")
  };
}

/**
 * Builds a node-postgres pool configuration without opening a connection.
 * DATABASE_URL takes precedence over PGHOST/PGPORT/PGDATABASE/PGUSER.
 */
export function loadDatabaseConfig(options: DatabaseConfigOptions = {}): DatabaseConfig {
  const env = options.env ?? process.env;
  const common = commonPoolConfig(env);
  const databaseUrl = env.DATABASE_URL?.trim();

  if (databaseUrl) {
    if (env.PGPASSWORD_FILE?.trim()) {
      throw new Error("PGPASSWORD_FILE cannot be combined with DATABASE_URL; put the password in the URL or use PG* parameters");
    }
    const parsed = parseDatabaseUrl(databaseUrl);
    const port = parsed.port ? parseInteger(parsed.port, 5_432, "DATABASE_URL port", 1, 65_535) : 5_432;
    return {
      source: "database-url",
      pool: { ...common, connectionString: databaseUrl },
      description: {
        host: parsed.hostname,
        port,
        database: safelyDecodeUrlPart(parsed.pathname.replace(/^\//, "")) || safelyDecodeUrlPart(parsed.username),
        user: safelyDecodeUrlPart(parsed.username),
        sslMode: parsed.searchParams.get("sslmode") ?? env.PGSSLMODE ?? "default",
        poolMax: common.max ?? 12
      }
    };
  }

  if (env.PGPASSWORD !== undefined && env.PGPASSWORD_FILE?.trim()) {
    throw new Error("Set only one of PGPASSWORD or PGPASSWORD_FILE");
  }
  const host = requiredText(env.PGHOST, DEFAULT_HOST, "PGHOST");
  const port = parseInteger(env.PGPORT, DEFAULT_PORT, "PGPORT", 1, 65_535);
  const database = requiredText(env.PGDATABASE, DEFAULT_DATABASE, "PGDATABASE");
  const user = requiredText(env.PGUSER, DEFAULT_USER, "PGUSER");
  const passwordFile = env.PGPASSWORD_FILE?.trim();
  const password = passwordFile
    ? readPasswordFile(passwordFile, options.readSecret ?? defaultSecretReader)
    : env.PGPASSWORD;
  if (password?.includes("\0")) throw new Error("PGPASSWORD contains an invalid NUL byte");
  if (password && Buffer.byteLength(password, "utf8") > MAX_SECRET_BYTES) {
    throw new Error("PGPASSWORD is too large");
  }

  return {
    source: "parameters",
    pool: { ...common, host, port, database, user, password },
    description: {
      host,
      port,
      database,
      user,
      sslMode: env.PGSSLMODE ?? "default",
      poolMax: common.max ?? 12
    }
  };
}

export function isDatabaseConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.DATABASE_URL?.trim() ||
      env.PGDATABASE?.trim() ||
      env.PGUSER?.trim() ||
      env.PGPASSWORD?.length ||
      env.PGPASSWORD_FILE?.trim()
  );
}
