import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { publishedFrontendFiles } from "./lib/frontend-publication.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configuredDist = process.env.FRONTEND_DIST_DIR;
const dist = configuredDist ? resolve(process.cwd(), configuredDist) : resolve(root, "frontend/dist");
const activeFiles = configuredDist
  ? undefined
  : publishedFrontendFiles({ frontendDirectory: resolve(root, "frontend"), liveDirectory: dist });
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

function uniqueMatches(source, expression) {
  const matches = new Set();
  for (const match of source.matchAll(expression)) matches.add(match[1]);
  return [...matches];
}

function staticJavascriptDependencies(source) {
  return uniqueMatches(source, /(?:from|import)\s*["'`]\.\/([^"'`]+\.js)["'`]/g);
}

function dynamicJavascriptDependencies(source) {
  return uniqueMatches(source, /import\(\s*["'`]\.\/([^"'`]+\.js)["'`]\s*\)/g);
}

function dependencyClosure(rootName, javascriptByName) {
  const closure = new Set();
  const pending = [rootName];
  while (pending.length > 0) {
    const name = pending.pop();
    if (!name || closure.has(name)) continue;
    const file = javascriptByName.get(name);
    if (!file) {
      failures.push(`${name} is referenced by the JavaScript graph but is missing from assets`);
      continue;
    }
    closure.add(name);
    pending.push(...staticJavascriptDependencies(file.source));
  }
  return closure;
}

function graphGzip(graph, javascriptByName) {
  return [...graph].reduce((sum, name) => sum + (javascriptByName.get(name)?.gzip ?? 0), 0);
}

if (!existsSync(resolve(dist, "index.html")) || !existsSync(assets)) {
  console.error("Bundle budget check requires frontend/dist. Run npm run build first.");
  process.exit(1);
}

const html = measure(resolve(dist, "index.html"));
const htmlSource = readFileSync(resolve(dist, "index.html"), "utf8");
if (html.raw > budgets.maxHtmlBytes) {
  failures.push(`index.html raw ${format(html.raw)} exceeds ${format(budgets.maxHtmlBytes)}`);
}

const files = readdirSync(assets)
  .filter((name) => !activeFiles || activeFiles.has(`assets/${name}`))
  .map((name) => ({ name, path: resolve(assets, name) }))
  .filter(({ path }) => statSync(path).isFile())
  .map(({ name, path }) => ({ name, path, ...measure(path) }));
const javascript = files.filter((file) => extname(file.name) === ".js");
const stylesheets = files.filter((file) => extname(file.name) === ".css");
const javascriptByName = new Map(
  javascript.map((file) => [file.name, { ...file, source: readFileSync(file.path, "utf8") }])
);
const totalJsGzip = javascript.reduce((sum, file) => sum + file.gzip, 0);
const totalCssGzip = stylesheets.reduce((sum, file) => sum + file.gzip, 0);

const entryMatch = htmlSource.match(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["'][^"']*\/([^/"']+\.js)["']/i);
const entryName = entryMatch ? basename(entryMatch[1]) : undefined;
const initialGraph = entryName ? dependencyClosure(entryName, javascriptByName) : new Set();
const initialJsGzip = graphGzip(initialGraph, javascriptByName);
if (!entryName) failures.push("index.html does not declare a JavaScript module entry");
if (entryName && initialJsGzip > budgets.maxInitialJsGzipBytes) {
  failures.push(`initial JavaScript graph gzip ${format(initialJsGzip)} exceeds ${format(budgets.maxInitialJsGzipBytes)}`);
}

const lazyRoutes = new Map();
for (const ownerName of initialGraph) {
  const owner = javascriptByName.get(ownerName);
  if (!owner) continue;
  for (const rootName of dynamicJavascriptDependencies(owner.source)) {
    const graph = dependencyClosure(rootName, javascriptByName);
    const incrementalGraph = new Set([...graph].filter((name) => !initialGraph.has(name)));
    lazyRoutes.set(rootName, graphGzip(incrementalGraph, javascriptByName));
  }
}
for (const [rootName, gzip] of lazyRoutes) {
  if (gzip > budgets.maxLazyRouteJsGzipBytes) {
    failures.push(`lazy JavaScript route ${rootName} gzip ${format(gzip)} exceeds ${format(budgets.maxLazyRouteJsGzipBytes)}`);
  }
}

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
const initialStylesheetNames = uniqueMatches(htmlSource, /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["'][^"']*\/([^/"']+\.css)["']/gi);
const initialCssGzip = initialStylesheetNames.reduce(
  (sum, name) => sum + (stylesheets.find((file) => file.name === name)?.gzip ?? 0),
  0
);
if (initialCssGzip > budgets.maxInitialCssGzipBytes) {
  failures.push(`initial CSS gzip ${format(initialCssGzip)} exceeds ${format(budgets.maxInitialCssGzipBytes)}`);
}
if (totalCssGzip > budgets.maxTotalCssGzipBytes) {
  failures.push(`total CSS gzip ${format(totalCssGzip)} exceeds ${format(budgets.maxTotalCssGzipBytes)}`);
}
if (totalJsGzip > budgets.maxTotalJsGzipBytes) {
  failures.push(`total JavaScript gzip ${format(totalJsGzip)} exceeds ${format(budgets.maxTotalJsGzipBytes)}`);
}

const largest = [...javascript].sort((left, right) => right.gzip - left.gzip)[0];
const largestLazyRoute = [...lazyRoutes].sort((left, right) => right[1] - left[1])[0];
console.log(
  `Bundle budgets: HTML ${format(html.raw)}, initial JS ${format(initialJsGzip)}, distributable JS ${format(totalJsGzip)}.`
);
if (largest) console.log(`Largest JS: ${largest.name} (${format(largest.raw)} raw, ${format(largest.gzip)} gzip).`);
if (largestLazyRoute) console.log(`Largest lazy route: ${largestLazyRoute[0]} (${format(largestLazyRoute[1])} incremental gzip).`);
console.log(`CSS: initial ${format(initialCssGzip)}, distributable ${format(totalCssGzip)}.`);
for (const file of stylesheets) console.log(`CSS asset: ${file.name} (${format(file.gzip)} gzip).`);

if (failures.length) {
  console.error(`Bundle budget check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Bundle budget check passed.");
