import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { DATABASE_MIGRATIONS } from "../src/database/index.js";
import {
  assertCheckedInDatabaseSchema,
  generateOneTimeAdminPassword,
  parseAdminRecoveryArguments,
  verifyCheckedInDatabaseSchema
} from "../src/cli/adminRecoverySupport.js";

describe("guarded administrator recovery CLI", () => {
  it("requires an exact repeated login and an explicit printable reason", () => {
    expect(
      parseAdminRecoveryArguments([
        "--login",
        "owner-admin",
        "--confirm-login",
        "owner-admin",
        "--reason",
        "Lost the previous password during an operator handover"
      ])
    ).toEqual({
      login: "owner-admin",
      confirmLogin: "owner-admin",
      reason: "Lost the previous password during an operator handover"
    });

    expect(() =>
      parseAdminRecoveryArguments([
        "--login",
        "owner-admin",
        "--confirm-login",
        "Owner-admin",
        "--reason",
        "Case mismatch"
      ])
    ).toThrow(/exactly match/);
    expect(() =>
      parseAdminRecoveryArguments(["--login", "owner-admin", "--confirm-login", "owner-admin"])
    ).toThrow(/--reason is required/);
    expect(() =>
      parseAdminRecoveryArguments([
        "--login",
        "owner-admin",
        "--confirm-login",
        "owner-admin",
        "--reason",
        "line one\nline two"
      ])
    ).toThrow(/printable/);
  });

  it("rejects password arguments, unknown flags, duplicates and surrounding whitespace", () => {
    expect(() =>
      parseAdminRecoveryArguments([
        "--login",
        "owner-admin",
        "--confirm-login",
        "owner-admin",
        "--reason",
        "Operator recovery",
        "--password",
        "must-not-be-accepted"
      ])
    ).toThrow(/Unexpected argument: --password/);
    expect(() =>
      parseAdminRecoveryArguments([
        "--login",
        "owner-admin",
        "--login",
        "owner-admin",
        "--confirm-login",
        "owner-admin",
        "--reason",
        "Operator recovery"
      ])
    ).toThrow(/Duplicate argument: --login/);
    expect(() =>
      parseAdminRecoveryArguments([
        "--login",
        " owner-admin",
        "--confirm-login",
        " owner-admin",
        "--reason",
        "Operator recovery"
      ])
    ).toThrow(/whitespace/);
  });

  it("generates a strong password without accepting operator-supplied plaintext", () => {
    const first = generateOneTimeAdminPassword();
    const second = generateOneTimeAdminPassword();
    expect(first).toMatch(/^Sb2-[A-Za-z0-9_-]{32}$/);
    expect(second).toMatch(/^Sb2-[A-Za-z0-9_-]{32}$/);
    expect(second).not.toBe(first);
  });

  it("requires every checked-in migration with its exact name and checksum", () => {
    const applied = DATABASE_MIGRATIONS.map(({ version, name, checksum }) => ({
      version,
      name,
      checksum
    }));
    expect(() => assertCheckedInDatabaseSchema(applied)).not.toThrow();
    expect(() => assertCheckedInDatabaseSchema(applied.slice(0, -1))).toThrow(/exact checked-in/);
    expect(() =>
      assertCheckedInDatabaseSchema(
        applied.map((migration, index) =>
          index === applied.length - 1 ? { ...migration, checksum: "0".repeat(64) } : migration
        )
      )
    ).toThrow(/does not match/);
    expect(() =>
      assertCheckedInDatabaseSchema([
        ...applied,
        { version: applied.length + 1, name: "future", checksum: "f".repeat(64) }
      ])
    ).toThrow(/exact checked-in/);
  });

  it("performs only a read-only schema query and refuses an unavailable migration table", async () => {
    const queries: string[] = [];
    const applied = DATABASE_MIGRATIONS.map(({ version, name, checksum }) => ({
      version,
      name,
      checksum
    }));
    const pool = {
      query: async (text: string) => {
        queries.push(text);
        return { rows: applied };
      }
    } as unknown as Pick<Pool, "query">;

    await expect(verifyCheckedInDatabaseSchema(pool)).resolves.toBeUndefined();
    expect(queries).toEqual([
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC"
    ]);

    const unavailable = {
      query: async () => {
        throw new Error("relation does not exist");
      }
    } as unknown as Pick<Pool, "query">;
    await expect(verifyCheckedInDatabaseSchema(unavailable)).rejects.toThrow(/never runs migrations/);
  });

  it("keeps the executable free of migration and password-input escape hatches", () => {
    const source = readFileSync(new URL("../src/cli/recoverAdmin.ts", import.meta.url), "utf8");
    expect(source).not.toContain("migrateDatabase");
    expect(source).not.toContain("ADMIN_INITIAL_PASSWORD");
    expect(source).not.toMatch(/argument\(["']--password/);
    expect(source).toContain("generateOneTimeAdminPassword()");
  });

  it("publishes matching root and backend package commands", () => {
    const rootPackage = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8")
    ) as { scripts?: Record<string, string> };
    const backendPackage = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { scripts?: Record<string, string> };

    expect(rootPackage.scripts?.["admin:recover"]).toBe(
      "npm --workspace backend run admin:recover --"
    );
    expect(backendPackage.scripts?.["admin:recover"]).toBe("tsx src/cli/recoverAdmin.ts");
  });
});
