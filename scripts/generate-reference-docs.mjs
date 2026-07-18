import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "backend/src/server.ts");
const tradingPath = path.join(root, "backend/src/trading/routes.ts");
const botLifecycleMutationRoutesPath = path.join(root, "backend/src/trading/botLifecycleMutationRoutes.ts");
const paperPortfolioRoutesPath = path.join(root, "backend/src/trading/paperPortfolioRoutes.ts");
const tradingAccountRoutesPath = path.join(root, "backend/src/trading/tradingAccountRoutes.ts");
const emergencyStopRoutesPath = path.join(root, "backend/src/trading/emergencyStopRoutes.ts");
const notificationRoutesPath = path.join(root, "backend/src/trading/notificationRoutes.ts");
const arbitrageAlertRoutesPath = path.join(root, "backend/src/arbitrage/alertRoutes.ts");
const researchAlertRoutesPath = path.join(root, "backend/src/arbitrage/researchAlerts/routes.ts");
const paperMultiLegRoutesPath = path.join(root, "backend/src/arbitrage/paperMultiLeg/routes.ts");
const publicVenueRoutesPath = path.join(root, "backend/src/venues/publicRoutes.ts");
const orderBookMlResearchRoutesPath = path.join(root, "backend/src/orderbook/ml/researchRoutes.ts");
const identityServerRoutesPath = path.join(root, "backend/src/identity/serverRoutes.ts");
const identityRoutesPath = path.join(root, "backend/src/identity/routes.ts");
const onboardingRoutesPath = path.join(root, "backend/src/onboarding/routes.ts");
const workspaceRoutesPath = path.join(root, "backend/src/workspaces/routes.ts");
const computeJobRoutesPath = path.join(root, "backend/src/jobs/routes.ts");
const alertRoutesPath = path.join(root, "backend/src/alerts/routes.ts");
const alertBindingRoutesPath = path.join(root, "backend/src/alerts/bindingRoutes.ts");
const screenerRoutesPath = path.join(root, "backend/src/screener/routes.ts");
const gaRoutesPath = path.join(root, "backend/src/ga/routes.ts");
const galleryRoutesPath = path.join(root, "backend/src/gallery/routes.ts");
const blocksPath = path.join(root, "frontend/src/strategy/blockCatalog.ts");
const apiDocPath = path.join(root, "docs/API_ENDPOINTS.generated.md");
const blocksDocPath = path.join(root, "docs/BLOCK_CATALOG.generated.md");
const identityServerPublicRoutes = new Set([
  "GET /api/auth/config",
  "GET /api/health",
  "GET /api/ready"
]);

const serverSource = readFileSync(serverPath, "utf8");
const tradingSource = readFileSync(tradingPath, "utf8");
const botLifecycleMutationRoutesSource = readFileSync(botLifecycleMutationRoutesPath, "utf8");
const paperPortfolioRoutesSource = readFileSync(paperPortfolioRoutesPath, "utf8");
const tradingAccountRoutesSource = readFileSync(tradingAccountRoutesPath, "utf8");
const emergencyStopRoutesSource = readFileSync(emergencyStopRoutesPath, "utf8");
const notificationRoutesSource = readFileSync(notificationRoutesPath, "utf8");
const arbitrageAlertRoutesSource = readFileSync(arbitrageAlertRoutesPath, "utf8");
const researchAlertRoutesSource = readFileSync(researchAlertRoutesPath, "utf8");
const paperMultiLegRoutesSource = readFileSync(paperMultiLegRoutesPath, "utf8");
const publicVenueRoutesSource = readFileSync(publicVenueRoutesPath, "utf8");
const orderBookMlResearchRoutesSource = readFileSync(orderBookMlResearchRoutesPath, "utf8");
const identityServerRoutesSource = readFileSync(identityServerRoutesPath, "utf8");
const identityRoutesSource = readFileSync(identityRoutesPath, "utf8");
const onboardingRoutesSource = readFileSync(onboardingRoutesPath, "utf8");
const workspaceRoutesSource = readFileSync(workspaceRoutesPath, "utf8");
const computeJobRoutesSource = readFileSync(computeJobRoutesPath, "utf8");
const alertRoutesSource = readFileSync(alertRoutesPath, "utf8");
const alertBindingRoutesSource = readFileSync(alertBindingRoutesPath, "utf8");
const screenerRoutesSource = readFileSync(screenerRoutesPath, "utf8");
const gaRoutesSource = readFileSync(gaRoutesPath, "utf8");
const galleryRoutesSource = readFileSync(galleryRoutesPath, "utf8");
const blocksSource = readFileSync(blocksPath, "utf8");

