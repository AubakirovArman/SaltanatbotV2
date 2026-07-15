import { parseTriangularDepthVerification, type TriangularDepthVerificationRequest, type TriangularDepthVerificationResponse } from "@saltanatbotv2/arbitrage-sdk";

export interface TriangularLeg {
  index: 0 | 1 | 2;
  symbol: string;
  side: "buy" | "sell";
  fromAsset: string;
  toAsset: string;
  inputQuantity: number;
  outputQuantity: number;
  averagePrice: number;
  feeBps: number;
  levelsUsed: number;
}

export interface TriangularOpportunity {
  id: string;
  edgeKind: "non-executable-candidate";
  executionStatus: "non-executable-candidate";
  marketDataMode: "rest-top-book";
  sequenceVerified: false;
  venue: "binance" | "bybit";
  startAsset: string;
  startQuantity: number;
  endQuantity: number;
  grossReturnBps: number;
  netReturnBps: number;
  limitingCapacity: { requestedStartQuantity: number; executableStartQuantity: number; utilizationPct: number };
  legs: [TriangularLeg, TriangularLeg, TriangularLeg];
  timestamps: { evaluatedAt: number; quoteAgeMs: number; legSkewMs: number; exchangeTimestampsVerified: boolean };
  riskFlags: string[];
}

export interface TriangularScanResponse {
  updatedAt: number;
  venue: "binance" | "bybit";
  startAsset: string;
  requestedStartQuantity: number;
  scannedMarkets: number;
  scannedCycles: number;
  totalOpportunities: number;
  truncated: boolean;
  marketDataMode: "rest-top-book";
  snapshotSource: "rest-snapshot";
  executionStatus: "non-executable-candidate";
  sequenceVerified: false;
  opportunities: TriangularOpportunity[];
}

