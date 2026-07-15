import type { TriangularOpportunity, TriangularRejection } from "../engines/triangular/index.js";

export interface TriangularDepthVerificationRequest {
  venue: "binance" | "bybit";
  startAsset: string;
  startQuantity: number;
  takerFeeBps: number;
  minimumNetReturnBps: number;
  symbols: readonly [string, string, string];
}

export interface TriangularDepthEvidence {
  symbol: string;
  sequence: number;
  connectionGeneration: number;
  exchangeTs: number;
  receivedAt: number;
  retainedDepth: number;
  source: "websocket-reconstructed";
  sequenceVerified: true;
}

/**
 * Read-only proof for one explicitly selected triangular route. `executable`
 * remains false because data-quality verification is not order permission.
 */
export interface TriangularDepthVerificationResponse {
  schemaVersion: 1;
  readOnly: true;
  researchOnly: true;
  executable: false;
  execution: "none";
  verificationStatus: "sequence-verified-paper-candidate";
  marketDataMode: "sequence-verified-depth";
  venue: "binance" | "bybit";
  startAsset: string;
  requestedStartQuantity: number;
  symbols: readonly [string, string, string];
  evaluatedAt: number;
  books: readonly [TriangularDepthEvidence, TriangularDepthEvidence, TriangularDepthEvidence];
  totalOpportunities: number;
  opportunities: readonly TriangularOpportunity[];
  rejections: readonly TriangularRejection[];
}
