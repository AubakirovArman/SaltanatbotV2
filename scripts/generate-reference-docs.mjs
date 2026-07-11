import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "backend/src/server.ts");
const tradingPath = path.join(root, "backend/src/trading/routes.ts");
const blocksPath = path.join(root, "frontend/src/strategy/blockCatalog.ts");
const apiDocPath = path.join(root, "docs/API_ENDPOINTS.generated.md");
const blocksDocPath = path.join(root, "docs/BLOCK_CATALOG.generated.md");

const serverSource = readFileSync(serverPath, "utf8");
const tradingSource = readFileSync(tradingPath, "utf8");
const blocksSource = readFileSync(blocksPath, "utf8");

const endpoints = [
  ...extractRoutes(serverSource, "app", "", Number.POSITIVE_INFINITY, "Public"),
  ...extractRoutes(tradingSource, "router", "/api/trade", tradingSource.indexOf("router.use(requireAuth)"), "Public")
].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
const sockets = [
  { path: "/stream", access: "Public", purpose: "Market candle snapshot and updates" },
  { path: "/quotes", access: "Public", purpose: "Multiplexed watchlist quote snapshots and updates" },
  { path: "/trade-stream", access: "One-time authenticated WebSocket ticket", purpose: "Bot, order, fill and runtime updates" }
];
const blocks = extractBlocks(blocksSource);
const categoryCounts = new Map();
for (const block of blocks) categoryCounts.set(block.category, (categoryCounts.get(block.category) ?? 0) + 1);

const apiDoc = `# Generated API endpoint index

> Generated from \`backend/src/server.ts\` and \`backend/src/trading/routes.ts\`. Do not edit by hand. See [API.md](./API.md) for schemas, examples and authentication flow.

This index is a route-presence contract. A change to an Express route makes \`npm run docs:check\` fail until the generated reference is refreshed.

## HTTP endpoints

| Method | Path | Access | Source |
| --- | --- | --- | --- |
${endpoints.map((endpoint) => `| \`${endpoint.method}\` | \`${endpoint.path}\` | ${endpoint.access} | \`${endpoint.source}\` |`).join("\n")}

## WebSocket endpoints

| Path | Access | Purpose |
| --- | --- | --- |
${sockets.map((socket) => `| \`${socket.path}\` | ${socket.access} | ${socket.purpose} |`).join("\n")}

Generated totals: **${endpoints.length} HTTP endpoints** and **${sockets.length} WebSocket endpoints**.
`;

const blocksDoc = `# Generated strategy block catalog

> Generated from \`frontend/src/strategy/blockCatalog.ts\`. Do not edit by hand.

The stable block type is the serialization/compiler identifier and is intentionally not localized. Trader-facing titles and descriptions below are the canonical English source copy.

## Category summary

| Category | Blocks |
| --- | ---: |
${[...categoryCounts].sort(([a], [b]) => a.localeCompare(b)).map(([category, count]) => `| ${escapeCell(category)} | ${count} |`).join("\n")}

## Blocks

| Type | Category | Title | Description | Example |
| --- | --- | --- | --- | --- |
${blocks.map((block) => `| \`${block.type}\` | ${escapeCell(block.category)} | ${escapeCell(block.title)} | ${escapeCell(block.body)} | ${escapeCell(block.example ?? "—")} |`).join("\n")}

Generated total: **${blocks.length} documented block types**.
`;

if (process.argv.includes("--check")) {
  const stale = [[apiDocPath, apiDoc], [blocksDocPath, blocksDoc]].filter(([file, expected]) => safeRead(file) !== expected);
  if (stale.length > 0) {
    console.error(`Generated reference files are stale: ${stale.map(([file]) => path.relative(root, file)).join(", ")}`);
    process.exit(1);
  }
  console.log(`API/block references are current (${endpoints.length} HTTP, ${sockets.length} WebSocket, ${blocks.length} blocks).`);
} else {
  writeFileSync(apiDocPath, apiDoc);
  writeFileSync(blocksDocPath, blocksDoc);
  console.log(`Generated ${endpoints.length} HTTP endpoints, ${sockets.length} WebSocket endpoints and ${blocks.length} blocks.`);
}

function extractRoutes(source, receiver, prefix, publicBoundary, publicAccess) {
  const pattern = new RegExp(`\\b${receiver}\\.(get|post|put|patch|delete)\\(\\s*"([^"]+)"`, "g");
  const routes = [];
  for (const match of source.matchAll(pattern)) {
    const lineEnd = source.indexOf("\n", match.index);
    const signature = source.slice(match.index, lineEnd === -1 ? undefined : lineEnd);
    const role = signature.match(/requireRole\("([^"]+)"\)/)?.[1];
    const fullPath = `${prefix}${match[2]}`;
    const runtimeRole = new Set([
      "POST /api/trade/bots",
      "POST /api/trade/bots/:id/start",
      "POST /api/trade/bots/:id/stop",
      "POST /api/trade/bots/:id/confirm-resume",
      "POST /api/trade/bots/:id/command"
    ]).has(`${match[1].toUpperCase()} ${fullPath}`);
    routes.push({
      method: match[1].toUpperCase(),
      path: fullPath,
      access: match.index < publicBoundary ? publicAccess : role ? `Authenticated · ${role}` : runtimeRole ? "Authenticated · paper/live role by bot" : "Authenticated · read-only+",
      source: prefix ? "backend/src/trading/routes.ts" : "backend/src/server.ts"
    });
  }
  return routes;
}

function extractBlocks(source) {
  const value = `"((?:\\\\.|[^"\\\\])*)"`;
  const pattern = new RegExp(`^\\s{2}([a-zA-Z0-9_]+): \\{ category: ${value}, title: ${value}, body: ${value}(?:, example: ${value})? \\},?$`, "gm");
  return [...source.matchAll(pattern)]
    .map((match) => ({ type: match[1], category: decode(match[2]), title: decode(match[3]), body: decode(match[4]), example: match[5] ? decode(match[5]) : undefined }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.type.localeCompare(b.type));
}

function decode(value) {
  return JSON.parse(`"${value}"`);
}

function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, " ");
}

function safeRead(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}
