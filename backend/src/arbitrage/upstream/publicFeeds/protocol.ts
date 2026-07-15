import type WebSocket from "ws";
import type { MexcSpotProtobufFrameDecoder } from "../../../venues/mexc/index.js";
import type { PublicDepthSnapshot } from "../../../venues/publicTypes.js";
import type { ContinuousFeedInstrument, ContinuousFundingObservation, ContinuousPublicBook } from "./types.js";

export type ProtocolResult =
  | { kind: "ignored" }
  | { kind: "accepted" }
  /** Sequence/gap gates advanced, while expensive book materialization was coalesced. */
  | { kind: "book-advanced" }
  | { kind: "bootstrap-required" }
  | { kind: "heartbeat" }
  | { kind: "book"; book: Omit<ContinuousPublicBook, "connectionGeneration"> }
  | { kind: "funding"; funding: Omit<ContinuousFundingObservation, "connectionGeneration"> }
  | { kind: "gap"; reason: string };

export interface ContinuousVenueProtocol {
  readonly instrument: ContinuousFeedInstrument;
  readonly url: string;
  readonly needsBootstrap: boolean;
  /** Defaults to on-open. Deferred protocols request one governed bootstrap after buffering data. */
  readonly bootstrapMode?: "on-open" | "protocol-triggered";
  reset(): void;
  subscribe(socket: WebSocket, now: number): void;
  heartbeat(socket: WebSocket, now: number): void;
  /** Optional lossless decoder for protocols whose integrity proof depends on decimal lexemes. */
  parse?(text: string): unknown;
  /** Optional bounded decoder for venues whose public market-data frames are binary. */
  decodeBinary?(frame: Uint8Array): unknown;
  push(value: unknown, receivedAt: number): ProtocolResult;
  applyBootstrap?(snapshot: PublicDepthSnapshot): ProtocolResult;
}

export interface ProtocolOptions {
  maxLevels?: number;
  publishLevels?: number;
  /** Materialization cadence only; every native sequence is still parsed and reconciled. Zero disables coalescing. */
  publishIntervalMs?: number;
  maxBufferedEvents?: number;
  maxBufferedLevelUpdates?: number;
  /** Gate defaults to the current full-snapshot OBU channel; legacy incremental mode requires REST bridging. */
  gateMode?: "obu" | "incremental-rest-bridge";
  /** Kraken Spot v2 requires truncation to exactly the subscribed depth before CRC32. */
  krakenSpotDepth?: 10 | 25 | 100 | 500 | 1_000;
  /** MEXC Spot may use the bundled explicit decoder or an injected protoc-generated equivalent. */
  mexcSpotDecoder?: MexcSpotProtobufFrameDecoder;
  mexcSpotMaxFrameBytes?: number;
}

export function subscriptionError(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.event === "error") return `subscription error ${String(row.code ?? "unknown")}: ${String(row.msg ?? "unknown")}`;
  if (row.error && typeof row.error === "object") {
    const error = row.error as Record<string, unknown>;
    return `subscription error ${String(error.code ?? "unknown")}: ${String(error.message ?? error.msg ?? "unknown")}`;
  }
  if (row.channel === "subscriptionResponse" && row.data && typeof row.data === "object") {
    const data = row.data as Record<string, unknown>;
    if (data.success === false) return `subscription error: ${String(data.error ?? "rejected")}`;
  }
  return undefined;
}
