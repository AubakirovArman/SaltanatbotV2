import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "frontend/dist");
const fail = (message) => {
  console.error(`PWA verification failed: ${message}`);
  process.exit(1);
};

for (const name of ["index.html", "manifest.webmanifest", "service-worker.js", "logo.png"]) {
  if (!existsSync(resolve(dist, name))) fail(`missing frontend/dist/${name}`);
}

const index = readFileSync(resolve(dist, "index.html"), "utf8");
if (!/<link[^>]+rel="manifest"[^>]+href="\/manifest\.webmanifest"/.test(index)) fail("index.html does not link the root manifest");

const manifest = JSON.parse(readFileSync(resolve(dist, "manifest.webmanifest"), "utf8"));
if (!manifest.name || !manifest.short_name || manifest.id !== "/" || manifest.start_url !== "/" || manifest.scope !== "/") fail("manifest identity/start scope is incomplete");
if (manifest.display !== "standalone" || manifest.prefer_related_applications !== false) fail("manifest standalone install policy is incomplete");
const expectedFileHandlers = new Map([
  [".pine", "text/plain"],
  [".strategy", "application/vnd.saltanatbotv2.strategy+json"],
  [".saltanat-plugin", "application/vnd.saltanatbotv2.plugin+json"]
]);
const fileHandlers = manifest.file_handlers ?? [];
if (fileHandlers.length !== expectedFileHandlers.size) fail("manifest file handler set is incomplete or over-broad");
for (const handler of fileHandlers) {
  if (handler.action !== "/?view=strategy" || handler.launch_type !== "single-client") fail("file handlers must launch the bounded Strategy review flow");
  const acceptEntries = Object.entries(handler.accept ?? {});
  if (acceptEntries.length !== 1) fail("each file handler must declare one narrow MIME/extension contract");
  const [mime, extensions] = acceptEntries[0] ?? [];
  if (!Array.isArray(extensions) || extensions.length !== 1 || expectedFileHandlers.get(extensions[0]) !== mime) fail("file handler MIME/extension contract is unsafe");
}
const serializedFileHandlers = JSON.stringify(fileHandlers);
if (/trade|order/i.test(serializedFileHandlers) || serializedFileHandlers.includes('"application/json"') || serializedFileHandlers.includes('".json"')) fail("file handlers must not expose generic JSON or trading actions");
const pngIcons = (manifest.icons ?? []).filter((icon) => icon.type === "image/png" && icon.purpose?.split(" ").includes("any"));
const iconSizes = pngIcons.map((icon) => pngSize(resolve(dist, icon.src.replace(/^\//, ""))));
if (!iconSizes.some(({ width, height }) => width >= 192 && height >= 192)) fail("manifest needs a PNG icon at least 192x192");
if (!iconSizes.some(({ width, height }) => width >= 512 && height >= 512)) fail("manifest needs a PNG icon at least 512x512");

const worker = readFileSync(resolve(dist, "service-worker.js"), "utf8");
const match = worker.match(/const PRECACHE = (\[[^\n]+\]);/);
if (!match) fail("generated worker does not expose a parseable PRECACHE list");
const precache = JSON.parse(match[1]);
const researchMatch = worker.match(/const RESEARCH_FILES = (\[[^\n]+\]);/);
if (!researchMatch) fail("generated worker does not expose a parseable optional research list");
const research = JSON.parse(researchMatch[1]);
if (!precache.includes("/")) fail("root navigation shell is not precached");
if (precache.includes("/manifest.webmanifest") || precache.includes("/service-worker.js")) fail("update-sensitive manifest/worker must remain network-managed");
const runtimePrefixes = ["/api/", "/stream", "/quotes", "/orderbook", "/trade-flow", "/trade-stream"];
if (precache.some((url) => runtimePrefixes.some((prefix) => url.startsWith(prefix)))) fail("runtime API or stream leaked into precache");
if (!worker.includes('request.method !== "GET"') || runtimePrefixes.some((prefix) => !worker.includes(JSON.stringify(prefix)))) fail("network-only request guards are missing");
if (worker.includes("skipWaiting") || /\b(?:sync|periodicsync)\b/i.test(worker)) fail("worker must not skip waiting or queue background sync");
if (worker.includes('cache.put("/"') || worker.includes("response.clone()")) fail("navigation responses must not be buffered into the active shell cache");

for (const url of precache) {
  if (url === "/") continue;
  const path = resolve(dist, decodeURIComponent(url.slice(1)));
  if (!path.startsWith(`${dist}/`) || !existsSync(path) || !statSync(path).isFile()) fail(`precache target is missing: ${url}`);
}
const generatedAssets = walk(resolve(dist, "assets")).filter((path) => [".js", ".css"].includes(extname(path)));
const indexShellUrls = [...index.matchAll(/(?:src|href)="(\/(?:assets\/[^"?]+|theme-init\.js|logo\.(?:svg|png)))"/g)].map((match) => match[1]);
for (const url of indexShellUrls) if (!precache.includes(url)) fail(`initial index resource is not precached: ${url}`);
for (const url of precache.filter((url) => url.endsWith(".js"))) {
  const source = readFileSync(resolve(dist, url.slice(1)), "utf8");
  for (const match of source.matchAll(/(?:from|import)\s*["'](\.[^"']+)["']/g)) {
    const dependency = new URL(match[1], `https://shell.invalid${url}`).pathname;
    if (!precache.includes(dependency)) fail(`static shell dependency is not precached: ${dependency}`);
  }
}
if (precache.some((url) => url.includes("blockly-runtime") || url.includes("StrategyLab"))) fail("optional Strategy Studio must not block initial shell installation");
if (!research.some((url) => url.includes("StrategyLab")) || !research.some((url) => url.includes("blockly-runtime"))) fail("optional research cache does not contain Strategy Studio and Blockly");
if (research.some((url) => precache.includes(url))) fail("optional research cache overlaps the required shell cache");
if (!research.some((url) => url.startsWith("/blockly-media/"))) fail("optional research cache does not contain Blockly media");
if (research.some((url) => url.includes("TradingView")) || research.some((url) => runtimePrefixes.some((prefix) => url.startsWith(prefix)))) fail("trading UI or runtime data leaked into optional research cache");
if (!worker.includes("saltanat:offline-research:install") || !worker.includes("saltanat:offline-research:remove")) fail("optional research cache commands are missing");
for (const url of research) {
  const path = resolve(dist, decodeURIComponent(url.slice(1)));
  if (!path.startsWith(`${dist}/`) || !existsSync(path) || !statSync(path).isFile()) fail(`research cache target is missing: ${url}`);
}
const bundles = generatedAssets.filter((path) => extname(path) === ".js").map((path) => readFileSync(path, "utf8")).join("\n");
if (!bundles.includes("/service-worker.js") || !bundles.includes("updateViaCache")) fail("production bundle does not register the generated worker safely");

console.log(`PWA shell verified: ${precache.length} same-origin files, ${iconSizes.map(({ width, height }) => `${width}x${height}`).join(", ")} icon.`);

function pngSize(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG") fail(`invalid PNG icon: ${path}`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
}
