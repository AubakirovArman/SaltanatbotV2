import { randomBytes } from "node:crypto";
import { createDatabasePool, loadDatabaseConfig, migrateDatabase, verifyDatabaseConnection } from "../database/index.js";
import { PostgresIdentityRepository } from "../identity/postgresRepository.js";
import { IdentityError, IdentityService } from "../identity/service.js";

const login = argument("--login") ?? process.env.ADMIN_LOGIN?.trim() ?? "admin";
const suppliedPassword = argument("--password") ?? process.env.ADMIN_INITIAL_PASSWORD;
const generated = !suppliedPassword;
const password = suppliedPassword ?? generatePassword();
const pool = createDatabasePool(loadDatabaseConfig());

try {
  await verifyDatabaseConnection(pool);
  await migrateDatabase(pool);
  const user = await new IdentityService(new PostgresIdentityRepository(pool)).bootstrapAdmin(login, password);
  process.stdout.write(`Administrator created: ${user.login}\n`);
  process.stdout.write("The account must change its password after the first login.\n");
  if (generated) {
    process.stdout.write("One-time initial password (shown only now):\n");
    process.stdout.write(`${password}\n`);
  }
} catch (error) {
  const message = error instanceof IdentityError || error instanceof Error ? error.message : String(error);
  process.stderr.write(`Unable to bootstrap administrator: ${message}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value?.trim() || undefined;
}

function generatePassword(): string {
  return `Sb2-${randomBytes(24).toString("base64url")}`;
}
