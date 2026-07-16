import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { DATABASE_MIGRATIONS, type DatabaseMigration } from "../database/index.js";

const MAX_REASON_LENGTH = 500;

export interface AdminRecoveryArguments {
  login: string;
  confirmLogin: string;
  reason: string;
}

interface AppliedMigrationRow {
  version: number;
  name: string;
  checksum: string;
}

type SchemaReader = Pick<Pool, "query">;

export function parseAdminRecoveryArguments(values: readonly string[]): AdminRecoveryArguments {
  const parsed = new Map<string, string>();
  const allowed = new Set(["--login", "--confirm-login", "--reason"]);

  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (!name || !allowed.has(name)) throw new Error(`Unexpected argument: ${name ?? "<missing>"}`);
    if (parsed.has(name)) throw new Error(`Duplicate argument: ${name}`);
    const value = values[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
    parsed.set(name, value);
  }

  const login = requiredTrimmed(parsed.get("--login"), "--login");
  const confirmLogin = requiredTrimmed(parsed.get("--confirm-login"), "--confirm-login");
  const reason = requiredTrimmed(parsed.get("--reason"), "--reason");
  if (login !== confirmLogin) {
    throw new Error("--confirm-login must exactly match --login");
  }
  if (reason.length > MAX_REASON_LENGTH || containsControlCharacter(reason)) {
    throw new Error(`--reason must contain 1-${MAX_REASON_LENGTH} printable characters`);
  }
  return { login, confirmLogin, reason };
}

export function generateOneTimeAdminPassword(): string {
  return `Sb2-${randomBytes(24).toString("base64url")}`;
}

export async function verifyCheckedInDatabaseSchema(
  pool: SchemaReader,
  migrations: readonly DatabaseMigration[] = DATABASE_MIGRATIONS
): Promise<void> {
  let rows: readonly AppliedMigrationRow[];
  try {
    const result = await pool.query<AppliedMigrationRow>(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC"
    );
    rows = result.rows;
  } catch {
    throw new Error(
      "Unable to verify the PostgreSQL schema. Administrator recovery never runs migrations; use the normal verified upgrade procedure first."
    );
  }
  assertCheckedInDatabaseSchema(rows, migrations);
}

export function assertCheckedInDatabaseSchema(
  applied: readonly AppliedMigrationRow[],
  migrations: readonly DatabaseMigration[] = DATABASE_MIGRATIONS
): void {
  if (applied.length !== migrations.length) {
    throw new Error(
      `Administrator recovery requires the exact checked-in PostgreSQL schema (${migrations.length} migrations applied; found ${applied.length}).`
    );
  }
  for (const [index, expected] of migrations.entries()) {
    const actual = applied[index];
    if (
      actual?.version !== expected.version
      || actual.name !== expected.name
      || actual.checksum !== expected.checksum
    ) {
      throw new Error(
        `Administrator recovery requires the exact checked-in PostgreSQL schema; migration ${expected.version} does not match.`
      );
    }
  }
}

function requiredTrimmed(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  if (value !== value.trim()) throw new Error(`${name} must not contain leading or trailing whitespace`);
  return value;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}
