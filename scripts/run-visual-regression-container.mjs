import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const image = "mcr.microsoft.com/playwright:v1.61.1-noble";
const update = process.argv.includes("--update");
const workdir = process.cwd();
const dependencies = mkdtempSync(join(tmpdir(), "saltanatbotv2-visual-"));
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
  "--workdir", "/work",
  image,
  "bash", "-lc",
  `npm ci && npm run ${update ? "test:visual:update" : "test:visual"}`
];

try {
  const result = spawnSync("docker", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(dependencies, { recursive: true, force: true });
}
