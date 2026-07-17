import type { DatabaseSync } from "node:sqlite";
import {
  appendPortfolioEvent,
  epochFromRow,
  fail,
  identity,
  insertBotEvidence,
  nonNegativeInteger,
  ownerId,
  parseObject,
  positiveInteger,
  receiptFromRow,
  serializeJson,
  sha256,
  stableStringify,
  timestamp,
  transaction,
  validateMark,
  type EpochRow,
  type MarkRow,
  type PaperMutationReceipt,
  type PaperPortfolioEpoch,
  type PaperValuationMark,
  type ReceiptRow
} from "./paperPortfolioStoreSupport.js";

export type { PaperValuationMark } from "./paperPortfolioStoreSupport.js";

export function upsertPaperValuationMarkIn(database: DatabaseSync, mark: PaperValuationMark): PaperValuationMark {
  const value = validateMark(mark);
  requireEpoch(database, value.ownerUserId, value.portfolioId, value.ledgerEpoch);
  const allocation = database.prepare(`
    SELECT 1 FROM paper_bot_allocations
    WHERE ownerUserId = ? AND portfolioId = ? AND ledgerEpoch = ?
      AND botId = ? AND botRevision = ? AND status = 'active'
  `).get(
    value.ownerUserId,
    value.portfolioId,
    value.ledgerEpoch,
    value.botId,
    value.botRevision
  );
  if (!allocation) fail("ACTIVE_ALLOCATION_REQUIRED", "Paper valuation marks require an exact active bot allocation");
  const prior = readPaperValuationMarkFrom(database, value.ownerUserId, value.portfolioId, value.ledgerEpoch, value.botId, value.botRevision, value.symbol);
  if (prior && value.asOf < prior.asOf) return prior;
  if (prior && value.asOf === prior.asOf) {
    if (!sameMarkObservation(prior, value)) fail("MARK_CONFLICT", "A different valuation mark already exists at this observation time");
    return prior;
  }
  database.prepare(`
    INSERT INTO paper_valuation_marks
      (ownerUserId, portfolioId, ledgerEpoch, botId, botRevision, symbol, priceMicros,
       asOf, source, expiresAt, evidence, persistedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ownerUserId, portfolioId, ledgerEpoch, botId, botRevision, symbol) DO UPDATE SET
      priceMicros = excluded.priceMicros, asOf = excluded.asOf, source = excluded.source,
      expiresAt = excluded.expiresAt, evidence = excluded.evidence, persistedAt = excluded.persistedAt
    WHERE excluded.asOf > paper_valuation_marks.asOf
  `).run(
    value.ownerUserId, value.portfolioId, value.ledgerEpoch, value.botId, value.botRevision,
    value.symbol, value.priceMicros, value.asOf, value.source, value.expiresAt,
    serializeJson(value.evidence, "paper valuation mark evidence"), value.persistedAt
  );
  const stored = readPaperValuationMarkFrom(database, value.ownerUserId, value.portfolioId, value.ledgerEpoch, value.botId, value.botRevision, value.symbol)!;
  if (stored.asOf === value.asOf && !sameMarkObservation(stored, value)) {
    fail("MARK_CONFLICT", "A different valuation mark already exists at this observation time");
  }
  return stored;
}

function sameMarkObservation(left: PaperValuationMark, right: PaperValuationMark): boolean {
  const { persistedAt: _leftPersistedAt, ...leftObservation } = left;
  const { persistedAt: _rightPersistedAt, ...rightObservation } = right;
  return stableStringify(leftObservation) === stableStringify(rightObservation);
}