const endpoints = uniqueEndpoints([
  ...extractRoutes(serverSource, "app", "", Number.POSITIVE_INFINITY, "Authenticated account"),
  ...extractRoutes(
    identityServerRoutesSource,
    "app",
    "",
    Number.POSITIVE_INFINITY,
    "Public",
    "backend/src/identity/serverRoutes.ts"
  ).map((endpoint) => ({
    ...endpoint,
    access: identityServerAccess(endpoint)
  })),
  ...extractRoutes(identityRoutesSource, "auth", "/api/auth", 0, "Public", "backend/src/identity/routes.ts").map((endpoint) => ({
    ...endpoint,
    access: new Set(["/api/auth/config", "/api/auth/register", "/api/auth/login"]).has(endpoint.path)
      ? "Public"
      : "Authenticated account"
  })),
  ...extractRoutes(identityRoutesSource, "admin", "/api/admin", 0, "Public", "backend/src/identity/routes.ts").map((endpoint) => ({ ...endpoint, access: "Authenticated · admin" })),
  ...extractRoutes(onboardingRoutesSource, "router", "/api/onboarding", 0, "Public", "backend/src/onboarding/routes.ts").map((endpoint) => ({ ...endpoint, access: "Authenticated · owner-scoped" })),
  ...extractRoutes(workspaceRoutesSource, "router", "/api/workspaces", 0, "Public", "backend/src/workspaces/routes.ts").map((endpoint) => ({ ...endpoint, access: "Authenticated · owner-scoped" })),
  ...extractRoutes(computeJobRoutesSource, "router", "/api/jobs", 0, "Public", "backend/src/jobs/routes.ts").map((endpoint) => ({ ...endpoint, access: "Authenticated · owner-scoped" })),
  ...extractRoutes(alertRoutesSource, "router", "/api/alerts", 0, "Public", "backend/src/alerts/routes.ts").map((endpoint) => ({ ...endpoint, access: "Authenticated · owner-scoped · research-only" })),
  ...extractRoutes(alertBindingRoutesSource, "router", "/api/alerts/bindings", 0, "Public", "backend/src/alerts/bindingRoutes.ts").map((endpoint) => ({ ...endpoint, access: "Authenticated · owner-scoped · research-only" })),
  ...extractRoutes(screenerRoutesSource, "router", "/api/screener", 0, "Public", "backend/src/screener/routes.ts").map((endpoint) => ({ ...endpoint, access: "Authenticated · owner-scoped · research-only" })),
  ...extractRoutes(gaRoutesSource, "router", "/api/ga", 0, "Public", "backend/src/ga/routes.ts").map((endpoint) => ({ ...endpoint, access: "Authenticated · owner-scoped · research-only" })),
  ...extractRoutes(galleryRoutesSource, "router", "/api/gallery", 0, "Public", "backend/src/gallery/routes.ts").map((endpoint) => ({ ...endpoint, access: "Authenticated · research-only" })),
  ...extractRoutes(tradingSource, "router", "/api/trade", tradingSource.indexOf("router.use(requireAuth)"), "Public"),
  ...extractRoutes(botLifecycleMutationRoutesSource, "router", "/api/trade", 0, "Public", "backend/src/trading/botLifecycleMutationRoutes.ts").map((endpoint) => ({
    ...endpoint,
    access: "Authenticated · paper/live role by bot"
  })),
  ...extractRoutes(paperPortfolioRoutesSource, "router", "/api/trade", 0, "Public", "backend/src/trading/paperPortfolioRoutes.ts").map((endpoint) => ({
    ...endpoint,
    access: endpoint.method === "GET"
      ? "Authenticated · owner-scoped"
      : "Authenticated · paper-trade · owner-scoped"
  })),
  ...extractRoutes(tradingAccountRoutesSource, "router", "/api/trade", 0, "Public", "backend/src/trading/tradingAccountRoutes.ts").map((endpoint) => ({
    ...endpoint,
    access: endpoint.method === "GET" && (endpoint.path === "/api/trade/accounts" || endpoint.path === "/api/trade/accounts/:id")
      ? "Authenticated · read-only+ · owner-scoped"
      : "Authenticated · live-trade · owner-scoped"
  })),
  ...extractRoutes(emergencyStopRoutesSource, "router", "/api/trade", 0, "Public", "backend/src/trading/emergencyStopRoutes.ts").map((endpoint) => ({ ...endpoint, access: "Authenticated · live-trade" })),
  ...extractRoutes(notificationRoutesSource, "router", "/api/trade", 0, "Public", "backend/src/trading/notificationRoutes.ts").map((endpoint) => ({ ...endpoint, access: "Authenticated · paper-trade · owner-scoped" })),
  ...extractRoutes(arbitrageAlertRoutesSource, "router", "/api/trade", 0, "Public", "backend/src/arbitrage/alertRoutes.ts").map((endpoint) => ({ ...endpoint, access: "Authenticated · admin" })),
  ...extractRoutes(researchAlertRoutesSource, "router", "/api/trade", 0, "Public", "backend/src/arbitrage/researchAlerts/routes.ts").map((endpoint) => ({ ...endpoint, access: "Authenticated · admin" })),
  ...extractRoutes(paperMultiLegRoutesSource, "router", "/api/trade/paper-multi-leg", 0, "Public", "backend/src/arbitrage/paperMultiLeg/routes.ts").map((endpoint) => ({ ...endpoint, access: "Authenticated · admin" })),
  ...extractRoutes(publicVenueRoutesSource, "router", "/api/market-data", Number.POSITIVE_INFINITY, "Authenticated account · public-market read-only", "backend/src/venues/publicRoutes.ts"),
  ...extractRoutes(orderBookMlResearchRoutesSource, "router", "/api/orderbook-ml/research", 0, "Public", "backend/src/orderbook/ml/researchRoutes.ts").map((endpoint) => ({ ...endpoint, access: "Authenticated · admin · research-only" }))
]).sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
const sockets = [
  { path: "/stream", access: "Authenticated account", purpose: "Market candle snapshot and updates" },
  { path: "/quotes", access: "Authenticated account", purpose: "Multiplexed watchlist quote snapshots and updates" },
  { path: "/orderbook", access: "Authenticated account", purpose: "Shared Binance/Bybit order-book snapshots and status" },
  { path: "/trade-flow", access: "Authenticated account", purpose: "Shared Binance/Bybit aggressor-trade batches and status" },
  { path: "/arbitrage-stream", access: "Authenticated account", purpose: "Shared read-only cross-exchange arbitrage snapshots" },
  { path: "/trade-stream", access: "One-time authenticated WebSocket ticket", purpose: "Bot, order, fill and runtime updates" }
];
const blocks = extractBlocks(blocksSource);
const categoryCounts = new Map();
for (const block of blocks) categoryCounts.set(block.category, (categoryCounts.get(block.category) ?? 0) + 1);

