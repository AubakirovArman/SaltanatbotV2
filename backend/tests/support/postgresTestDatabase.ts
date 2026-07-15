import type { Pool } from "pg";

const TEST_DATABASE_NAME = /(^|[_-])(test|testing)([_-]|$)/i;

/** Refuses destructive integration setup unless PostgreSQL confirms a test-only database name. */
export async function assertIsolatedTestDatabase(pool: Pool, variableName: string): Promise<void> {
  const result = await pool.query<{ name: string }>("SELECT current_database()::text AS name");
  const name = result.rows[0]?.name ?? "";
  if (!TEST_DATABASE_NAME.test(name)) {
    throw new Error(`${variableName} must point to an isolated database whose name contains a test segment; received ${name || "an unknown database"}.`);
  }
}
