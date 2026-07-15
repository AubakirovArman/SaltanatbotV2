import type { Pool, PoolClient } from "pg";
import {
  DATABASE_MIGRATIONS,
  SCHEMA_MIGRATIONS_TABLE_SQL,
  type DatabaseMigration
} from "./schema.js";

const ADVISORY_LOCK_NAMESPACE = 1_397_314_374;
const ADVISORY_LOCK_RESOURCE = 1_185_851_822;

interface AppliedMigrationRow {
  version: number;
  name: string;
  checksum: string;
}

export interface MigrationResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly applied: readonly Readonly<Pick<DatabaseMigration, "version" | "name">>[];
}

export interface MigrationOptions {
  lockTimeoutMs?: number;
  migrations?: readonly DatabaseMigration[];
}

function validateMigrationDefinitions(migrations: readonly DatabaseMigration[]): void {
  let expectedVersion = 1;
  const names = new Set<string>();
  for (const migration of migrations) {
    if (migration.version !== expectedVersion) {
      throw new Error(`Database migrations must be contiguous; expected version ${expectedVersion}`);
    }
    if (names.has(migration.name)) throw new Error(`Duplicate database migration name: ${migration.name}`);
    if (!/^[0-9a-f]{64}$/.test(migration.checksum)) {
      throw new Error(`Database migration ${migration.version} has an invalid checksum`);
    }
    names.add(migration.name);
    expectedVersion += 1;
  }
}

function validateAppliedMigrations(
  appliedRows: readonly AppliedMigrationRow[],
  migrations: readonly DatabaseMigration[]
): number {
  for (const [index, row] of appliedRows.entries()) {
    const expectedAppliedVersion = index + 1;
    if (row.version !== expectedAppliedVersion) {
      throw new Error(
        `Database migration history has a gap: expected version ${expectedAppliedVersion}, found ${row.version}`
      );
    }
    const expected = migrations.find((migration) => migration.version === row.version);
    if (!expected) {
      throw new Error(
        `Database schema version ${row.version} is newer than this application supports (${migrations.at(-1)?.version ?? 0})`
      );
    }
    if (row.name !== expected.name || row.checksum !== expected.checksum) {
      throw new Error(`Database migration ${row.version} does not match the checked-in schema; refusing to continue`);
    }
  }
  return appliedRows.at(-1)?.version ?? 0;
}

async function acquireMigrationLock(client: PoolClient, lockTimeoutMs: number): Promise<void> {
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 250 || lockTimeoutMs > 300_000) {
    throw new Error("Migration lock timeout must be between 250 and 300000 milliseconds");
  }
  await client.query("SELECT set_config('lock_timeout', $1, true)", [`${lockTimeoutMs}ms`]);
  await client.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)", [
    ADVISORY_LOCK_NAMESPACE,
    ADVISORY_LOCK_RESOURCE
  ]);
}

/** Applies all checked-in migrations atomically while holding a transaction-scoped advisory lock. */
export async function migrateDatabase(pool: Pool, options: MigrationOptions = {}): Promise<MigrationResult> {
  const migrations = options.migrations ?? DATABASE_MIGRATIONS;
  validateMigrationDefinitions(migrations);
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await acquireMigrationLock(client, options.lockTimeoutMs ?? 30_000);
    await client.query(SCHEMA_MIGRATIONS_TABLE_SQL);

    const appliedResult = await client.query<AppliedMigrationRow>(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC"
    );
    const fromVersion = validateAppliedMigrations(appliedResult.rows, migrations);
    const applied: Array<Readonly<Pick<DatabaseMigration, "version" | "name">>> = [];

    for (const migration of migrations) {
      if (migration.version <= fromVersion) continue;
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
        [migration.version, migration.name, migration.checksum]
      );
      applied.push({ version: migration.version, name: migration.name });
    }

    await client.query("COMMIT");
    transactionOpen = false;
    return {
      fromVersion,
      toVersion: migrations.at(-1)?.version ?? 0,
      applied
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the migration error; releasing the client removes the broken transaction.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
