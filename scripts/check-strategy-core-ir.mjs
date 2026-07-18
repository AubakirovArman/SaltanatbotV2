/** Guard the canonical Strategy IR definition against silent drift (ADR 0003). */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageDir = join(root, "packages", "strategy-core");

// The hand-maintained packages/strategy-core/index.js + index.d.ts pair is the
// canonical Strategy IR definition (IR_VERSION 4). Changing the IR requires a
// deliberate, reviewed change that edits the pair, re-pins these digests in the
// same commit and records the schema evolution per
// docs/adr/0003-canonical-ir-dataset-backtest-contract.md.
const pinned = {
  "index.js": "5b50720b008979f06e277fa6b6f9de4eb4061b36d5161144fed0e7ff921f25e4",
  "index.d.ts": "f3bde8586501cfed51e4b3e2bacb15c38c75fc1a499fc603dc699e49a58c779b"
};

const failures = [];
for (const [file, expected] of Object.entries(pinned)) {
  const source = readFileSync(join(packageDir, file));
  const actual = createHash("sha256").update(source).digest("hex");
  if (actual !== expected) {
    failures.push(`packages/strategy-core/${file}: sha256 ${actual} does not match pinned ${expected}`);
  }
}
if (!readFileSync(join(packageDir, "index.js"), "utf8").includes("export const IR_VERSION = 4;")) {
  failures.push("packages/strategy-core/index.js: canonical IR_VERSION 4 declaration is missing");
}

if (failures.length > 0) {
  console.error(`Canonical Strategy IR drifted (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(
    "If this IR change is intentional, follow docs/adr/0003-canonical-ir-dataset-backtest-contract.md and re-pin the digests in scripts/check-strategy-core-ir.mjs within the same change."
  );
  process.exitCode = 1;
} else {
  console.log("Canonical Strategy IR definition matches its pinned checksums.");
}
