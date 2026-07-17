import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { replayPaperLedger, type PaperLedgerEvent } from "./paperLedger.js";

export const PAPER_MONEY_MICROS_MAX = 1_000_000_000_000_000;
export const PAPER_PORTFOLIO_FORMULA_VERSION = "paper-metrics-v1";

/** SQLite v9 introduces owner-scoped paper portfolios without rewriting legacy economics. */
export const PAPER_PORTFOLIO_SCHEMA_V9_SQL = `
  ALTER TABLE bots ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);

  CREATE TABLE IF NOT EXISTS paper_events (
    id TEXT PRIMARY KEY,
    botId TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    idempotencyKey TEXT,
    data TEXT NOT NULL,
    ts INTEGER NOT NULL,
    UNIQUE (botId, sequence)
  );
  DROP TRIGGER IF EXISTS paper_events_no_update;
  DROP INDEX IF EXISTS idx_paper_events_bot_sequence;
  DROP INDEX IF EXISTS idx_paper_events_idempotency;
  CREATE TABLE paper_events_v9 (
    id TEXT PRIMARY KEY,
    botId TEXT NOT NULL,
    ledgerEpoch INTEGER NOT NULL DEFAULT 1 CHECK (ledgerEpoch > 0),
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    type TEXT NOT NULL,
    idempotencyKey TEXT,
    data TEXT NOT NULL,
    ts INTEGER NOT NULL,
    UNIQUE (botId, ledgerEpoch, sequence)
  );
  INSERT INTO paper_events_v9 (id, botId, ledgerEpoch, sequence, type, idempotencyKey, data, ts)
    SELECT id, botId, 1, sequence, type, idempotencyKey, data, ts FROM paper_events;
  DROP TABLE paper_events;
  ALTER TABLE paper_events_v9 RENAME TO paper_events;
  CREATE INDEX idx_paper_events_bot_epoch_sequence
    ON paper_events(botId, ledgerEpoch, sequence ASC);
  CREATE UNIQUE INDEX idx_paper_events_epoch_idempotency
    ON paper_events(botId, ledgerEpoch, idempotencyKey) WHERE idempotencyKey IS NOT NULL;
  CREATE TRIGGER paper_events_no_update BEFORE UPDATE ON paper_events BEGIN
    SELECT RAISE(ABORT, 'paper_events is append-only');
  END;
  CREATE TRIGGER paper_events_no_delete BEFORE DELETE ON paper_events BEGIN
    SELECT RAISE(ABORT, 'paper_events is append-only');
  END;

  CREATE TABLE paper_portfolios (
    ownerUserId TEXT NOT NULL CHECK (length(trim(ownerUserId)) BETWEEN 1 AND 160),
    id TEXT NOT NULL CHECK (length(trim(id)) BETWEEN 1 AND 200),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
    currency TEXT NOT NULL DEFAULT 'USDT' CHECK (currency = 'USDT'),
    revision INTEGER NOT NULL CHECK (revision > 0),
    currentEpoch INTEGER NOT NULL CHECK (currentEpoch > 0),
    isDefault INTEGER NOT NULL DEFAULT 0 CHECK (isDefault IN (0, 1)),
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    archivedAt INTEGER,
    PRIMARY KEY (ownerUserId, id)
  );
  CREATE UNIQUE INDEX idx_paper_portfolios_owner_default
    ON paper_portfolios(ownerUserId) WHERE isDefault = 1 AND status = 'active';
  CREATE INDEX idx_paper_portfolios_owner_status
    ON paper_portfolios(ownerUserId, status, updatedAt DESC);

  CREATE TABLE paper_portfolio_epochs (
    ownerUserId TEXT NOT NULL,
    portfolioId TEXT NOT NULL,
    ledgerEpoch INTEGER NOT NULL CHECK (ledgerEpoch > 0),
    initialCapitalMicros INTEGER NOT NULL
      CHECK (initialCapitalMicros BETWEEN 1 AND ${PAPER_MONEY_MICROS_MAX}),
    cashBalanceMicros INTEGER NOT NULL
      CHECK (cashBalanceMicros BETWEEN 0 AND ${PAPER_MONEY_MICROS_MAX}),
    formulaVersion TEXT NOT NULL CHECK (length(trim(formulaVersion)) BETWEEN 1 AND 80),
    evidenceState TEXT NOT NULL CHECK (evidenceState IN ('verified', 'complete', 'legacy-incomplete')),
    status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
    resetCommandId TEXT,
    resetEvidence TEXT,
    startedAt INTEGER NOT NULL,
    closedAt INTEGER,
    PRIMARY KEY (ownerUserId, portfolioId, ledgerEpoch),
    FOREIGN KEY (ownerUserId, portfolioId)
      REFERENCES paper_portfolios(ownerUserId, id) ON DELETE RESTRICT
  );
  CREATE UNIQUE INDEX idx_paper_epochs_one_active
    ON paper_portfolio_epochs(ownerUserId, portfolioId) WHERE status = 'active';

  CREATE TABLE paper_bot_allocations (
    ownerUserId TEXT NOT NULL,
    portfolioId TEXT NOT NULL,
    ledgerEpoch INTEGER NOT NULL CHECK (ledgerEpoch > 0),
    botId TEXT NOT NULL,
    botRevision INTEGER NOT NULL CHECK (botRevision > 0),
    reservedCapitalMicros INTEGER NOT NULL
      CHECK (reservedCapitalMicros BETWEEN 1 AND ${PAPER_MONEY_MICROS_MAX}),
    releasedCapitalMicros INTEGER
      CHECK (releasedCapitalMicros BETWEEN 0 AND ${PAPER_MONEY_MICROS_MAX}),
    status TEXT NOT NULL CHECK (status IN ('active', 'released', 'closed')),
    releaseEvidence TEXT,
    createdAt INTEGER NOT NULL,
    releasedAt INTEGER,
    PRIMARY KEY (ownerUserId, portfolioId, ledgerEpoch, botId, botRevision),
    FOREIGN KEY (ownerUserId, portfolioId, ledgerEpoch)
      REFERENCES paper_portfolio_epochs(ownerUserId, portfolioId, ledgerEpoch) ON DELETE RESTRICT
  );
  CREATE UNIQUE INDEX idx_paper_allocations_active_bot
    ON paper_bot_allocations(ownerUserId, botId) WHERE status = 'active';
  CREATE INDEX idx_paper_allocations_epoch_status
    ON paper_bot_allocations(ownerUserId, portfolioId, ledgerEpoch, status);

  CREATE TABLE paper_valuation_marks (
    ownerUserId TEXT NOT NULL,
    portfolioId TEXT NOT NULL,
    ledgerEpoch INTEGER NOT NULL CHECK (ledgerEpoch > 0),
    botId TEXT NOT NULL,
    botRevision INTEGER NOT NULL CHECK (botRevision > 0),
    symbol TEXT NOT NULL CHECK (length(trim(symbol)) BETWEEN 1 AND 80),
    priceMicros INTEGER NOT NULL CHECK (priceMicros BETWEEN 1 AND ${PAPER_MONEY_MICROS_MAX}),
    asOf INTEGER NOT NULL,
    source TEXT NOT NULL CHECK (length(trim(source)) BETWEEN 1 AND 120),
    expiresAt INTEGER NOT NULL,
    evidence TEXT NOT NULL,
    persistedAt INTEGER NOT NULL,
    PRIMARY KEY (ownerUserId, portfolioId, ledgerEpoch, botId, botRevision, symbol),
    FOREIGN KEY (ownerUserId, portfolioId, ledgerEpoch)
      REFERENCES paper_portfolio_epochs(ownerUserId, portfolioId, ledgerEpoch) ON DELETE RESTRICT
  );

  CREATE TABLE paper_portfolio_mutations (
    ownerUserId TEXT NOT NULL,
    id TEXT NOT NULL,
    idempotencyKey TEXT NOT NULL CHECK (length(trim(idempotencyKey)) BETWEEN 1 AND 200),
    requestHash TEXT NOT NULL CHECK (length(requestHash) = 64),
    action TEXT NOT NULL CHECK (length(trim(action)) BETWEEN 1 AND 80),
    targetId TEXT,
    expectedPortfolioRevision INTEGER,
    expectedLedgerEpoch INTEGER,
    expectedBotRevision INTEGER,
    status TEXT NOT NULL CHECK (status IN ('applying', 'applied', 'rejected')),
    result TEXT,
    createdAt INTEGER NOT NULL,
    completedAt INTEGER,
    PRIMARY KEY (ownerUserId, id),
    UNIQUE (ownerUserId, idempotencyKey)
  );
  CREATE INDEX idx_paper_mutations_owner_created
    ON paper_portfolio_mutations(ownerUserId, createdAt DESC);
  CREATE TRIGGER paper_portfolio_mutations_no_delete BEFORE DELETE ON paper_portfolio_mutations BEGIN
    SELECT RAISE(ABORT, 'paper portfolio mutation receipts are durable');
  END;
  CREATE TRIGGER paper_portfolio_mutations_terminal_immutable
    BEFORE UPDATE ON paper_portfolio_mutations
    WHEN OLD.status <> 'applying' OR NEW.status = 'applying'
  BEGIN
    SELECT RAISE(ABORT, 'terminal paper portfolio mutation receipts are immutable');
  END;

  CREATE TABLE paper_bot_revision_evidence (
    ownerUserId TEXT NOT NULL,
    botId TEXT NOT NULL,
    botRevision INTEGER NOT NULL CHECK (botRevision > 0),
    config TEXT NOT NULL,
    configHash TEXT NOT NULL CHECK (length(configHash) = 64),
    source TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    PRIMARY KEY (ownerUserId, botId, botRevision)
  );
  CREATE TRIGGER paper_bot_revision_evidence_no_update BEFORE UPDATE ON paper_bot_revision_evidence BEGIN
    SELECT RAISE(ABORT, 'paper bot revision evidence is immutable');
  END;
  CREATE TRIGGER paper_bot_revision_evidence_no_delete BEFORE DELETE ON paper_bot_revision_evidence BEGIN
    SELECT RAISE(ABORT, 'paper bot revision evidence is immutable');
  END;

  CREATE TABLE paper_bot_tombstones (
    ownerUserId TEXT NOT NULL,
    botId TEXT NOT NULL,
    botRevision INTEGER NOT NULL CHECK (botRevision > 0),
    config TEXT NOT NULL,
    reason TEXT NOT NULL,
    deletedAt INTEGER NOT NULL,
    PRIMARY KEY (ownerUserId, botId, botRevision)
  );
  CREATE TRIGGER paper_bot_tombstones_no_update BEFORE UPDATE ON paper_bot_tombstones BEGIN
    SELECT RAISE(ABORT, 'paper bot tombstones are immutable');
  END;
  CREATE TRIGGER paper_bot_tombstones_no_delete BEFORE DELETE ON paper_bot_tombstones BEGIN
    SELECT RAISE(ABORT, 'paper bot tombstones are immutable');
  END;

  CREATE TABLE paper_portfolio_events (
    id TEXT PRIMARY KEY,
    ownerUserId TEXT NOT NULL,
    portfolioId TEXT NOT NULL,
    ledgerEpoch INTEGER NOT NULL CHECK (ledgerEpoch > 0),
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    mutationId TEXT NOT NULL,
    mutationOrdinal INTEGER NOT NULL CHECK (mutationOrdinal > 0),
    type TEXT NOT NULL,
    botId TEXT,
    botRevision INTEGER,
    data TEXT NOT NULL,
    ts INTEGER NOT NULL,
    UNIQUE (ownerUserId, portfolioId, ledgerEpoch, sequence),
    UNIQUE (ownerUserId, mutationId, mutationOrdinal),
    FOREIGN KEY (ownerUserId, portfolioId, ledgerEpoch)
      REFERENCES paper_portfolio_epochs(ownerUserId, portfolioId, ledgerEpoch) ON DELETE RESTRICT
  );
  CREATE INDEX idx_paper_portfolio_events_epoch
    ON paper_portfolio_events(ownerUserId, portfolioId, ledgerEpoch, sequence);
  CREATE TRIGGER paper_portfolio_events_no_update BEFORE UPDATE ON paper_portfolio_events BEGIN
    SELECT RAISE(ABORT, 'paper portfolio events are append-only');
  END;
  CREATE TRIGGER paper_portfolio_events_no_delete BEFORE DELETE ON paper_portfolio_events BEGIN
    SELECT RAISE(ABORT, 'paper portfolio events are append-only');
  END;

  CREATE TABLE paper_portfolio_projections (
    ownerUserId TEXT NOT NULL,
    portfolioId TEXT NOT NULL,
    ledgerEpoch INTEGER NOT NULL CHECK (ledgerEpoch > 0),
    lastSequence INTEGER NOT NULL DEFAULT 0 CHECK (lastSequence >= 0),
    formulaVersion TEXT NOT NULL,
    evidenceState TEXT NOT NULL,
    projection TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    projectedAt INTEGER NOT NULL,
    PRIMARY KEY (ownerUserId, portfolioId, ledgerEpoch),
    FOREIGN KEY (ownerUserId, portfolioId, ledgerEpoch)
      REFERENCES paper_portfolio_epochs(ownerUserId, portfolioId, ledgerEpoch) ON DELETE RESTRICT
  );
`;