const apiDoc = `# Generated API endpoint index

> Generated from the backend server and modular route registrars. Do not edit by hand. See [API.md](./API.md) for schemas, examples and authentication flow.

This index is a route-presence and access-classification contract. A change to an Express route or its canonical registrar metadata makes \`npm run docs:check\` fail until the generated reference is refreshed.

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
${[...categoryCounts]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([category, count]) => `| ${escapeCell(category)} | ${count} |`)
  .join("\n")}

## Blocks

| Type | Category | Title | Description | Example |
| --- | --- | --- | --- | --- |
${blocks.map((block) => `| \`${block.type}\` | ${escapeCell(block.category)} | ${escapeCell(block.title)} | ${escapeCell(block.body)} | ${escapeCell(block.example ?? "—")} |`).join("\n")}

Generated total: **${blocks.length} documented block types**.
`;

if (process.argv.includes("--check")) {
  const stale = [
    [apiDocPath, apiDoc],
    [blocksDocPath, blocksDoc]
  ].filter(([file, expected]) => safeRead(file) !== expected);
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

function extractRoutes(source, receiver, prefix, publicBoundary, publicAccess, sourceOverride) {
  const pattern = new RegExp(`\\b${receiver}\\.(get|post|put|patch|delete)\\(\\s*"([^"]+)"`, "g");
  const routes = [];
  for (const match of source.matchAll(pattern)) {
    const lineEnd = source.indexOf("\n", match.index);
    const signature = source.slice(match.index, lineEnd === -1 ? undefined : lineEnd);
    const role = signature.match(/requireRole\("([^"]+)"\)/)?.[1];
    const fullPath = joinRoute(prefix, match[2]);
    const runtimeRole = new Set(["POST /api/trade/bots", "DELETE /api/trade/bots/:id", "POST /api/trade/bots/:id/start", "POST /api/trade/bots/:id/stop", "POST /api/trade/bots/:id/confirm-resume", "POST /api/trade/bots/:id/reset-state", "POST /api/trade/bots/:id/command"]).has(`${match[1].toUpperCase()} ${fullPath}`);
    routes.push({
      method: match[1].toUpperCase(),
      path: fullPath,
      access: match.index < publicBoundary ? publicAccess : role ? `Authenticated · ${role}` : runtimeRole ? "Authenticated · paper/live role by bot" : "Authenticated · read-only+",
      source: sourceOverride ?? (prefix ? "backend/src/trading/routes.ts" : "backend/src/server.ts")
    });
  }
  return routes;
}

