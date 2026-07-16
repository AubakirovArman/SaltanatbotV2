import type { Pool } from "pg";

const TEST_DATABASE_NAME = /(^|[_-])(test|testing)([_-]|$)/i;

interface TestDatabaseRoleRow {
  name: string;
  role_name: string;
  is_superuser: boolean;
  can_create_database: boolean;
  can_create_role: boolean;
}

/**
 * Refuses destructive integration setup unless the caller explicitly opts in
 * and PostgreSQL confirms both an isolated test database and an unprivileged
 * current role.
 */
export async function assertIsolatedTestDatabase(
  pool: Pool,
  variableName: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (env.ALLOW_DESTRUCTIVE_POSTGRES_TESTS !== "1") {
    throw new Error("Destructive PostgreSQL integration tests require ALLOW_DESTRUCTIVE_POSTGRES_TESTS=1.");
  }
  const result = await pool.query<TestDatabaseRoleRow>(
    `SELECT
       current_database()::text AS name,
       current_user::text AS role_name,
       role.rolsuper AS is_superuser,
       role.rolcreatedb AS can_create_database,
       role.rolcreaterole AS can_create_role
     FROM pg_catalog.pg_roles role
     WHERE role.rolname = current_user`
  );
  const row = result.rows[0];
  const name = row?.name ?? "";
  if (!TEST_DATABASE_NAME.test(name)) {
    throw new Error(`${variableName} must point to an isolated database whose name contains a test segment; received ${name || "an unknown database"}.`);
  }
  if (!row?.role_name) {
    throw new Error(`${variableName} could not verify the current PostgreSQL role.`);
  }
  if (row.is_superuser || row.can_create_database || row.can_create_role) {
    throw new Error(
      `${variableName} must use an unprivileged PostgreSQL role without SUPERUSER, CREATEDB or CREATEROLE; received ${row.role_name}.`
    );
  }
}
