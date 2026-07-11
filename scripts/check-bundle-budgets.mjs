import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "frontend/dist");
const assets = resolve(dist, "assets");
const budgets = JSON.parse(readFileSync(resolve(root, "performance-budgets.json"), "utf8"));
const failures = [];

function measure(path) {
  const content = readFileSync(path);
  return { raw: content.length, gzip: gzipSync(content, { level: 9 }).length };
}

function format(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

if (!existsSync(resolve(dist, "index.html")) || !existsSync(assets)) {
  console.error("Bundle budget check requires frontend/dist. Run npm run build first.");
  process.exit(1);
}

const html = measure(resolve(dist, "index.html"));
if (html.raw > budgets.maxHtmlBytes) {
  failures.push(`index.html raw ${format(html.raw)} exceeds ${format(budgets.maxHtmlBytes)}`);
}

const files = readdirSync(assets)
  .map((name) => ({ name, path: resolve(assets, name) }))
  .filter(({ path }) => statSync(path).isFile())
  .map(({ name, path }) => ({ name, ...measure(path) }));
const javascript = files.filter((file) => extname(file.name) === ".js");
const stylesheets = files.filter((file) => extname(file.name) === ".css");
const totalJsGzip = javascript.reduce((sum, file) => sum + file.gzip, 0);

for (const file of javascript) {
  if (file.raw > budgets.maxSingleJsBytes) {
    failures.push(`${file.name} raw ${format(file.raw)} exceeds ${format(budgets.maxSingleJsBytes)}`);
  }
  if (file.gzip > budgets.maxSingleJsGzipBytes) {
    failures.push(`${file.name} gzip ${format(file.gzip)} exceeds ${format(budgets.maxSingleJsGzipBytes)}`);
  }
}
for (const file of stylesheets) {
  if (file.gzip > budgets.maxCssGzipBytes) {
    failures.push(`${file.name} gzip ${format(file.gzip)} exceeds ${format(budgets.maxCssGzipBytes)}`);
  }
}
if (totalJsGzip > budgets.maxTotalJsGzipBytes) {
  failures.push(`total JavaScript gzip ${format(totalJsGzip)} exceeds ${format(budgets.maxTotalJsGzipBytes)}`);
}

const largest = [...javascript].sort((left, right) => right.gzip - left.gzip)[0];
console.log(`Bundle budgets: HTML ${format(html.raw)}, JS total gzip ${format(totalJsGzip)}.`);
if (largest) console.log(`Largest JS: ${largest.name} (${format(largest.raw)} raw, ${format(largest.gzip)} gzip).`);
for (const file of stylesheets) console.log(`CSS: ${file.name} (${format(file.gzip)} gzip).`);

if (failures.length) {
  console.error(`Bundle budget check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Bundle budget check passed.");