export async function fetchTriangularScan(options: { venue: "binance" | "bybit"; startAsset: string; startQuantity: number; takerFeeBps: number; minimumNetReturnBps: number }, signal?: AbortSignal): Promise<TriangularScanResponse> {
  const query = new URLSearchParams({
    venue: options.venue,
    startAsset: options.startAsset,
    startQuantity: String(options.startQuantity),
    takerFeeBps: String(options.takerFeeBps),
    minimumNetReturnBps: String(options.minimumNetReturnBps),
    limit: "100"
  });
  const response = await fetch(`/api/arbitrage/triangular?${query}`, { signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Triangular scanner API ${response.status}`);
  }
  return parseTriangularScan(await response.json());
}

export async function fetchTriangularDepthVerification(request: TriangularDepthVerificationRequest, signal?: AbortSignal): Promise<TriangularDepthVerificationResponse> {
  const response = await fetch("/api/arbitrage/triangular/verify-depth", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(typeof body.error === "string" ? body.error : `Triangular depth verification API ${response.status}`);
  }
  return parseTriangularDepthVerification(await response.json());
}

export type { TriangularDepthVerificationRequest, TriangularDepthVerificationResponse };

export function parseTriangularScan(value: unknown): TriangularScanResponse {
  const input = record(value, "triangular scan");
  const venue = venueId(input.venue, "venue");
  const opportunities = array(input.opportunities, "opportunities", 250).map((raw, index) => opportunity(raw, index));
  const mode = text(input.marketDataMode, "marketDataMode");
  if (mode !== "rest-top-book") throw new Error("marketDataMode is unsupported");
  if (input.snapshotSource !== "rest-snapshot") throw new Error("snapshotSource is unsupported");
  if (input.executionStatus !== "non-executable-candidate") throw new Error("executionStatus is unsupported");
  if (input.sequenceVerified !== false) throw new Error("REST top-book scan cannot be sequence verified");
  return {
    updatedAt: finite(input.updatedAt, "updatedAt"),
    venue,
    startAsset: text(input.startAsset, "startAsset"),
    requestedStartQuantity: finite(input.requestedStartQuantity, "requestedStartQuantity"),
    scannedMarkets: finite(input.scannedMarkets, "scannedMarkets"),
    scannedCycles: finite(input.scannedCycles, "scannedCycles"),
    totalOpportunities: finite(input.totalOpportunities, "totalOpportunities"),
    truncated: bool(input.truncated, "truncated"),
    marketDataMode: mode,
    snapshotSource: "rest-snapshot",
    executionStatus: "non-executable-candidate",
    sequenceVerified: false,
    opportunities
  };
}

function opportunity(value: unknown, index: number): TriangularOpportunity {
  const row = record(value, `opportunities[${index}]`);
  const rawLegs = array(row.legs, `opportunities[${index}].legs`, 3);
  if (rawLegs.length !== 3) throw new Error(`opportunities[${index}].legs must contain three legs`);
  if (row.edgeKind !== "non-executable-candidate" || row.executionStatus !== "non-executable-candidate" || row.marketDataMode !== "rest-top-book" || row.sequenceVerified !== false) {
    throw new Error(`opportunities[${index}] must be an unsequenced REST top-book candidate`);
  }
  const riskFlags = array(row.riskFlags, "riskFlags", 20).map((flag) => text(flag, "riskFlag"));
  for (const required of ["top-book-only", "rest-snapshot", "unsequenced", "non-executable-candidate"]) {
    if (!riskFlags.includes(required)) throw new Error(`opportunities[${index}] is missing ${required} provenance`);
  }
  return {
    id: text(row.id, "id"),
    edgeKind: "non-executable-candidate",
    executionStatus: "non-executable-candidate",
    marketDataMode: "rest-top-book",
    sequenceVerified: false,
    venue: venueId(row.venue, "venue"),
    startAsset: text(row.startAsset, "startAsset"),
    startQuantity: finite(row.startQuantity, "startQuantity"),
    endQuantity: finite(row.endQuantity, "endQuantity"),
    grossReturnBps: finite(row.grossReturnBps, "grossReturnBps"),
    netReturnBps: finite(row.netReturnBps, "netReturnBps"),
    limitingCapacity: capacity(row.limitingCapacity),
    legs: rawLegs.map((leg, legIndex) => parseLeg(leg, legIndex)) as [TriangularLeg, TriangularLeg, TriangularLeg],
    timestamps: timestamps(row.timestamps),
    riskFlags
  };
}

function parseLeg(value: unknown, index: number): TriangularLeg {
  const row = record(value, `leg[${index}]`);
  const side = text(row.side, "side");
  if (side !== "buy" && side !== "sell") throw new Error("leg.side is unsupported");
  const wireIndex = finite(row.index, `leg[${index}].index`);
  if (!Number.isInteger(wireIndex) || wireIndex < 0 || wireIndex > 2) throw new Error(`leg[${index}].index is unsupported`);
  if (wireIndex !== index) throw new Error(`leg[${index}].index must preserve the ordered 0,1,2 route`);
  return {
    index: wireIndex as 0 | 1 | 2,
    symbol: text(row.symbol, "symbol"),
    side,
    fromAsset: text(row.fromAsset, "fromAsset"),
    toAsset: text(row.toAsset, "toAsset"),
    inputQuantity: finite(row.inputQuantity, "inputQuantity"),
    outputQuantity: finite(row.outputQuantity, "outputQuantity"),
    averagePrice: finite(row.averagePrice, "averagePrice"),
    feeBps: finite(row.feeBps, "feeBps"),
    levelsUsed: finite(row.levelsUsed, "levelsUsed")
  };
}

function capacity(value: unknown) {
  const row = record(value, "limitingCapacity");
  return {
    requestedStartQuantity: finite(row.requestedStartQuantity, "requestedStartQuantity"),
    executableStartQuantity: finite(row.executableStartQuantity, "executableStartQuantity"),
    utilizationPct: finite(row.utilizationPct, "utilizationPct")
  };
}

function timestamps(value: unknown) {
  const row = record(value, "timestamps");
  return { evaluatedAt: finite(row.evaluatedAt, "evaluatedAt"), quoteAgeMs: finite(row.quoteAgeMs, "quoteAgeMs"), legSkewMs: finite(row.legSkewMs, "legSkewMs"), exchangeTimestampsVerified: bool(row.exchangeTimestampsVerified, "exchangeTimestampsVerified") };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function array(value: unknown, label: string, limit: number) {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${label} must be an array with at most ${limit} rows`);
  return value;
}
function text(value: unknown, label: string) {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}
function finite(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}
function bool(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}
function venueId(value: unknown, label: string) {
  if (value !== "binance" && value !== "bybit") throw new Error(`${label} is unsupported`);
  return value;
}
