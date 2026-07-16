import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = fileURLToPath(new URL("../src/", import.meta.url));

const PRIVATE_IO_TRANSPORT_ALLOWLIST = new Set([
  "arbitrage/telemetry/transport.ts",
  "trading/exchange/binanceClient.ts",
  "trading/exchange/bybitClient.ts",
  "trading/exchange/privateOrderStreams.ts"
]);

const PRIVATE_IO_MARKERS: ReadonlyArray<readonly [string, RegExp]> = [
  ["HMAC signing", /\bcreateHmac\b/],
  ["Binance private API-key header", /\bX-MBX-APIKEY\b/],
  ["Bybit private authentication header", /\bX-BAPI-(?:API-KEY|TIMESTAMP|RECV-WINDOW|SIGN)\b/],
  ["Binance private listen-key REST URL", /https:\/\/fapi\.binance\.com\/fapi\/v1\/listenKey\b/],
  ["Binance private WebSocket URL", /wss:\/\/fstream\.binance\.com\/private(?:\/|["'`])/],
  ["Bybit private WebSocket URL", /wss:\/\/stream\.bybit\.com\/v5\/private(?:\/|["'`])/]
];

const PRIVATE_ACCESS_BOUNDARY = /\bassertPrivateExchangeAccess\b/;
const NETWORK_EFFECT_TEXT = /(?:\bfetch|\.fetch(?:er)?|boundedFetchJson|createSocket|new\s+WebSocket)\s*\(/;

describe("signed exchange I/O architecture", () => {
  it("keeps every private signing/network surface in the reviewed fail-closed transports", () => {
    const sources = readSources(SOURCE_ROOT);
    const violations = [...PRIVATE_IO_TRANSPORT_ALLOWLIST]
      .filter((relative) => !sources.has(relative))
      .map((relative) => `${relative}: stale or missing private-I/O allowlist entry`);

    for (const [relative, source] of sources) violations.push(...inspectSource(relative, source));

    expect(violations).toEqual([]);
  });

  it("rejects a new signed transport outside the explicit allowlist", () => {
    const rogue = `
      import { createHmac } from "node:crypto";
      export async function bypass(keys: { apiKey: string; apiSecret: string }) {
        const signature = createHmac("sha256", keys.apiSecret).update("payload").digest("hex");
        return fetch("https://fapi.binance.com/fapi/v1/order", {
          headers: { "X-MBX-APIKEY": keys.apiKey, signature }
        });
      }
    `;

    expect(inspectSource("trading/exchange/rogueSignedClient.ts", rogue)).toEqual([
      "trading/exchange/rogueSignedClient.ts: private exchange I/O is outside the explicit transport allowlist (HMAC signing, Binance private API-key header)"
    ]);
  });

  it("rejects a decorative gate when a transport effect remains outside its continuation", () => {
    const bypass = `
      import { createHmac } from "node:crypto";
      import { type SignedRequestAuthorizer, withSignedRequestAuthorization } from "./signedRequestGate.js";
      export async function request(authorizer: SignedRequestAuthorizer, keys: { apiKey: string; apiSecret: string }) {
        const signature = createHmac("sha256", keys.apiSecret).update("payload").digest("hex");
        const response = await fetch("https://fapi.binance.com/fapi/v1/order", {
          headers: { "X-MBX-APIKEY": keys.apiKey, signature }
        });
        await withSignedRequestAuthorization(authorizer, {
          venue: "binance", market: "futures", method: "GET", path: "/fapi/v1/order", payload: {}
        }, () => undefined);
        return response;
      }
    `;

    expect(inspectSource("trading/exchange/binanceClient.ts", bypass)).toEqual(expect.arrayContaining([
      expect.stringContaining("createHmac is outside withSignedRequestAuthorization"),
      expect.stringContaining("fetch is outside withSignedRequestAuthorization"),
      expect.stringContaining("does not enclose a signing/network effect")
    ]));
  });
});

function inspectSource(relative: string, source: string): string[] {
  const markers = privateIoMarkers(source);
  if (markers.length === 0) return [];
  if (!PRIVATE_IO_TRANSPORT_ALLOWLIST.has(relative)) {
    return [`${relative}: private exchange I/O is outside the explicit transport allowlist (${markers.join(", ")})`];
  }

  const sourceFile = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: string[] = [];
  const importedGateSymbols = signedGateImports(sourceFile);
  for (const required of ["SignedRequestAuthorizer", "withSignedRequestAuthorization"]) {
    if (!importedGateSymbols.has(required)) violations.push(`${relative}: must import ${required} from signedRequestGate.js`);
  }
  if (/\b(?:authorizer|signedRequestAuthorizer)\s*\?\s*:/.test(source)) {
    violations.push(`${relative}: signed request authority must not be optional`);
  }

  const gateCalls: ts.CallExpression[] = [];
  const effects: Array<{ label: string; node: ts.Node }> = [];
  walk(sourceFile, (node) => {
    if (ts.isCallExpression(node) && callName(node.expression) === "withSignedRequestAuthorization") gateCalls.push(node);
    const label = transportEffect(node);
    if (label && !isDependencyFactoryDelegate(node)) effects.push({ label, node });
  });

  if (gateCalls.length === 0) violations.push(`${relative}: private transport has no withSignedRequestAuthorization call`);
  for (const { label, node } of effects) {
    if (!insideSignedGateContinuation(node)) {
      violations.push(`${relative}:${lineOf(sourceFile, node)}: ${label} is outside withSignedRequestAuthorization`);
    }
  }
  for (const gate of gateCalls) {
    const continuation = gate.arguments[2];
    if (!continuation || (!ts.isArrowFunction(continuation) && !ts.isFunctionExpression(continuation))) {
      violations.push(`${relative}:${lineOf(sourceFile, gate)}: signed gate must receive an inline continuation`);
      continue;
    }
    if (!effects.some(({ node }) => continuation.pos <= node.pos && node.end <= continuation.end)) {
      violations.push(`${relative}:${lineOf(sourceFile, gate)}: signed gate continuation does not enclose a signing/network effect`);
    }
  }
  return violations;
}

function privateIoMarkers(source: string): string[] {
  const markers = PRIVATE_IO_MARKERS.filter(([, pattern]) => pattern.test(source)).map(([label]) => label);
  if (PRIVATE_ACCESS_BOUNDARY.test(source) && NETWORK_EFFECT_TEXT.test(source)) markers.push("private-access network code");
  return markers;
}

function signedGateImports(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.endsWith("signedRequestGate.js")) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (!element.propertyName) names.add(element.name.text);
    }
  }
  return names;
}

function transportEffect(node: ts.Node): string | undefined {
  if (ts.isCallExpression(node)) {
    const name = callName(node.expression);
    if (["boundedFetchJson", "createHmac", "createSocket", "fetch", "fetcher"].includes(name)) return name;
  }
  if (ts.isNewExpression(node) && callName(node.expression) === "WebSocket") return "new WebSocket";
  return undefined;
}

function callName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return expression.getText();
}

function insideSignedGateContinuation(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current?.parent) {
    const parent = current.parent;
    if (ts.isCallExpression(parent) && callName(parent.expression) === "withSignedRequestAuthorization" && parent.arguments[2] === current) return true;
    current = parent;
  }
  return false;
}

function isDependencyFactoryDelegate(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current?.parent && !ts.isArrowFunction(current)) current = current.parent;
  if (!current || !ts.isArrowFunction(current)) return false;
  let expression: ts.Node = current;
  while (expression.parent && ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  const parent = expression.parent;
  return ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && parent.right === expression;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function readSources(root: string): Map<string, string> {
  const sources = new Map<string, string>();
  for (const absolute of walkFiles(root)) {
    if (!absolute.endsWith(".ts") || absolute.endsWith(".d.ts")) continue;
    sources.set(path.relative(root, absolute).split(path.sep).join("/"), readFileSync(absolute, "utf8"));
  }
  return sources;
}

function walkFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(absolute) : [absolute];
  });
}