export function readPaperValuationMarkFrom(
  database: DatabaseSync,
  ownerUserId: string,
  portfolioId: string,
  ledgerEpoch: number,
  botId: string,
  botRevision: number,
  symbol: string
): PaperValuationMark | undefined {
  const row = database.prepare(`
    SELECT * FROM paper_valuation_marks
    WHERE ownerUserId = ? AND portfolioId = ? AND ledgerEpoch = ?
      AND botId = ? AND botRevision = ? AND symbol = ?
  `).get(
    ownerId(ownerUserId), identity(portfolioId, "portfolio id", 200), positiveInteger(ledgerEpoch, "ledger epoch"),
    identity(botId, "bot id", 200), positiveInteger(botRevision, "bot revision"), identity(symbol, "symbol", 80)
  ) as unknown as MarkRow | undefined;
  return row ? { ...row, evidence: JSON.parse(row.evidence) } : undefined;
}

export interface PaperPortfolioEventInput {
  id?: string;
  type: string;
  data: unknown;
  botId?: string;
  botRevision?: number;
  ts: number;
}

export function appendPaperPortfolioEventsIn(
  database: DatabaseSync,
  ownerUserId: string,
  portfolioId: string,
  ledgerEpoch: number,
  mutationId: string,
  events: readonly PaperPortfolioEventInput[]
): number {
  if (events.length === 0) return 0;
  const owner = ownerId(ownerUserId);
  const portfolio = identity(portfolioId, "portfolio id", 200);
  const epoch = positiveInteger(ledgerEpoch, "ledger epoch");
  const mutation = identity(mutationId, "mutation id", 200);
  return transaction(database, () => {
    requireEpoch(database, owner, portfolio, epoch);
    let inserted = 0;
    events.forEach((event, index) => {
      const ordinal = index + 1;
      const type = identity(event.type, "event type", 120);
      const ts = timestamp(event.ts, "event time");
      const botId = event.botId === undefined ? undefined : identity(event.botId, "bot id", 200);
      const botRevision = event.botRevision === undefined ? undefined : positiveInteger(event.botRevision, "bot revision");
      const data = serializeJson(event.data, "paper portfolio event data");
      const id = event.id === undefined
        ? `ppe-${sha256(`${owner}\0${mutation}\0${ordinal}`)}`
        : identity(event.id, "event id", 240);
      const prior = database.prepare(`
        SELECT id, portfolioId, ledgerEpoch, type, botId, botRevision, data, ts
        FROM paper_portfolio_events WHERE ownerUserId = ? AND mutationId = ? AND mutationOrdinal = ?
      `).get(owner, mutation, ordinal) as {
        id: string; portfolioId: string; ledgerEpoch: number; type: string;
        botId: string | null; botRevision: number | null; data: string; ts: number;
      } | undefined;
      if (prior) {
        if (
          prior.id !== id || prior.portfolioId !== portfolio || prior.ledgerEpoch !== epoch
          || prior.type !== type || (prior.botId ?? undefined) !== botId
          || (prior.botRevision ?? undefined) !== botRevision || prior.ts !== ts
          || stableStringify(JSON.parse(prior.data)) !== stableStringify(JSON.parse(data))
        ) fail("EVENT_CONFLICT", "Paper portfolio mutation ordinal already contains different evidence");
        return;
      }
      appendPortfolioEvent(database, owner, portfolio, epoch, mutation, ordinal, type, event.data, ts, botId, botRevision, id);
      inserted += 1;
    });
    return inserted;
  });
}

export function listPaperPortfolioEventsFrom(
  database: DatabaseSync,
  ownerUserId: string,
  portfolioId: string,
  ledgerEpoch?: number
): Array<Record<string, unknown>> {
  const owner = ownerId(ownerUserId);
  const portfolio = identity(portfolioId, "portfolio id", 200);
  const rows = ledgerEpoch === undefined
    ? database.prepare(`SELECT * FROM paper_portfolio_events WHERE ownerUserId = ? AND portfolioId = ? ORDER BY ledgerEpoch, sequence`).all(owner, portfolio)
    : database.prepare(`SELECT * FROM paper_portfolio_events WHERE ownerUserId = ? AND portfolioId = ? AND ledgerEpoch = ? ORDER BY sequence`).all(owner, portfolio, positiveInteger(ledgerEpoch, "ledger epoch"));
  return rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return { ...row, data: JSON.parse(String(row.data)) };
  });
}

