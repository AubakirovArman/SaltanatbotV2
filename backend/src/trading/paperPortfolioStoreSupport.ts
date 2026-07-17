import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { PAPER_MONEY_MICROS_MAX } from "./paperPortfolioMigration.js";

export type PaperPortfolioStatus = "active" | "archived";
export type PaperEpochStatus = "active" | "closed";
export type PaperAllocationStatus = "active" | "released" | "closed";

export interface PaperPortfolio {
  ownerUserId: string;
  id: string;
  name: string;
  status: PaperPortfolioStatus;
  currency: "USDT";
  revision: number;
  currentEpoch: number;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

export interface PaperPortfolioEpoch {
  ownerUserId: string;
  portfolioId: string;
  ledgerEpoch: number;
  initialCapitalMicros: number;
  cashBalanceMicros: number;
  formulaVersion: string;
  evidenceState: "verified" | "complete" | "legacy-incomplete";
  status: PaperEpochStatus;
  resetCommandId?: string;
  resetEvidence?: unknown;
  startedAt: number;
  closedAt?: number;
}

export interface PaperBotAllocation {
  ownerUserId: string;
  portfolioId: string;
  ledgerEpoch: number;
  botId: string;
  botRevision: number;
  reservedCapitalMicros: number;
  releasedCapitalMicros?: number;
  status: PaperAllocationStatus;
  releaseEvidence?: unknown;
  createdAt: number;
  releasedAt?: number;
}

export interface PaperValuationMark {
  ownerUserId: string;
  portfolioId: string;
  ledgerEpoch: number;
  botId: string;
  botRevision: number;
  symbol: string;
  priceMicros: number;
  asOf: number;
  source: string;
  expiresAt: number;
  evidence: unknown;
  persistedAt: number;
}

export interface PaperMutationIdentity {
  mutationId: string;
  idempotencyKey: string;
  requestHash: string;
  now: number;
}

export interface PaperMutationReceipt {
  ownerUserId: string;
  id: string;
  idempotencyKey: string;
  requestHash: string;
  action: string;
  targetId?: string;
  expectedPortfolioRevision?: number;
  expectedLedgerEpoch?: number;
  expectedBotRevision?: number;
  status: "applying" | "applied" | "rejected";
  result?: unknown;
  createdAt: number;
  completedAt?: number;
}

export interface VerifiedFlatBotEvidence {
  botId: string;
  botRevision: number;
  positionFlat: true;
  openOrders: 0;
  returnedCapitalMicros: number;
  checkedAt: number;
  source: string;
  verified: true;
}

export class PaperPortfolioStoreError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PaperPortfolioStoreError";
  }
}

export type PortfolioRow = Omit<PaperPortfolio, "isDefault" | "archivedAt"> & { isDefault: number; archivedAt: number | null };
export type EpochRow = Omit<PaperPortfolioEpoch, "resetEvidence" | "resetCommandId" | "closedAt"> & {
  resetEvidence: string | null; resetCommandId: string | null; closedAt: number | null;
};
export type AllocationRow = Omit<PaperBotAllocation, "releaseEvidence" | "releasedCapitalMicros" | "releasedAt"> & {
  releaseEvidence: string | null; releasedCapitalMicros: number | null; releasedAt: number | null;
};
export type MarkRow = Omit<PaperValuationMark, "evidence"> & { evidence: string };
export type ReceiptRow = Omit<PaperMutationReceipt, "targetId" | "result" | "completedAt" | "expectedPortfolioRevision" | "expectedLedgerEpoch" | "expectedBotRevision"> & {
  targetId: string | null; result: string | null; completedAt: number | null;
  expectedPortfolioRevision: number | null; expectedLedgerEpoch: number | null; expectedBotRevision: number | null;
};

export function portfolioFromRow(row: PortfolioRow): PaperPortfolio {
  const { archivedAt, isDefault, ...rest } = row;
  return { ...rest, isDefault: isDefault === 1, ...(archivedAt === null ? {} : { archivedAt }) };
}

