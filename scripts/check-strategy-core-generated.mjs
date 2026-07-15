/** Verify checked-in strategy-core runtime artifacts match canonical TypeScript. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageDir = join(root, "packages", "strategy-core");
const outputDir = mkdtempSync(join(tmpdir(), "saltanat-strategy-core-"));
const tsc = join(root, "node_modules", ".bin", "tsc");

try {
  execFileSync(tsc, [
    join(packageDir, "ta.ts"),
    join(packageDir, "securityData.ts"),
    join(packageDir, "securityRuntime.ts"),
    join(packageDir, "trace.ts"),
    join(packageDir, "evaluator.ts"),
    "--target", "ES2022",
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--skipLibCheck",
    "--declaration",
    "--outDir", outputDir
  ]);

  const stale = [
    "ta.js",
    "ta.d.ts",
    "securityData.js",
    "securityData.d.ts",
    "securityRuntime.js",
    "securityRuntime.d.ts",
    "trace.js",
    "trace.d.ts",
    "evaluator.js",
    "evaluator.d.ts"
  ].filter(
    (file) => readFileSync(join(packageDir, file), "utf8") !== readFileSync(join(outputDir, file), "utf8")
  );
  if (stale.length > 0) {
    console.error(`Generated strategy-core artifacts are stale: ${stale.join(", ")}. Run npm run build -w @saltanatbotv2/strategy-core.`);
    process.exitCode = 1;
  } else {
    console.log("Strategy-core runtime and declarations are current.");
  }
} finally {
  rmSync(outputDir, { force: true, recursive: true });
}
