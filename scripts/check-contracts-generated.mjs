/** Verify checked-in contracts runtime/declarations match canonical TypeScript. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageDir = join(root, "packages", "contracts");
const outputDir = mkdtempSync(join(tmpdir(), "saltanat-contracts-"));
const tsc = join(root, "node_modules", ".bin", "tsc");

try {
  execFileSync(tsc, [join(packageDir, "index.ts"), "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--skipLibCheck", "--declaration", "--outDir", outputDir]);
  const stale = ["index.js", "index.d.ts"].filter(
    (file) => readFileSync(join(packageDir, file), "utf8") !== readFileSync(join(outputDir, file), "utf8"),
  );
  if (stale.length > 0) {
    console.error(`Generated contracts artifacts are stale: ${stale.join(", ")}. Run npm run build -w @saltanatbotv2/contracts.`);
    process.exitCode = 1;
  } else {
    console.log("Contracts runtime and declarations are current.");
  }
} finally {
  rmSync(outputDir, { force: true, recursive: true });
}
