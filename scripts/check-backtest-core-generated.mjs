/** Verify checked-in backtest-core runtime artifacts match canonical TypeScript. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageDir = join(root, "packages", "backtest-core");
const outputDir = mkdtempSync(join(tmpdir(), "saltanat-backtest-core-"));
const tsc = join(root, "node_modules", ".bin", "tsc");
const sources = ["index", "types", "broker", "portfolio", "warmup", "reporting", "metrics", "provenance"];

try {
  execFileSync(tsc, [
    ...sources.map((source) => join(packageDir, `${source}.ts`)),
    "--target", "ES2022",
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--skipLibCheck",
    "--declaration",
    "--outDir", outputDir
  ]);

  const stale = sources
    .flatMap((source) => [`${source}.js`, `${source}.d.ts`])
    .filter((file) => readFileSync(join(packageDir, file), "utf8") !== readFileSync(join(outputDir, file), "utf8"));
  if (stale.length > 0) {
    console.error(`Generated backtest-core artifacts are stale: ${stale.join(", ")}. Run npm run build -w @saltanatbotv2/backtest-core.`);
    process.exitCode = 1;
  } else {
    console.log("Backtest-core runtime and declarations are current.");
  }
} finally {
  rmSync(outputDir, { force: true, recursive: true });
}
