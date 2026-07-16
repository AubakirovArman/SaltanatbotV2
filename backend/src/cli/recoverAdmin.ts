import process from "node:process";
import { createDatabasePool, loadDatabaseConfig, verifyDatabaseConnection } from "../database/index.js";
import { PostgresIdentityRepository } from "../identity/postgresRepository.js";
import { IdentityError, IdentityService } from "../identity/service.js";
import {
  generateOneTimeAdminPassword,
  parseAdminRecoveryArguments,
  verifyCheckedInDatabaseSchema
} from "./adminRecoverySupport.js";

let exitCode = 0;
let pool: ReturnType<typeof createDatabasePool> | undefined;

try {
  const input = parseAdminRecoveryArguments(process.argv.slice(2));
  const oneTimePassword = generateOneTimeAdminPassword();
  pool = createDatabasePool(loadDatabaseConfig());
  await verifyDatabaseConnection(pool);
  await verifyCheckedInDatabaseSchema(pool);
  await new IdentityService(new PostgresIdentityRepository(pool)).recoverAdminPassword(
    input.login,
    oneTimePassword,
    input.reason
  );
  process.stdout.write(`Administrator password recovered: ${input.login}\n`);
  process.stdout.write("Every existing session was revoked. The account must change its password after the next login.\n");
  process.stdout.write("One-time recovery password (shown only now):\n");
  process.stdout.write(`${oneTimePassword}\n`);
} catch (error) {
  const message = error instanceof IdentityError || error instanceof Error ? error.message : String(error);
  process.stderr.write(`Unable to recover administrator password: ${message}\n`);
  exitCode = 1;
} finally {
  await pool?.end().catch(() => undefined);
}

process.exitCode = exitCode;