export function epochFromRow(row: EpochRow): PaperPortfolioEpoch {
  const { resetEvidence, resetCommandId, closedAt, ...rest } = row;
  return {
    ...rest,
    ...(resetEvidence === null ? {} : { resetEvidence: JSON.parse(resetEvidence) }),
    ...(resetCommandId === null ? {} : { resetCommandId }),
    ...(closedAt === null ? {} : { closedAt })
  };
}

export function allocationFromRow(row: AllocationRow): PaperBotAllocation {
  const { releaseEvidence, releasedCapitalMicros, releasedAt, ...rest } = row;
  return {
    ...rest,
    ...(releaseEvidence === null ? {} : { releaseEvidence: JSON.parse(releaseEvidence) }),
    ...(releasedCapitalMicros === null ? {} : { releasedCapitalMicros }),
    ...(releasedAt === null ? {} : { releasedAt })
  };
}

export function receiptFromRow(row: ReceiptRow): PaperMutationReceipt {
  const {
    targetId, expectedPortfolioRevision, expectedLedgerEpoch, expectedBotRevision,
    result, completedAt, ...rest
  } = row;
  return {
    ...rest,
    ...(targetId === null ? {} : { targetId }),
    ...(expectedPortfolioRevision === null ? {} : { expectedPortfolioRevision }),
    ...(expectedLedgerEpoch === null ? {} : { expectedLedgerEpoch }),
    ...(expectedBotRevision === null ? {} : { expectedBotRevision }),
    ...(result === null ? {} : { result: JSON.parse(result) }),
    ...(completedAt === null ? {} : { completedAt })
  };
}

export function validateMutation(input: PaperMutationIdentity): PaperMutationIdentity {
  const requestHash = input.requestHash.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(requestHash)) fail("INVALID_REQUEST_HASH", "Paper mutation requestHash must be 64 hexadecimal characters");
  return {
    mutationId: identity(input.mutationId, "mutation id", 200),
    idempotencyKey: identity(input.idempotencyKey, "idempotency key", 200),
    requestHash,
    now: timestamp(input.now, "mutation time")
  };
}

export function validateFlatEvidence(input: VerifiedFlatBotEvidence): VerifiedFlatBotEvidence {
  if (input.positionFlat !== true || input.openOrders !== 0 || input.verified !== true) fail("NOT_FLAT", "Verified flat position and zero open orders are required");
  return {
    botId: identity(input.botId, "bot id", 200),
    botRevision: positiveInteger(input.botRevision, "bot revision"),
    positionFlat: true,
    openOrders: 0,
    returnedCapitalMicros: moneyMicros(input.returnedCapitalMicros, "returned capital"),
    checkedAt: timestamp(input.checkedAt, "flat evidence time"),
    source: identity(input.source, "flat evidence source", 120),
    verified: true
  };
}

export function validateMark(input: PaperValuationMark): PaperValuationMark {
  const asOf = timestamp(input.asOf, "mark observation");
  const persistedAt = timestamp(input.persistedAt, "mark persistence");
  const expiresAt = timestamp(input.expiresAt, "mark expiry");
  if (persistedAt < asOf || expiresAt < asOf) fail("INVALID_MARK_TIME", "Paper mark persistence and expiry cannot predate observation");
  return {
    ownerUserId: ownerId(input.ownerUserId),
    portfolioId: identity(input.portfolioId, "portfolio id", 200),
    ledgerEpoch: positiveInteger(input.ledgerEpoch, "ledger epoch"),
    botId: identity(input.botId, "bot id", 200),
    botRevision: positiveInteger(input.botRevision, "bot revision"),
    symbol: identity(input.symbol, "symbol", 80),
    priceMicros: positiveMoneyMicros(input.priceMicros, "mark price"),
    asOf,
    source: identity(input.source, "mark source", 120),
    expiresAt,
    evidence: structuredClone(input.evidence),
    persistedAt
  };
}

let savepointSequence = 0;

export function transaction<T>(database: DatabaseSync, work: () => T): T {
  const owns = !database.isTransaction;
  const savepoint = owns ? undefined : `paper_portfolio_${++savepointSequence}`;
  if (owns) database.exec("BEGIN IMMEDIATE");
  else database.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = work();
    if (owns) database.exec("COMMIT");
    else database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    if (owns && database.isTransaction) database.exec("ROLLBACK");
    else if (database.isTransaction) {
      database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    }
    throw error;
  }
}

