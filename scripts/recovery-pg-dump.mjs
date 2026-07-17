#!/usr/bin/env node

import { COMPOSE_RECOVERY_PROJECT_ROOT, runComposePostgresRecoveryTool } from "./lib/compose-postgres-recovery-tool.mjs";

runComposePostgresRecoveryTool("pg_dump", process.argv.slice(2), {
  projectRoot: COMPOSE_RECOVERY_PROJECT_ROOT
})
  .then((result) => {
    if (result.signal) {
      process.kill(process.pid, result.signal);
      return;
    }
    process.exitCode = result.code ?? 1;
  })
  .catch((error) => {
    console.error(`Safe Compose pg_dump wrapper failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