interface BotRow { id: string; ownerUserId: string; config: string; updatedAt: number; revision: number }
interface EventRow { id: string; botId: string; ledgerEpoch: number; sequence: number; type: string; idempotencyKey: string | null; data: string; ts: number }

/** Backfills one isolated portfolio for every pre-v9 paper bot. */
export function migrateLegacyPaperPortfolios(database: DatabaseSync, appliedAt: number): void {
  const bots = database.prepare(`
    SELECT id, ownerUserId, config, updatedAt, revision FROM bots ORDER BY ownerUserId, id
  `).all() as unknown as BotRow[];
  const defaults = new Set<string>();
  for (const bot of bots) {
    const config = parseObject(bot.config, `bot ${bot.id} config`);
    if (config.exchange !== "paper") continue;
    const events = readLegacyEvents(database, bot.id);
    const snapshot = readLegacySnapshot(database, bot.id);
    const recovered = recoverLegacyCapital(config, events, snapshot);
    const synthesizedEventCount = events.length === 0
      ? seedLegacyPaperLedger(database, bot.ownerUserId, bot.id, recovered.initialMicros, recovered.currentMicros, snapshot, appliedAt)
      : 0;
    const portfolioId = legacyPortfolioId(bot.ownerUserId, bot.id);
    const createdAt = validTimestamp(config.createdAt) ?? validTimestamp(bot.updatedAt) ?? validTimestamp(appliedAt) ?? 1;
    const isDefault = defaults.has(bot.ownerUserId) ? 0 : 1;
    defaults.add(bot.ownerUserId);

    database.prepare(`
      INSERT INTO paper_portfolios
        (ownerUserId, id, name, status, currency, revision, currentEpoch, isDefault, createdAt, updatedAt)
      VALUES (?, ?, ?, 'active', 'USDT', 1, 1, ?, ?, ?)
    `).run(bot.ownerUserId, portfolioId, legacyName(config, bot.id), isDefault, createdAt, appliedAt);
    database.prepare(`
      INSERT INTO paper_portfolio_epochs
        (ownerUserId, portfolioId, ledgerEpoch, initialCapitalMicros, cashBalanceMicros,
         formulaVersion, evidenceState, status, startedAt)
      VALUES (?, ?, 1, ?, ?, ?, ?, 'active', ?)
    `).run(
      bot.ownerUserId, portfolioId, recovered.initialMicros, 0,
      PAPER_PORTFOLIO_FORMULA_VERSION, recovered.evidenceState, createdAt
    );
    database.prepare(`
      INSERT INTO paper_bot_allocations
        (ownerUserId, portfolioId, ledgerEpoch, botId, botRevision, reservedCapitalMicros,
         releasedCapitalMicros, status, releaseEvidence, createdAt, releasedAt)
      VALUES (?, ?, 1, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(
      bot.ownerUserId, portfolioId, bot.id, recovered.initialMicros,
      null, "active", null, createdAt, null
    );
    const migratedConfig = {
      ...config,
      paperPortfolioId: portfolioId,
      paperAllocationMicros: recovered.initialMicros,
      paperLedgerEpoch: 1,
      revision: 1
    };
    const serialized = JSON.stringify(migratedConfig);
    database.prepare("UPDATE bots SET config = ?, revision = 1 WHERE ownerUserId = ? AND id = ?")
      .run(serialized, bot.ownerUserId, bot.id);
    insertRevisionEvidence(database, bot.ownerUserId, bot.id, 1, serialized, "v9-legacy-migration", appliedAt);
    database.prepare(`
      INSERT INTO paper_portfolio_events
        (id, ownerUserId, portfolioId, ledgerEpoch, sequence, mutationId, mutationOrdinal,
         type, botId, botRevision, data, ts)
      VALUES (?, ?, ?, 1, 1, ?, 1, 'legacy-imported', ?, 1, ?, ?)
    `).run(
      `legacy-event:${portfolioId}`, bot.ownerUserId, portfolioId, `legacy-mutation:${portfolioId}`, bot.id,
      JSON.stringify({
        sourceEventCount: events.length,
        synthesizedEventCount,
        evidenceState: recovered.evidenceState,
        recoveredCurrentCapitalMicros: recovered.currentMicros
      }), appliedAt
    );
  }
}

function readLegacyEvents(database: DatabaseSync, botId: string): PaperLedgerEvent[] {
  const rows = database.prepare(`
    SELECT id, botId, ledgerEpoch, sequence, type, idempotencyKey, data, ts
    FROM paper_events WHERE botId = ? ORDER BY ledgerEpoch, sequence
  `).all(botId) as unknown as EventRow[];
  return rows.map((row) => ({
    id: row.id, botId: row.botId, ledgerEpoch: row.ledgerEpoch, sequence: row.sequence,
    type: row.type, ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
    data: parseObject(row.data, `paper event ${row.id} data`), ts: row.ts
  })) as PaperLedgerEvent[];
}

function readLegacySnapshot(database: DatabaseSync, botId: string): Record<string, unknown> | undefined {
  const row = database.prepare("SELECT value FROM settings WHERE key = ?").get(`paper:${botId}`) as { value: string } | undefined;
  return row ? parseObject(row.value, `paper snapshot ${botId}`) : undefined;
}

function seedLegacyPaperLedger(
  database: DatabaseSync,
  owner: string,
  botId: string,
  initialMicros: number,
  currentMicros: number,
  snapshot: Record<string, unknown> | undefined,
  appliedAt: number
): number {
  const drafts: Array<{ type: string; data: unknown; idempotencyKey?: string }> = [{
    type: "account_initialized",
    data: { balance: initialMicros / 1_000_000, leverage: 1, isolated: false, dualSide: false },
    idempotencyKey: "account-initialized"
  }];
  if (snapshot) {
    if (!finiteNumber(snapshot.balance)) throw new Error(`Invalid legacy paper snapshot balance for ${botId}`);
    const deltaMicros = currentMicros - initialMicros;
    if (deltaMicros !== 0) drafts.push({
      type: "cash",
      data: { amount: deltaMicros / 1_000_000, reason: "legacy-balance-adjustment" }
    });
    if (snapshot.orders !== undefined && !Array.isArray(snapshot.orders)) {
      throw new Error(`Invalid legacy paper snapshot orders for ${botId}`);
    }
    for (const order of (snapshot.orders as unknown[] | undefined) ?? []) {
      drafts.push({ type: "order_upserted", data: { order } });
    }
    if (snapshot.position) drafts.push({ type: "position", data: { position: snapshot.position } });
    drafts.push({
      type: "settings",
      data: {
        leverage: snapshot.leverage ?? 1,
        isolated: snapshot.isolated ?? false,
        dualSide: snapshot.dualSide ?? false
      }
    });
  }
  const insert = database.prepare(`
    INSERT INTO paper_events (id, botId, ledgerEpoch, sequence, type, idempotencyKey, data, ts)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?)
  `);
  const ts = validTimestamp(appliedAt) ?? 1;
  drafts.forEach((draft, index) => insert.run(
    `legacy-ledger-${sha256(`${owner}\0${botId}\0${index + 1}`)}`,
    botId,
    index + 1,
    draft.type,
    draft.idempotencyKey ?? null,
    JSON.stringify(draft.data),
    ts
  ));
  replayPaperLedger(readLegacyEvents(database, botId), botId, 1);
  return drafts.length;
}

function recoverLegacyCapital(
  config: Record<string, unknown>,
  events: PaperLedgerEvent[],
  snapshot?: Record<string, unknown>
): { initialMicros: number; currentMicros: number; evidenceState: "complete" | "legacy-incomplete"; hasOpenRisk: boolean } {
  if (events.length > 0) {
    const state = replayPaperLedger(events, events[0]?.botId, 1);
    const first = events[0];
    if (first?.type !== "account_initialized") throw new Error("Legacy paper ledger is missing account_initialized");
    return {
      initialMicros: moneyMicros(first.data.balance, "legacy initial balance"),
      currentMicros: moneyMicros(state.balance, "legacy current balance"),
      evidenceState: "complete",
      hasOpenRisk: state.position !== null || state.orders.length > 0
    };
  }
  const formulaBalance = config.sizeMode === "quote" && finiteNumber(config.sizeValue)
    ? Math.max(config.sizeValue * 10, 10_000)
    : 10_000;
  if (snapshot && !finiteNumber(snapshot.balance)) throw new Error("Invalid legacy snapshot balance");
  const snapshotBalance = snapshot ? snapshot.balance : formulaBalance;
  return {
    initialMicros: moneyMicros(formulaBalance, "legacy formula balance"),
    currentMicros: moneyMicros(snapshotBalance, "legacy snapshot balance"),
    evidenceState: "legacy-incomplete",
    hasOpenRisk: Boolean(snapshot?.position) || (Array.isArray(snapshot?.orders) && snapshot.orders.length > 0)
  };
}

function insertRevisionEvidence(
  database: DatabaseSync, owner: string, botId: string, revision: number,
  config: string, source: string, createdAt: number
): void {
  database.prepare(`
    INSERT INTO paper_bot_revision_evidence
      (ownerUserId, botId, botRevision, config, configHash, source, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(owner, botId, revision, config, sha256(config), source, createdAt);
}

function legacyPortfolioId(owner: string, botId: string): string {
  return `legacy-paper-${sha256(`${owner}\0${botId}`).slice(0, 32)}`;
}

function legacyName(config: Record<string, unknown>, botId: string): string {
  const name = typeof config.name === "string" ? config.name.trim() : "";
  return (name || `Legacy ${botId}`).slice(0, 120);
}

function parseObject(serialized: string, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw new Error(`Invalid ${label}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function moneyMicros(value: unknown, label: string): number {
  if (!finiteNumber(value) || value < 0) throw new Error(`Invalid ${label}`);
  const micros = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(micros) || micros > PAPER_MONEY_MICROS_MAX) throw new Error(`${label} exceeds fixed-money bounds`);
  return micros;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validTimestamp(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