export function insertBotEvidence(
  database: DatabaseSync, owner: string, botId: string, revision: number,
  config: string, source: string, createdAt: number, ignoreDuplicate = false
): void {
  const configHash = sha256(config);
  if (ignoreDuplicate) {
    const prior = database.prepare(`
      SELECT config, configHash FROM paper_bot_revision_evidence
      WHERE ownerUserId = ? AND botId = ? AND botRevision = ?
    `).get(owner, botId, revision) as { config: string; configHash: string } | undefined;
    if (prior) {
      if (prior.config !== config || prior.configHash !== configHash) {
        fail("BOT_REVISION_EVIDENCE_CONFLICT", `Paper bot ${botId} revision ${revision} has different immutable evidence`);
      }
      return;
    }
  }
  database.prepare(`
    INSERT INTO paper_bot_revision_evidence
      (ownerUserId, botId, botRevision, config, configHash, source, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(owner, botId, revision, config, configHash, source, createdAt);
}

export function appendPortfolioEvent(
  database: DatabaseSync, owner: string, portfolioId: string, ledgerEpoch: number,
  mutationId: string, ordinal: number, type: string, data: unknown, ts: number,
  botId?: string, botRevision?: number, eventId?: string
): void {
  const sequence = Number((database.prepare(`
    SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM paper_portfolio_events
    WHERE ownerUserId = ? AND portfolioId = ? AND ledgerEpoch = ?
  `).get(owner, portfolioId, ledgerEpoch) as { value: number }).value);
  const id = eventId ? identity(eventId, "event id", 240) : `ppe-${sha256(`${owner}\0${mutationId}\0${ordinal}`)}`;
  database.prepare(`
    INSERT INTO paper_portfolio_events
      (id, ownerUserId, portfolioId, ledgerEpoch, sequence, mutationId, mutationOrdinal,
       type, botId, botRevision, data, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, owner, portfolioId, ledgerEpoch, sequence, mutationId, ordinal, type,
    botId ? identity(botId, "bot id", 200) : null,
    botRevision === undefined ? null : positiveInteger(botRevision, "bot revision"),
    serializeJson(data, "paper portfolio event data"), ts
  );
}

export function ownerId(value: string): string { return identity(value, "owner user id", 160); }

export function identity(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) fail("INVALID_IDENTITY", `${label} must contain from 1 through ${max} characters`);
  return normalized;
}

export function timestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) fail("INVALID_TIMESTAMP", `${label} must be a positive integer`);
  return value;
}

export function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) fail("INVALID_INTEGER", `${label} must be a positive integer`);
  return value;
}

export function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) fail("INVALID_INTEGER", `${label} must be a non-negative integer`);
  return value;
}

export function moneyMicros(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > PAPER_MONEY_MICROS_MAX) fail("INVALID_MONEY", `${label} is outside fixed USDT-micros bounds`);
  return value;
}

export function positiveMoneyMicros(value: number, label: string): number {
  moneyMicros(value, label);
  if (value === 0) fail("INVALID_MONEY", `${label} must be positive`);
  return value;
}

export function checkedMoneySum(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result > PAPER_MONEY_MICROS_MAX) fail("MONEY_OVERFLOW", `${label} exceeds fixed-money bounds`);
  return result;
}

export function parseObject(serialized: string, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { fail("INVALID_JSON", `Invalid ${label}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_JSON", `Invalid ${label}`);
  return value as Record<string, unknown>;
}

export function serializeJson(value: unknown, label: string, maxBytes = 256 * 1024): string {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { fail("INVALID_JSON", `${label} is not JSON-serializable`); }
  if (serialized === undefined) fail("INVALID_JSON", `${label} is not JSON-serializable`);
  if (serialized.length > maxBytes) fail("JSON_TOO_LARGE", `${label} exceeds ${maxBytes} bytes`);
  return serialized;
}

export function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fail(code: string, message: string): never { throw new PaperPortfolioStoreError(code, message); }