function joinRoute(prefix, route) {
  if (!prefix) return route;
  return route === "/" ? prefix : `${prefix}${route}`;
}

function identityServerAccess(endpoint) {
  const key = `${endpoint.method} ${endpoint.path}`;
  if (identityServerPublicRoutes.has(key)) return "Public";
  if (endpoint.path.startsWith("/api/admin/")) return "Authenticated · admin";
  throw new Error(`Identity server route has no canonical access metadata: ${key}`);
}

function uniqueEndpoints(values) {
  const byRoute = new Map();
  for (const endpoint of values) {
    const key = `${endpoint.method} ${endpoint.path}`;
    const existing = byRoute.get(key);
    if (!existing || existing.source === "backend/src/identity/serverRoutes.ts") byRoute.set(key, endpoint);
  }
  return [...byRoute.values()];
}

function extractBlocks(source) {
  const value = `"((?:\\\\.|[^"\\\\])*)"`;
  const pattern = new RegExp(`^\\s{2}([a-zA-Z0-9_]+): \\{ category: ${value}, title: ${value}, body: ${value}(?:, example: ${value})? \\},?$`, "gm");
  return [...source.matchAll(pattern)].map((match) => ({ type: match[1], category: decode(match[2]), title: decode(match[3]), body: decode(match[4]), example: match[5] ? decode(match[5]) : undefined })).sort((a, b) => a.category.localeCompare(b.category) || a.type.localeCompare(b.type));
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
