import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { assertIsolatedTestDatabase } from "./support/postgresTestDatabase.js";

function poolWithRole(overrides: Partial<{
  name: string;
  role_name: string;
  is_superuser: boolean;
  can_create_database: boolean;
  can_create_role: boolean;
}> = {}): Pool {
  return {
    query: async () => ({
      rows: [{
        name: "saltanatbotv2_ci_test",
        role_name: "saltanatbotv2_test",
        is_superuser: false,
        can_create_database: false,
        can_create_role: false,
        ...overrides
      }]
    })
  } as unknown as Pool;
}

describe("destructive PostgreSQL integration guard", () => {
  it("requires an exact explicit opt-in", async () => {
    await expect(assertIsolatedTestDatabase(
      poolWithRole(),
      "JOBS_TEST_DATABASE_URL",
      { ALLOW_DESTRUCTIVE_POSTGRES_TESTS: "true" }
    )).rejects.toThrow(/ALLOW_DESTRUCTIVE_POSTGRES_TESTS=1/);
  });

  it("requires a test-like database name", async () => {
    await expect(assertIsolatedTestDatabase(
      poolWithRole({ name: "saltanatbotv2" }),
      "JOBS_TEST_DATABASE_URL",
      { ALLOW_DESTRUCTIVE_POSTGRES_TESTS: "1" }
    )).rejects.toThrow(/isolated database/i);
  });

  it.each([
    ["SUPERUSER", { is_superuser: true }],
    ["CREATEDB", { can_create_database: true }],
    ["CREATEROLE", { can_create_role: true }]
  ])("rejects a role with %s", async (_label, role) => {
    await expect(assertIsolatedTestDatabase(
      poolWithRole(role),
      "JOBS_TEST_DATABASE_URL",
      { ALLOW_DESTRUCTIVE_POSTGRES_TESTS: "1" }
    )).rejects.toThrow(/unprivileged PostgreSQL role/i);
  });

  it("accepts an explicit isolated database and unprivileged role", async () => {
    await expect(assertIsolatedTestDatabase(
      poolWithRole(),
      "JOBS_TEST_DATABASE_URL",
      { ALLOW_DESTRUCTIVE_POSTGRES_TESTS: "1" }
    )).resolves.toBeUndefined();
  });
});
