import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpusDir = join(root, "pine");
const manifest = JSON.parse(await readFile(join(corpusDir, "provenance.json"), "utf8"));
const allowed = new Set(["Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MIT", "MPL-2.0"]);
const pineFiles = (await readdir(corpusDir)).filter((name) => name.endsWith(".pine")).sort();
const entries = [...manifest.files].sort((left, right) => left.path.localeCompare(right.path));
const failures = [];

if (manifest.schemaVersion !== 1) failures.push("provenance.json schemaVersion must be 1");
if (new Set(entries.map((entry) => entry.path)).size !== entries.length) failures.push("duplicate manifest paths");
if (JSON.stringify(pineFiles) !== JSON.stringify(entries.map((entry) => entry.path))) {
  failures.push("manifest paths must exactly match every sorted pine/*.pine file");
}

for (const entry of entries) {
  const source = await readFile(join(corpusDir, entry.path), "utf8");
  const digest = createHash("sha256").update(source).digest("hex");
  if (digest !== entry.sha256) failures.push(`${entry.path}: sha256 is stale`);
  if (!/^https:\/\//.test(entry.source)) failures.push(`${entry.path}: source must be HTTPS`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.acquired)) failures.push(`${entry.path}: acquired must be YYYY-MM-DD`);
  if (entry.corpusEligible) {
    if (!allowed.has(entry.license)) failures.push(`${entry.path}: eligible license ${entry.license} is not allow-listed`);
    if (!source.slice(0, 500).includes(entry.license === "MPL-2.0" ? "Mozilla Public License 2.0" : entry.license)) {
      failures.push(`${entry.path}: eligible source does not preserve its license header`);
    }
  } else if (entry.license !== "LicenseRef-Unknown" || !entry.reason) {
    failures.push(`${entry.path}: ineligible samples require LicenseRef-Unknown and a reason`);
  }
}

if (failures.length) {
  console.error(`Pine provenance check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`Pine provenance verified: ${entries.length} files, ${entries.filter((entry) => entry.corpusEligible).length} corpus-eligible.`);
