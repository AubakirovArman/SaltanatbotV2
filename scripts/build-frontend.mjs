import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publishFrontendCandidate } from "./lib/frontend-publication.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontend = path.resolve(root, "frontend");
const stagingRoot = path.resolve(frontend, ".dist-staging");
const candidate = path.resolve(stagingRoot, randomUUID());
const vite = path.resolve(root, "node_modules/vite/bin/vite.js");

mkdirSync(candidate, { recursive: true });

try {
  execFileSync(process.execPath, [vite, "build", "--outDir", candidate, "--emptyOutDir"], {
    cwd: frontend,
    env: process.env,
    stdio: "inherit"
  });

  const candidateEnvironment = { ...process.env, FRONTEND_DIST_DIR: candidate };
  for (const checker of ["check-pwa.mjs", "check-bundle-budgets.mjs"]) {
    execFileSync(process.execPath, [path.resolve(root, "scripts", checker)], {
      cwd: root,
      env: candidateEnvironment,
      stdio: "inherit"
    });
  }

  const publication = publishFrontendCandidate({
    candidateDirectory: candidate,
    frontendDirectory: frontend
  });
  const recovery = publication.recoveredLegacy ? "; recovered a legacy/interrupted live generation" : "";
  console.log(
    `Frontend generation ${publication.generation.id.slice(0, 12)} published atomically ` +
      `(${publication.generations.length} retained, ${publication.prunedFiles.length} stale files pruned${recovery}).`
  );
} finally {
  rmSync(candidate, { recursive: true, force: true });
}
