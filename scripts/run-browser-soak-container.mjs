import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const image = "mcr.microsoft.com/playwright:v1.61.1-noble";
const quick = process.argv.includes("--quick");
const workdir = process.cwd();
const dependencies = mkdtempSync(join(tmpdir(), "saltanatbotv2-soak-node-"));
const runtimeData = mkdtempSync(join(tmpdir(), "saltanatbotv2-soak-data-"));
const uid = process.getuid?.();
const gid = process.getgid?.();

const args = [
  "run",
  "--rm",
  "--ipc=host",
  ...(uid === undefined || gid === undefined ? [] : ["--user", `${uid}:${gid}`]),
  "--env",
  "CI=1",
  "--env",
  "HOME=/tmp",
  "--env",
  "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
  "--volume",
  `${workdir}:/work`,
  "--volume",
  `${dependencies}:/work/node_modules`,
  // Hide the production checkout's protected SQLite/key directory.
  "--volume",
  `${runtimeData}:/work/backend/data`,
  "--workdir",
  "/work",
  image,
  "bash",
  "-lc",
  `npm ci && npm run ${quick ? "test:soak:quick" : "test:soak"}`
];

try {
  const result = spawnSync("docker", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(dependencies, { recursive: true, force: true });
  rmSync(runtimeData, { recursive: true, force: true });
}