export function upsertPaperProjectionMetadataIn(
  database: DatabaseSync,
  ownerUserId: string,
  input: {
    portfolioId: string; ledgerEpoch: number; lastSequence: number; formulaVersion: string;
    evidenceState: string; projection: unknown; expectedRevision?: number; projectedAt: number;
  }
): number {
  const owner = ownerId(ownerUserId);
  const portfolio = identity(input.portfolioId, "portfolio id", 200);
  const epoch = positiveInteger(input.ledgerEpoch, "ledger epoch");
  const lastSequence = nonNegativeInteger(input.lastSequence, "last sequence");
  const formula = identity(input.formulaVersion, "formula version", 80);
  const evidence = identity(input.evidenceState, "evidence state", 80);
  const projectedAt = timestamp(input.projectedAt, "projection time");
  const projection = serializeJson(input.projection, "paper portfolio projection");
  return transaction(database, () => {
    requireEpoch(database, owner, portfolio, epoch);
    const prior = database.prepare(`
      SELECT revision, lastSequence FROM paper_portfolio_projections
      WHERE ownerUserId = ? AND portfolioId = ? AND ledgerEpoch = ?
    `).get(owner, portfolio, epoch) as { revision: number; lastSequence: number } | undefined;
    if (input.expectedRevision !== undefined && (prior?.revision ?? 0) !== input.expectedRevision) fail("PROJECTION_REVISION_CONFLICT", "Paper projection revision changed");
    if (prior && lastSequence < prior.lastSequence) fail("PROJECTION_REWIND", "Paper projection cannot move backwards");
    if (!prior) {
      database.prepare(`
        INSERT INTO paper_portfolio_projections
          (ownerUserId, portfolioId, ledgerEpoch, lastSequence, formulaVersion, evidenceState, projection, revision, projectedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(owner, portfolio, epoch, lastSequence, formula, evidence, projection, projectedAt);
      return 1;
    }
    const revision = prior.revision + 1;
    const changed = database.prepare(`
      UPDATE paper_portfolio_projections SET lastSequence = ?, formulaVersion = ?, evidenceState = ?,
        projection = ?, revision = ?, projectedAt = ?
      WHERE ownerUserId = ? AND portfolioId = ? AND ledgerEpoch = ? AND revision = ?
    `).run(
      lastSequence, formula, evidence, projection, revision, projectedAt,
      owner, portfolio, epoch, prior.revision
    ).changes;
    if (changed !== 1) fail("PROJECTION_REVISION_CONFLICT", "Paper projection revision changed");
    return revision;
  });
}

export function getPaperProjectionMetadataFrom(
  database: DatabaseSync,
  ownerUserId: string,
  portfolioId: string,
  ledgerEpoch: number
): Record<string, unknown> | undefined {
  const row = database.prepare(`
    SELECT * FROM paper_portfolio_projections
    WHERE ownerUserId = ? AND portfolioId = ? AND ledgerEpoch = ?
  `).get(ownerId(ownerUserId), identity(portfolioId, "portfolio id", 200), positiveInteger(ledgerEpoch, "ledger epoch")) as Record<string, unknown> | undefined;
  return row ? { ...row, projection: JSON.parse(String(row.projection)) } : undefined;
}

export function recordPaperBotRevisionEvidenceIn(
  database: DatabaseSync,
  ownerUserId: string,
  input: { botId: string; botRevision: number; config: unknown; source: string; createdAt: number }
): void {
  const serialized = typeof input.config === "string" ? input.config : JSON.stringify(input.config);
  parseObject(serialized, "paper bot revision config");
  insertBotEvidence(
    database, ownerId(ownerUserId), identity(input.botId, "bot id", 200),
    positiveInteger(input.botRevision, "bot revision"), serialized,
    identity(input.source, "revision source", 120), timestamp(input.createdAt, "revision time")
  );
}

export function listPaperBotHistoryFrom(
  database: DatabaseSync,
  ownerUserId: string,
  botId: string
): { revisions: Array<Record<string, unknown>>; tombstones: Array<Record<string, unknown>> } {
  const owner = ownerId(ownerUserId);
  const bot = identity(botId, "bot id", 200);
  const parseConfigs = (rows: Array<Record<string, unknown>>) => rows.map((row) => ({ ...row, config: JSON.parse(String(row.config)) }));
  return {
    revisions: parseConfigs(database.prepare(`SELECT * FROM paper_bot_revision_evidence WHERE ownerUserId = ? AND botId = ? ORDER BY botRevision`).all(owner, bot) as Array<Record<string, unknown>>),
    tombstones: parseConfigs(database.prepare(`SELECT * FROM paper_bot_tombstones WHERE ownerUserId = ? AND botId = ? ORDER BY botRevision`).all(owner, bot) as Array<Record<string, unknown>>)
  };
}

export function recordPaperBotTombstoneIn(
  database: DatabaseSync,
  ownerUserId: string,
  input: { botId: string; botRevision: number; config: unknown; reason: string; deletedAt: number }
): void {
  const owner = ownerId(ownerUserId);
  const botId = identity(input.botId, "bot id", 200);
  const revision = positiveInteger(input.botRevision, "bot revision");
  const active = database.prepare(`SELECT 1 FROM paper_bot_allocations WHERE ownerUserId = ? AND botId = ? AND status = 'active'`).get(owner, botId);
  if (active) fail("ACTIVE_ALLOCATION", "A bot with active portfolio capital cannot be tombstoned");
  const config = typeof input.config === "string" ? input.config : JSON.stringify(input.config);
  const parsed = parseObject(config, "paper bot tombstone config");
  const authoritative = database.prepare(`
    SELECT config FROM paper_bot_revision_evidence
    WHERE ownerUserId = ? AND botId = ? AND botRevision = ?
  `).get(owner, botId, revision) as { config: string } | undefined
    ?? database.prepare("SELECT config FROM bots WHERE ownerUserId = ? AND id = ? AND revision = ?")
      .get(owner, botId, revision) as { config: string } | undefined;
  if (!authoritative) fail("BOT_REVISION_EVIDENCE_MISSING", "Paper bot tombstone requires authoritative revision evidence");
  if (stableStringify(parsed) !== stableStringify(parseObject(authoritative.config, "authoritative paper bot config"))) {
    fail("BOT_REVISION_EVIDENCE_CONFLICT", "Paper bot tombstone config differs from authoritative revision evidence");
  }
  database.prepare(`
    INSERT INTO paper_bot_tombstones (ownerUserId, botId, botRevision, config, reason, deletedAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(owner, botId, revision, authoritative.config, identity(input.reason, "tombstone reason", 240), timestamp(input.deletedAt, "deletion time"));
}

export function getPaperMutationReceiptFrom(
  database: DatabaseSync,
  ownerUserId: string,
  idempotencyKey: string
): PaperMutationReceipt | undefined {
  const row = database.prepare(`SELECT * FROM paper_portfolio_mutations WHERE ownerUserId = ? AND idempotencyKey = ?`)
    .get(ownerId(ownerUserId), identity(idempotencyKey, "idempotency key", 200)) as unknown as ReceiptRow | undefined;
  return row ? receiptFromRow(row) : undefined;
}

function requireEpoch(database: DatabaseSync, owner: string, portfolio: string, epoch: number): PaperPortfolioEpoch {
  const row = database.prepare(`
    SELECT * FROM paper_portfolio_epochs WHERE ownerUserId = ? AND portfolioId = ? AND ledgerEpoch = ?
  `).get(owner, portfolio, epoch) as unknown as EpochRow | undefined;
  if (!row) fail("EPOCH_NOT_FOUND", "Paper portfolio epoch was not found");
  return epochFromRow(row);
}
