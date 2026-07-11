import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(path.join(root, "config/source-file-budgets.json"), "utf8"));
const roots = ["backend/src", "frontend/src", "packages"];
const files = roots.flatMap((directory) => walk(path.join(root, directory)))
  .filter((file) => /\.(?:ts|tsx)$/.test(file) && !file.endsWith(".d.ts"));
const seenExceptions = new Set();
const failures = [];
const largest = [];

for (const file of files) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  const lines = readFileSync(file, "utf8").split(/\r?\n/).length;
  const exception = config.exceptions[relative];
  if (exception) seenExceptions.add(relative);
  const maximum = exception?.maxLines ?? config.defaultMaxLines;
  largest.push({ relative, lines, maximum });
  if (lines > maximum) failures.push(`${relative}: ${lines} lines exceeds ${maximum}${exception ? " (documented exception)" : ""}`);
}
for (const [relative, exception] of Object.entries(config.exceptions)) {
  if (!seenExceptions.has(relative)) failures.push(`${relative}: stale/missing exception (${exception.reason})`);
  if (typeof exception.reason !== "string" || exception.reason.length < 30) failures.push(`${relative}: exception requires a concrete reason`);
}
if (failures.length) {
  console.error(`Source file budget failures:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}
largest.sort((a, b) => b.lines - a.lines);
console.log(`Source file budgets passed for ${files.length} files. Largest: ${largest.slice(0, 8).map((item) => `${item.relative} ${item.lines}/${item.maximum}`).join(", ")}.`);

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "dist", "testdata"].includes(entry.name)) return [];
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}
