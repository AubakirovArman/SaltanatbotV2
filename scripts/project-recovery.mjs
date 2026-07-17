import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProjectRecoveryBackup, drillProjectRecovery, restoreProjectRecovery, verifyProjectRecovery } from "./lib/project-recovery.mjs";
import { recoveryStatusReceiptFromVerification, writeProjectRecoveryStatusReceipt } from "./lib/project-recovery-status.mjs";

const valueOptions = new Set(["--output", "--data-dir", "--current-data-dir", "--target-database", "--target-owner", "--temporary-root", "--release-commit", "--status-file"]);

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArguments(argv);
  if (!parsed.command || parsed.command === "help" || parsed.options.has("--help")) {
    printUsage();
    return;
  }
  if (parsed.command !== "verify" && parsed.options.has("--status-file")) {
    throw new Error("--status-file is supported only by recovery:verify");
  }
  if (parsed.command === "backup") {
    assertNoPositionals(parsed, 0);
    const result = await createProjectRecoveryBackup({
      outputDirectory: requiredOption(parsed, "--output"),
      dataDirectory: parsed.options.get("--data-dir"),
      releaseCommit: parsed.options.get("--release-commit")
    });
    console.log(
      JSON.stringify({
        event: "project_recovery_backup_verified",
        generationId: result.manifest.generationId,
        generationDirectory: result.generationDirectory,
        captureSpanMs: result.manifest.capture.spanMs
      })
    );
    return;
  }
  if (parsed.command === "verify") {
    assertNoPositionals(parsed, 1);
    const result = verifyProjectRecovery(requiredPositional(parsed, 0));
    const statusFile = parsed.options.get("--status-file");
    if (statusFile) {
      assertStatusFileOutsideGeneration(statusFile, result.generationDirectory);
      writeProjectRecoveryStatusReceipt(statusFile, recoveryStatusReceiptFromVerification(result));
    }
    console.log(
      JSON.stringify({
        event: "project_recovery_generation_verified",
        generationId: result.manifest.generationId,
        generationDirectory: result.generationDirectory,
        postgresSchemaVersion: result.manifest.postgres.migrations.at(-1)?.version ?? 0,
        captureSpanMs: result.manifest.capture.spanMs
      })
    );
    return;
  }
  if (parsed.command === "restore") {
    assertNoPositionals(parsed, 1);
    const result = await restoreProjectRecovery({
      generationDirectory: requiredPositional(parsed, 0),
      targetDatabase: requiredOption(parsed, "--target-database"),
      targetDataDirectory: requiredOption(parsed, "--data-dir"),
      currentDataDirectory: parsed.options.get("--current-data-dir"),
      targetOwner: parsed.options.get("--target-owner")
    });
    console.log(
      JSON.stringify({
        event: "project_recovery_replacement_verified",
        generationId: result.generationId,
        targetDatabase: result.targetDatabase,
        targetDataDirectory: result.targetDataDirectory,
        cutoverPerformed: false
      })
    );
    console.log("Replacement resources were verified. No service, PGDATABASE, Compose or runtime path was changed.");
    return;
  }
  if (parsed.command === "drill") {
    assertNoPositionals(parsed, 1);
    const result = await drillProjectRecovery({
      generationDirectory: requiredPositional(parsed, 0),
      currentDataDirectory: parsed.options.get("--current-data-dir"),
      temporaryRoot: parsed.options.get("--temporary-root"),
      targetOwner: parsed.options.get("--target-owner")
    });
    console.log(
      JSON.stringify({
        event: "project_recovery_drill_passed",
        generationId: result.generationId,
        temporaryDatabase: result.targetDatabase,
        cleanup: result.cleanup
      })
    );
    return;
  }
  throw new Error(`Unknown project recovery command: ${parsed.command}`);
}

function parseArguments(argv) {
  const [command, ...args] = argv;
  const options = new Map();
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (argument === "--help") {
      options.set(argument, "1");
      continue;
    }
    if (!valueOptions.has(argument)) throw new Error(`Unknown option: ${argument}`);
    if (options.has(argument)) throw new Error(`Duplicate option: ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    options.set(argument, value);
    index += 1;
  }
  return { command, options, positionals };
}

function requiredOption(parsed, name) {
  const value = parsed.options.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredPositional(parsed, index) {
  const value = parsed.positionals[index];
  if (!value) throw new Error("Recovery generation directory is required");
  return value;
}

function assertNoPositionals(parsed, expected) {
  if (parsed.positionals.length !== expected) {
    throw new Error(`Expected ${expected} positional argument(s), received ${parsed.positionals.length}`);
  }
}

function assertStatusFileOutsideGeneration(statusFile, generationDirectory) {
  if (!path.isAbsolute(statusFile) || path.normalize(statusFile) !== statusFile) {
    throw new Error("recovery status file must be a normalized absolute path");
  }
  const generation = path.resolve(generationDirectory);
  const relative = path.relative(generation, statusFile);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("Recovery status file must be outside the verified generation");
  }
}

function printUsage() {
  console.log(`Usage:
  npm run recovery:backup -- --output <new-generation-dir> [--data-dir <current-data-dir>] [--release-commit <unknown|40/64-hex>]
  npm run recovery:verify -- <generation-dir> [--status-file <absolute-owner-only-receipt>]
  npm run recovery:restore -- <generation-dir> --target-database <source_restore_name> --data-dir <new-data-dir> [--current-data-dir <current-data-dir>] [--target-owner <role>]
  npm run recovery:drill -- <generation-dir> [--temporary-root <dir>] [--current-data-dir <current-data-dir>] [--target-owner <role>]

PostgreSQL source:
  RECOVERY_SOURCE_DATABASE_URL, then DATABASE_URL, then ordinary PGHOST/PGPORT/PGDATABASE/PGUSER.

PostgreSQL operator for CREATE/DROP DATABASE:
  RECOVERY_OPERATOR_DATABASE_URL or RECOVERY_OPERATOR_PG*; otherwise the source connection is reused.

The restore command creates a database whose name starts with <source>_restore_ and refuses any
existing database, current runtime data directory, non-empty directory or symbolic link. It never
changes services, Compose, PGDATABASE or the active runtime path.

The optional verify receipt appends one newline-committed record only after full verification succeeds.
Its bounded owner-only journal must remain a single-link file; hard-linked aliases are rejected. It never
contains a database name, owner or full generation path. Concurrent writers serialize through the
permanent owner-only .recovery-status.lock and trusted /usr/bin/flock; never remove that lock file.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Project recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
