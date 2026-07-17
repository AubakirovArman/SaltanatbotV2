import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const image = "mcr.microsoft.com/playwright:v1.61.1-noble";
const update = process.argv.includes("--update");
const e2e = process.argv.includes("--e2e");
const workdir = process.cwd();
const dependencies = mkdtempSync(join(tmpdir(), "saltanatbotv2-visual-"));
const runtimeData = mkdtempSync(join(tmpdir(), "saltanatbotv2-browser-data-"));
const uid = process.getuid?.();
const gid = process.getgid?.();

const args = [
  "run", "--rm", "--ipc=host",
  ...(uid === undefined || gid === undefined ? [] : ["--user", `${uid}:${gid}`]),
  "--env", "CI=1",
  "--env", "HOME=/tmp",
  "--env", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
  "--volume", `${workdir}:/work`,
  "--volume", `${dependencies}:/work/node_modules`,
  // Keep a protected production generation read-only on the host. The test
  // build gets a private writable output tree for the lifetime of the
  // container instead of mutating backend/dist in the checkout.
  "--tmpfs", "/work/backend/dist:rw,exec,nosuid,nodev,mode=1777,size=512m",
  // Hide a production checkout's SQLite/key directory from the test backend.
  "--volume", `${runtimeData}:/work/backend/data`,
  "--workdir", "/work",
  image,
  "bash", "-lc",
  `npm ci && npm run ${e2e ? "test:e2e" : update ? "test:visual:update" : "test:visual"}`
];

try {
  const result = spawnSync("docker", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(dependencies, { recursive: true, force: true });
  rmSync(runtimeData, { recursive: true, force: true });
}
