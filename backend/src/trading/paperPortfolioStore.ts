import type { DatabaseSync } from "node:sqlite";
import { PAPER_PORTFOLIO_FORMULA_VERSION } from "./paperPortfolioMigration.js";
import {
  allocationFromRow,
  appendPortfolioEvent,
  checkedMoneySum,
  epochFromRow,
  fail,
  identity,
  insertBotEvidence,
  ownerId,
  parseObject,
  portfolioFromRow,
  positiveMoneyMicros,
  positiveInteger,
  serializeJson,
  sha256,
  transaction,
  validateFlatEvidence,
  validateMutation,
  type AllocationRow,
  type EpochRow,
  type PaperBotAllocation,
  type PaperMutationIdentity,
  PaperPortfolioStoreError,
  type PaperPortfolio,
  type PaperPortfolioEpoch,
  type PortfolioRow,
  type ReceiptRow,
  type VerifiedFlatBotEvidence
} from "./paperPortfolioStoreSupport.js";
export {
  PaperPortfolioStoreError,
  type PaperAllocationStatus,
  type PaperBotAllocation,
  type PaperEpochStatus,
  type PaperMutationIdentity,
  type PaperMutationReceipt,
  type PaperPortfolio,
  type PaperPortfolioEpoch,
  type PaperPortfolioStatus,
  type VerifiedFlatBotEvidence
} from "./paperPortfolioStoreSupport.js";
export {
  appendPaperPortfolioEventsIn,
  getPaperMutationReceiptFrom,
  getPaperProjectionMetadataFrom,
  listPaperBotHistoryFrom,
  listPaperPortfolioEventsFrom,
  readPaperValuationMarkFrom,
  recordPaperBotRevisionEvidenceIn,
  recordPaperBotTombstoneIn,
  upsertPaperProjectionMetadataIn,
  upsertPaperValuationMarkIn,
  type PaperPortfolioEventInput,
  type PaperValuationMark
} from "./paperPortfolioEvidenceStore.js";
export const PAPER_PORTFOLIO_LIMIT_PER_OWNER = 8;
export const PAPER_MUTATION_RECEIPT_LIMIT_PER_OWNER = 10_000;
export function listPaperPortfoliosFrom(
  database: DatabaseSync,
  ownerUserId: string,
  includeArchived = false
): PaperPortfolio[] {
  const owner = ownerId(ownerUserId);
  const rows = database.prepare(`
    SELECT ownerUserId, id, name, status, currency, revision, currentEpoch,
           isDefault, createdAt, updatedAt, archivedAt
    FROM paper_portfolios WHERE ownerUserId = ? ${includeArchived ? "" : "AND status = 'active'"}
    ORDER BY isDefault DESC, updatedAt DESC, id ASC
  `).all(owner) as unknown as PortfolioRow[];
  return rows.map(portfolioFromRow);
}

export function getPaperPortfolioFrom(
  database: DatabaseSync,
  ownerUserId: string,
  portfolioId: string
): PaperPortfolio | undefined {
  const row = database.prepare(`
    SELECT ownerUserId, id, name, status, currency, revision, currentEpoch,
           isDefault, createdAt, updatedAt, archivedAt
    FROM paper_portfolios WHERE ownerUserId = ? AND id = ?
  `).get(ownerId(ownerUserId), identity(portfolioId, "portfolio id", 200)) as unknown as PortfolioRow | undefined;
  return row ? portfolioFromRow(row) : undefined;
}

export function getPaperPortfolioEpochFrom(
  database: DatabaseSync,
  ownerUserId: string,
  portfolioId: string,
  ledgerEpoch: number
): PaperPortfolioEpoch | undefined {
  const row = database.prepare(`
    SELECT * FROM paper_portfolio_epochs
    WHERE ownerUserId = ? AND portfolioId = ? AND ledgerEpoch = ?
  `).get(ownerId(ownerUserId), identity(portfolioId, "portfolio id", 200), positiveInteger(ledgerEpoch, "ledger epoch")) as unknown as EpochRow | undefined;
  return row ? epochFromRow(row) : undefined;
}

export function listPaperPortfolioEpochsFrom(
  database: DatabaseSync,
  ownerUserId: string,
  portfolioId: string
): PaperPortfolioEpoch[] {
  const rows = database.prepare(`
    SELECT * FROM paper_portfolio_epochs
    WHERE ownerUserId = ? AND portfolioId = ? ORDER BY ledgerEpoch ASC
  `).all(ownerId(ownerUserId), identity(portfolioId, "portfolio id", 200)) as unknown as EpochRow[];
  return rows.map(epochFromRow);
}

export function listPaperBotAllocationsFrom(
  database: DatabaseSync,
  ownerUserId: string,
  portfolioId: string,
  ledgerEpoch?: number
): PaperBotAllocation[] {
  const owner = ownerId(ownerUserId);
  const portfolio = identity(portfolioId, "portfolio id", 200);
  const rows = (ledgerEpoch === undefined
    ? database.prepare(`SELECT * FROM paper_bot_allocations WHERE ownerUserId = ? AND portfolioId = ? ORDER BY ledgerEpoch, createdAt, botId`).all(owner, portfolio)
    : database.prepare(`SELECT * FROM paper_bot_allocations WHERE ownerUserId = ? AND portfolioId = ? AND ledgerEpoch = ? ORDER BY createdAt, botId`).all(owner, portfolio, positiveInteger(ledgerEpoch, "ledger epoch"))) as unknown as AllocationRow[];
  return rows.map(allocationFromRow);
}

export function createPaperPortfolioIn(
  database: DatabaseSync,
  ownerUserId: string,
  input: PaperMutationIdentity & { portfolioId: string; name: string; initialCapitalMicros: number; makeDefault?: boolean }
): PaperPortfolio {
  const owner = ownerId(ownerUserId);
  const id = identity(input.portfolioId, "portfolio id", 200);
  const name = identity(input.name, "portfolio name", 120);
  const capital = positiveMoneyMicros(input.initialCapitalMicros, "initial capital");
  return runMutation(database, owner, "create", id, input, {}, () => {
    const count = Number((database.prepare("SELECT COUNT(*) AS value FROM paper_portfolios WHERE ownerUserId = ?").get(owner) as { value: number }).value);
    if (count >= PAPER_PORTFOLIO_LIMIT_PER_OWNER) fail("PORTFOLIO_LIMIT", `An owner may keep at most ${PAPER_PORTFOLIO_LIMIT_PER_OWNER} paper portfolios`);
    if (getPaperPortfolioFrom(database, owner, id)) fail("ALREADY_EXISTS", `Paper portfolio ${id} already exists`);
    const hasDefault = Boolean(database.prepare("SELECT 1 FROM paper_portfolios WHERE ownerUserId = ? AND status = 'active' AND isDefault = 1").get(owner));
    const makeDefault = input.makeDefault === true || !hasDefault;
    if (makeDefault) clearDefault(database, owner, input.now);
    database.prepare(`
      INSERT INTO paper_portfolios
        (ownerUserId, id, name, status, currency, revision, currentEpoch, isDefault, createdAt, updatedAt)
      VALUES (?, ?, ?, 'active', 'USDT', 1, 1, ?, ?, ?)
    `).run(owner, id, name, makeDefault ? 1 : 0, input.now, input.now);
    database.prepare(`
      INSERT INTO paper_portfolio_epochs
        (ownerUserId, portfolioId, ledgerEpoch, initialCapitalMicros, cashBalanceMicros,
         formulaVersion, evidenceState, status, startedAt)
      VALUES (?, ?, 1, ?, ?, ?, 'verified', 'active', ?)
    `).run(owner, id, capital, capital, PAPER_PORTFOLIO_FORMULA_VERSION, input.now);
    appendPortfolioEvent(database, owner, id, 1, input.mutationId, 1, "portfolio-created", { initialCapitalMicros: capital }, input.now);
    return requirePortfolio(database, owner, id);
  });
}

export function ensureDefaultPaperPortfolioIn(
  database: DatabaseSync,
  ownerUserId: string,
  input: PaperMutationIdentity & { portfolioId?: string; name?: string; initialCapitalMicros?: number }
): PaperPortfolio {
  const owner = ownerId(ownerUserId);
  const current = database.prepare(`
    SELECT ownerUserId, id, name, status, currency, revision, currentEpoch,
           isDefault, createdAt, updatedAt, archivedAt
    FROM paper_portfolios WHERE ownerUserId = ? AND status = 'active' AND isDefault = 1
  `).get(owner) as unknown as PortfolioRow | undefined;
  if (current) return portfolioFromRow(current);
  const existing = listPaperPortfoliosFrom(database, owner)[0];
  if (existing) return setDefaultPaperPortfolioIn(database, owner, {
    ...input, portfolioId: existing.id, expectedRevision: existing.revision,
    expectedLedgerEpoch: existing.currentEpoch
  });
  return createPaperPortfolioIn(database, owner, {
    ...input,
    portfolioId: input.portfolioId ?? `default-${sha256(input.mutationId).slice(0, 32)}`,
    name: input.name ?? "Paper portfolio",
    initialCapitalMicros: input.initialCapitalMicros ?? 100_000_000_000,
    makeDefault: true
  });
}

export function renamePaperPortfolioIn(
  database: DatabaseSync,
  ownerUserId: string,
  input: PaperMutationIdentity & { portfolioId: string; expectedRevision: number; expectedLedgerEpoch: number; name: string }
): PaperPortfolio {
  return mutatePortfolio(database, ownerUserId, "rename", input, (owner, current) => {
    const name = identity(input.name, "portfolio name", 120);
    database.prepare(`UPDATE paper_portfolios SET name = ?, revision = revision + 1, updatedAt = ? WHERE ownerUserId = ? AND id = ?`)
      .run(name, input.now, owner, current.id);
    appendPortfolioEvent(database, owner, current.id, current.currentEpoch, input.mutationId, 1, "portfolio-renamed", { name }, input.now);
  });
}

export function setDefaultPaperPortfolioIn(
  database: DatabaseSync,
  ownerUserId: string,
  input: PaperMutationIdentity & { portfolioId: string; expectedRevision: number; expectedLedgerEpoch: number }
): PaperPortfolio {
  return mutatePortfolio(database, ownerUserId, "set-default", input, (owner, current) => {
    if (current.status !== "active") fail("PORTFOLIO_ARCHIVED", "An archived portfolio cannot be the default");
    if (!current.isDefault) {
      clearDefault(database, owner, input.now);
      database.prepare(`UPDATE paper_portfolios SET isDefault = 1, revision = revision + 1, updatedAt = ? WHERE ownerUserId = ? AND id = ?`)
        .run(input.now, owner, current.id);
      appendPortfolioEvent(database, owner, current.id, current.currentEpoch, input.mutationId, 1, "portfolio-defaulted", {}, input.now);
    }
  });
}

export function archivePaperPortfolioIn(
  database: DatabaseSync,
  ownerUserId: string,
  input: PaperMutationIdentity & { portfolioId: string; expectedRevision: number; expectedLedgerEpoch: number }
): PaperPortfolio {
  return mutatePortfolio(database, ownerUserId, "archive", input, (owner, current) => {
    if (current.status === "archived") return;
    const active = Number((database.prepare(`
      SELECT COUNT(*) AS value FROM paper_bot_allocations
      WHERE ownerUserId = ? AND portfolioId = ? AND status = 'active'
    `).get(owner, current.id) as { value: number }).value);
    if (active > 0) fail("ACTIVE_ALLOCATIONS", "Release every active bot allocation before archiving the portfolio");
    appendPortfolioEvent(database, owner, current.id, current.currentEpoch, input.mutationId, 1, "portfolio-archived", {}, input.now);
    database.prepare(`
      UPDATE paper_portfolio_epochs SET status = 'closed', closedAt = ?
      WHERE ownerUserId = ? AND portfolioId = ? AND status = 'active'
    `).run(input.now, owner, current.id);
    database.prepare(`
      UPDATE paper_portfolios SET status = 'archived', isDefault = 0, archivedAt = ?,
        revision = revision + 1, updatedAt = ? WHERE ownerUserId = ? AND id = ?
    `).run(input.now, input.now, owner, current.id);
    if (current.isDefault) promoteOldestDefault(database, owner, input.now);
  });
}

export interface PaperPortfolioResetResult { portfolio: PaperPortfolio; closedAllocations: PaperBotAllocation[]; rebindRequired: Array<{ botId: string; priorBotRevision: number }> }
/** Closes the prior epoch; returned bots must be rebound through reserveAndBind. */
export function resetPaperPortfolioIn(
  database: DatabaseSync,
  ownerUserId: string,
  input: PaperMutationIdentity & {
    portfolioId: string; expectedRevision: number; expectedLedgerEpoch: number;
    initialCapitalMicros: number; flatBots: readonly VerifiedFlatBotEvidence[];
  }
): PaperPortfolioResetResult {
  const owner = ownerId(ownerUserId);
  const portfolioId = identity(input.portfolioId, "portfolio id", 200);
  const capital = positiveMoneyMicros(input.initialCapitalMicros, "reset initial capital");
  return runMutation(database, owner, "reset", portfolioId, input, {
    expectedPortfolioRevision: input.expectedRevision,
    expectedLedgerEpoch: input.expectedLedgerEpoch
  }, () => {
    const current = requirePortfolio(database, owner, portfolioId, positiveInteger(input.expectedRevision, "expected revision"));
    if (current.status !== "active") fail("PORTFOLIO_ARCHIVED", "An archived portfolio cannot be reset");
    if (current.currentEpoch !== input.expectedLedgerEpoch) fail("EPOCH_CONFLICT", "Paper portfolio epoch changed");
    const allocations = listPaperBotAllocationsFrom(database, owner, current.id, current.currentEpoch)
      .filter((allocation) => allocation.status === "active");
    const evidence = new Map(input.flatBots.map((item) => [`${item.botId}\0${item.botRevision}`, validateFlatEvidence(item)]));
    if (evidence.size !== input.flatBots.length) fail("DUPLICATE_FLAT_EVIDENCE", "Flat bot evidence contains a duplicate bot revision");
    const allocationKeys = new Set(allocations.map((allocation) => `${allocation.botId}\0${allocation.botRevision}`));
    for (const [key, proof] of evidence) {
      if (!allocationKeys.has(key)) fail("UNEXPECTED_FLAT_EVIDENCE", `Bot ${proof.botId} is not allocated to this portfolio epoch`);
      if (proof.checkedAt > input.now) fail("INVALID_FLAT_EVIDENCE_TIME", "Flat evidence cannot come from the future");
    }
    for (const allocation of allocations) {
      const proof = evidence.get(`${allocation.botId}\0${allocation.botRevision}`);
      if (!proof) fail("FLAT_EVIDENCE_REQUIRED", `Verified flat evidence is required for bot ${allocation.botId}`);
      database.prepare(`
        UPDATE paper_bot_allocations SET status = 'closed', releasedCapitalMicros = ?, releaseEvidence = ?, releasedAt = ?
        WHERE ownerUserId = ? AND portfolioId = ? AND ledgerEpoch = ? AND botId = ? AND botRevision = ? AND status = 'active'
      `).run(
        proof.returnedCapitalMicros, serializeJson(proof, "flat bot evidence"), input.now, owner, current.id,
        current.currentEpoch, allocation.botId, allocation.botRevision
      );
    }
    const returned = allocations.reduce((sum, allocation) => {
      const proof = evidence.get(`${allocation.botId}\0${allocation.botRevision}`)!;
      return checkedMoneySum(sum, proof.returnedCapitalMicros, "reset returned capital");
    }, 0);
    const closingEpoch = requireEpoch(database, owner, current.id, current.currentEpoch);
    checkedMoneySum(closingEpoch.cashBalanceMicros, returned, "reset closing cash");
    database.prepare(`
      UPDATE paper_portfolio_epochs SET cashBalanceMicros = cashBalanceMicros + ?, status = 'closed',
        closedAt = ?, resetCommandId = ?, resetEvidence = ?
      WHERE ownerUserId = ? AND portfolioId = ? AND ledgerEpoch = ? AND status = 'active'
    `).run(returned, input.now, input.mutationId, serializeJson([...evidence.values()], "reset flat evidence"), owner, current.id, current.currentEpoch);
    appendPortfolioEvent(database, owner, current.id, current.currentEpoch, input.mutationId, 1, "epoch-closed", { returnedCapitalMicros: returned }, input.now);
    const nextEpoch = current.currentEpoch + 1;
    database.prepare(`
      INSERT INTO paper_portfolio_epochs
        (ownerUserId, portfolioId, ledgerEpoch, initialCapitalMicros, cashBalanceMicros,
         formulaVersion, evidenceState, status, resetCommandId, resetEvidence, startedAt)
      VALUES (?, ?, ?, ?, ?, ?, 'verified', 'active', ?, ?, ?)
    `).run(owner, current.id, nextEpoch, capital, capital, PAPER_PORTFOLIO_FORMULA_VERSION, input.mutationId, serializeJson([...evidence.values()], "reset flat evidence"), input.now);
    database.prepare(`UPDATE paper_portfolios SET currentEpoch = ?, revision = revision + 1, updatedAt = ? WHERE ownerUserId = ? AND id = ?`)
      .run(nextEpoch, input.now, owner, current.id);
    appendPortfolioEvent(database, owner, current.id, nextEpoch, input.mutationId, 2, "epoch-reset", { initialCapitalMicros: capital }, input.now);
    return {
      portfolio: requirePortfolio(database, owner, current.id),
      closedAllocations: allocations.map((allocation) => requireAllocation(
        database, owner, current.id, current.currentEpoch, allocation.botId, allocation.botRevision
      )),
      rebindRequired: allocations.map((allocation) => ({ botId: allocation.botId, priorBotRevision: allocation.botRevision }))
    };
  });
}

export function reserveAndBindPaperBotIn(
  database: DatabaseSync,
  ownerUserId: string,
  input: PaperMutationIdentity & {
    portfolioId: string; expectedRevision: number; expectedLedgerEpoch: number;
    botId: string; expectedBotRevision: number; allocationMicros: number;
  }
): { portfolio: PaperPortfolio; allocation: PaperBotAllocation; botRevision: number } {
  const owner = ownerId(ownerUserId);
  const portfolioId = identity(input.portfolioId, "portfolio id", 200);
  const botId = identity(input.botId, "bot id", 200);
  const allocationMicros = positiveMoneyMicros(input.allocationMicros, "paper allocation");
  return runMutation(database, owner, "reserve-bind", portfolioId, input, {
    expectedPortfolioRevision: input.expectedRevision,
    expectedLedgerEpoch: input.expectedLedgerEpoch,
    expectedBotRevision: input.expectedBotRevision
  }, () => {
    const portfolio = requirePortfolio(database, owner, portfolioId, input.expectedRevision);
    if (portfolio.status !== "active" || portfolio.currentEpoch !== input.expectedLedgerEpoch) fail("EPOCH_CONFLICT", "Paper portfolio is not on the expected active epoch");
    const epoch = requireEpoch(database, owner, portfolio.id, portfolio.currentEpoch);
    if (epoch.status !== "active" || epoch.cashBalanceMicros < allocationMicros) fail("INSUFFICIENT_CAPITAL", "Paper portfolio has insufficient unallocated cash");
    const activeAllocation = database.prepare("SELECT portfolioId FROM paper_bot_allocations WHERE ownerUserId = ? AND botId = ? AND status = 'active'")
      .get(owner, botId) as { portfolioId: string } | undefined;
    if (activeAllocation) fail("BOT_ALREADY_ALLOCATED", `Paper bot ${botId} already has active portfolio capital`);
    const bot = database.prepare("SELECT config, revision FROM bots WHERE ownerUserId = ? AND id = ?").get(owner, botId) as { config: string; revision: number } | undefined;
    if (!bot) fail("BOT_NOT_FOUND", `Paper bot ${botId} was not found`);
    if (bot.revision !== input.expectedBotRevision) fail("BOT_REVISION_CONFLICT", "Paper bot revision changed");
    const config = parseObject(bot.config, `paper bot ${botId} config`);
    if (config.exchange !== "paper") fail("NOT_PAPER_BOT", `Bot ${botId} is not a paper bot`);
    const nextBotRevision = bot.revision + 1;
    insertBotEvidence(database, owner, botId, bot.revision, bot.config, "pre-bind", input.now, true);
    const nextConfig = JSON.stringify({
      ...config, paperPortfolioId: portfolio.id, paperAllocationMicros: allocationMicros,
      paperLedgerEpoch: portfolio.currentEpoch, revision: nextBotRevision
    });
    const changed = database.prepare(`
      UPDATE bots SET config = ?, revision = ?, updatedAt = ?
      WHERE ownerUserId = ? AND id = ? AND revision = ?
    `).run(nextConfig, nextBotRevision, input.now, owner, botId, bot.revision).changes;
    if (changed !== 1) fail("BOT_REVISION_CONFLICT", "Paper bot revision changed");
    insertBotEvidence(database, owner, botId, nextBotRevision, nextConfig, "portfolio-bind", input.now);
    const priorLedger = database.prepare(`
      SELECT ledgerEpoch FROM paper_events WHERE botId = ? AND ledgerEpoch = ? LIMIT 1
    `).get(botId, portfolio.currentEpoch);
    if (priorLedger) fail("LEDGER_ALREADY_EXISTS", "This bot already has durable evidence in the target ledger epoch; reset the target portfolio before rebinding");
    database.prepare(`
      INSERT INTO paper_events
        (id, botId, ledgerEpoch, sequence, type, idempotencyKey, data, ts)
      VALUES (?, ?, ?, 1, 'account_initialized', 'account-initialized', ?, ?)
    `).run(
      `paper-init-${sha256(`${owner}\0${botId}\0${portfolio.currentEpoch}`)}`,
      botId,
      portfolio.currentEpoch,
      JSON.stringify({ balance: allocationMicros / 1_000_000, leverage: 1, isolated: false, dualSide: false }),
      input.now
    );
    database.prepare(`
      UPDATE paper_portfolio_epochs SET cashBalanceMicros = cashBalanceMicros - ?
      WHERE ownerUserId = ? AND portfolioId = ? AND ledgerEpoch = ? AND cashBalanceMicros >= ?
    `).run(allocationMicros, owner, portfolio.id, portfolio.currentEpoch, allocationMicros);
    database.prepare(`
      INSERT INTO paper_bot_allocations
        (ownerUserId, portfolioId, ledgerEpoch, botId, botRevision, reservedCapitalMicros, status, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(owner, portfolio.id, portfolio.currentEpoch, botId, nextBotRevision, allocationMicros, input.now);
    database.prepare(`UPDATE paper_portfolios SET revision = revision + 1, updatedAt = ? WHERE ownerUserId = ? AND id = ?`)
      .run(input.now, owner, portfolio.id);
    appendPortfolioEvent(database, owner, portfolio.id, portfolio.currentEpoch, input.mutationId, 1, "bot-reserved", {
      botId, botRevision: nextBotRevision, reservedCapitalMicros: allocationMicros
    }, input.now, botId, nextBotRevision);
    const resultPortfolio = requirePortfolio(database, owner, portfolio.id);
    const resultAllocation = requireAllocation(database, owner, portfolio.id, portfolio.currentEpoch, botId, nextBotRevision);
    return { portfolio: resultPortfolio, allocation: resultAllocation, botRevision: nextBotRevision };
  });
}

export function releaseFlatPaperBotAllocationIn(
  database: DatabaseSync,
  ownerUserId: string,
  input: PaperMutationIdentity & {
    portfolioId: string; expectedRevision: number; expectedLedgerEpoch: number;
    evidence: VerifiedFlatBotEvidence;
  }
): { portfolio: PaperPortfolio; allocation: PaperBotAllocation } {
  const owner = ownerId(ownerUserId);
  const portfolioId = identity(input.portfolioId, "portfolio id", 200);
  const proof = validateFlatEvidence(input.evidence);
  if (proof.checkedAt > input.now) fail("INVALID_FLAT_EVIDENCE_TIME", "Flat evidence cannot come from the future");
  return runMutation(database, owner, "release", portfolioId, input, {
    expectedPortfolioRevision: input.expectedRevision,
    expectedLedgerEpoch: input.expectedLedgerEpoch,
    expectedBotRevision: proof.botRevision
  }, () => {
    const portfolio = requirePortfolio(database, owner, portfolioId, input.expectedRevision);
    if (portfolio.status !== "active" || portfolio.currentEpoch !== input.expectedLedgerEpoch) fail("EPOCH_CONFLICT", "Paper portfolio epoch changed");
    const allocation = requireAllocation(database, owner, portfolio.id, portfolio.currentEpoch, proof.botId, proof.botRevision);
    if (allocation.status !== "active") fail("ALLOCATION_NOT_ACTIVE", "Paper bot allocation is not active");
    const epoch = requireEpoch(database, owner, portfolio.id, portfolio.currentEpoch);
    if (epoch.status !== "active") fail("EPOCH_CONFLICT", "Paper portfolio epoch is not active");
    checkedMoneySum(epoch.cashBalanceMicros, proof.returnedCapitalMicros, "released paper capital");
    database.prepare(`
      UPDATE paper_bot_allocations SET status = 'released', releasedCapitalMicros = ?, releaseEvidence = ?, releasedAt = ?
      WHERE ownerUserId = ? AND portfolioId = ? AND ledgerEpoch = ? AND botId = ? AND botRevision = ? AND status = 'active'
    `).run(
      proof.returnedCapitalMicros, serializeJson(proof, "flat bot evidence"), input.now, owner, portfolio.id,
      portfolio.currentEpoch, proof.botId, proof.botRevision
    );
    database.prepare(`
      UPDATE paper_portfolio_epochs SET cashBalanceMicros = cashBalanceMicros + ?
      WHERE ownerUserId = ? AND portfolioId = ? AND ledgerEpoch = ?
    `).run(proof.returnedCapitalMicros, owner, portfolio.id, portfolio.currentEpoch);
    database.prepare(`UPDATE paper_portfolios SET revision = revision + 1, updatedAt = ? WHERE ownerUserId = ? AND id = ?`)
      .run(input.now, owner, portfolio.id);
    appendPortfolioEvent(database, owner, portfolio.id, portfolio.currentEpoch, input.mutationId, 1, "bot-released", {
      botId: proof.botId, botRevision: proof.botRevision, releasedCapitalMicros: proof.returnedCapitalMicros
    }, input.now, proof.botId, proof.botRevision);
    return {
      portfolio: requirePortfolio(database, owner, portfolio.id),
      allocation: requireAllocation(database, owner, portfolio.id, portfolio.currentEpoch, proof.botId, proof.botRevision)
    };
  });
}

export function recordPaperExecutorReceiptIn<T>(
  database: DatabaseSync,
  ownerUserId: string,
  input: PaperMutationIdentity & { portfolioId: string; ledgerEpoch: number; result: T }
): T {
  const owner = ownerId(ownerUserId);
  const target = identity(input.portfolioId, "portfolio id", 200);
  return runMutation(database, owner, "executor", target, input, { expectedLedgerEpoch: input.ledgerEpoch }, () => {
    requireEpoch(database, owner, target, input.ledgerEpoch);
    return structuredClone(input.result);
  });
}

function mutatePortfolio<T extends PaperMutationIdentity & { portfolioId: string; expectedRevision: number; expectedLedgerEpoch: number }>(
  database: DatabaseSync,
  ownerUserId: string,
  action: string,
  input: T,
  mutate: (owner: string, current: PaperPortfolio) => void
): PaperPortfolio {
  const owner = ownerId(ownerUserId);
  const portfolioId = identity(input.portfolioId, "portfolio id", 200);
  return runMutation(database, owner, action, portfolioId, input, {
    expectedPortfolioRevision: input.expectedRevision,
    expectedLedgerEpoch: input.expectedLedgerEpoch
  }, () => {
    const current = requirePortfolio(database, owner, portfolioId, positiveInteger(input.expectedRevision, "expected revision"));
    if (current.currentEpoch !== positiveInteger(input.expectedLedgerEpoch, "expected ledger epoch")) {
      fail("EPOCH_CONFLICT", "Paper portfolio epoch changed");
    }
    mutate(owner, current);
    return requirePortfolio(database, owner, portfolioId);
  });
}

function runMutation<T>(
  database: DatabaseSync,
  owner: string,
  action: string,
  targetId: string,
  identityInput: PaperMutationIdentity,
  expected: { expectedPortfolioRevision?: number; expectedLedgerEpoch?: number; expectedBotRevision?: number },
  apply: () => T
): T {
  const mutation = validateMutation(identityInput);
  try {
    return transaction(database, () => {
    const priorByKey = database.prepare(`SELECT * FROM paper_portfolio_mutations WHERE ownerUserId = ? AND idempotencyKey = ?`)
      .get(owner, mutation.idempotencyKey) as unknown as ReceiptRow | undefined;
    const priorById = database.prepare(`SELECT * FROM paper_portfolio_mutations WHERE ownerUserId = ? AND id = ?`)
      .get(owner, mutation.mutationId) as unknown as ReceiptRow | undefined;
    const prior = priorByKey ?? priorById;
    if (prior) {
      const conflicts = prior.requestHash !== mutation.requestHash || prior.action !== action || prior.id !== mutation.mutationId
        || prior.idempotencyKey !== mutation.idempotencyKey || prior.targetId !== targetId
        || prior.expectedPortfolioRevision !== (expected.expectedPortfolioRevision ?? null) || prior.expectedLedgerEpoch !== (expected.expectedLedgerEpoch ?? null)
        || prior.expectedBotRevision !== (expected.expectedBotRevision ?? null);
      if (conflicts) {
        fail("IDEMPOTENCY_CONFLICT", "Mutation identity was already used for a different request");
      }
      if (prior.status === "rejected") {
        const rejection = prior.result === null ? undefined : JSON.parse(prior.result) as { error?: { code?: string; message?: string } };
        fail(rejection?.error?.code ?? "MUTATION_REJECTED", rejection?.error?.message ?? "Paper mutation was rejected");
      }
      if (prior.status !== "applied" || prior.result === null) fail("MUTATION_IN_PROGRESS", "Mutation does not have a durable applied result");
      return JSON.parse(prior.result) as T;
    }
    const count = Number((database.prepare("SELECT COUNT(*) AS value FROM paper_portfolio_mutations WHERE ownerUserId = ?").get(owner) as { value: number }).value);
    if (count >= PAPER_MUTATION_RECEIPT_LIMIT_PER_OWNER) fail("RECEIPT_LIMIT", `An owner may keep at most ${PAPER_MUTATION_RECEIPT_LIMIT_PER_OWNER} paper mutation receipts`);
    database.prepare(`
      INSERT INTO paper_portfolio_mutations
        (ownerUserId, id, idempotencyKey, requestHash, action, targetId,
         expectedPortfolioRevision, expectedLedgerEpoch, expectedBotRevision, status, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'applying', ?)
    `).run(
      owner, mutation.mutationId, mutation.idempotencyKey, mutation.requestHash, action, targetId,
      expected.expectedPortfolioRevision ?? null, expected.expectedLedgerEpoch ?? null,
      expected.expectedBotRevision ?? null, mutation.now
    );
    const result = apply();
    const resultJson = serializeJson(result, "paper mutation result");
    database.prepare(`
      UPDATE paper_portfolio_mutations SET status = 'applied', result = ?, completedAt = ?
      WHERE ownerUserId = ? AND id = ? AND status = 'applying'
    `).run(resultJson, mutation.now, owner, mutation.mutationId);
      return result;
    });
  } catch (error) {
    recordRejectedMutation(database, owner, action, targetId, mutation, expected, error);
    throw error;
  }
}

function recordRejectedMutation(
  database: DatabaseSync,
  owner: string,
  action: string,
  targetId: string,
  mutation: PaperMutationIdentity,
  expected: { expectedPortfolioRevision?: number; expectedLedgerEpoch?: number; expectedBotRevision?: number },
  error: unknown
): void {
  if (!(error instanceof PaperPortfolioStoreError)) return;
  const detail = { code: error.code, message: error.message.slice(0, 512) };
  try {
    transaction(database, () => {
      const count = Number((database.prepare("SELECT COUNT(*) AS value FROM paper_portfolio_mutations WHERE ownerUserId = ?").get(owner) as { value: number }).value);
      if (count >= PAPER_MUTATION_RECEIPT_LIMIT_PER_OWNER) return;
      database.prepare(`
        INSERT OR IGNORE INTO paper_portfolio_mutations
          (ownerUserId, id, idempotencyKey, requestHash, action, targetId,
           expectedPortfolioRevision, expectedLedgerEpoch, expectedBotRevision,
           status, result, createdAt, completedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'rejected', ?, ?, ?)
      `).run(
        owner, mutation.mutationId, mutation.idempotencyKey, mutation.requestHash, action, targetId,
        expected.expectedPortfolioRevision ?? null, expected.expectedLedgerEpoch ?? null,
        expected.expectedBotRevision ?? null, serializeJson({ error: detail }, "paper rejection receipt"), mutation.now, mutation.now
      );
    });
  } catch {
    // Preserve the original domain/database error even if receipt persistence
    // itself is unavailable. No lifecycle state survived the savepoint.
  }
}

function requirePortfolio(database: DatabaseSync, owner: string, id: string, expectedRevision?: number): PaperPortfolio {
  const portfolio = getPaperPortfolioFrom(database, owner, id);
  if (!portfolio) fail("NOT_FOUND", `Paper portfolio ${id} was not found`);
  if (expectedRevision !== undefined && portfolio.revision !== expectedRevision) fail("REVISION_CONFLICT", "Paper portfolio revision changed");
  return portfolio;
}

function requireEpoch(database: DatabaseSync, owner: string, portfolio: string, epoch: number): PaperPortfolioEpoch {
  const value = getPaperPortfolioEpochFrom(database, owner, portfolio, epoch);
  if (!value) fail("EPOCH_NOT_FOUND", "Paper portfolio epoch was not found");
  return value;
}

function requireAllocation(
  database: DatabaseSync, owner: string, portfolio: string, epoch: number, botId: string, botRevision: number
): PaperBotAllocation {
  const row = database.prepare(`
    SELECT * FROM paper_bot_allocations WHERE ownerUserId = ? AND portfolioId = ?
      AND ledgerEpoch = ? AND botId = ? AND botRevision = ?
  `).get(owner, portfolio, epoch, botId, botRevision) as unknown as AllocationRow | undefined;
  if (!row) fail("ALLOCATION_NOT_FOUND", "Paper bot allocation was not found");
  return allocationFromRow(row);
}

function clearDefault(database: DatabaseSync, owner: string, now: number): void {
  database.prepare(`
    UPDATE paper_portfolios SET isDefault = 0, revision = revision + 1, updatedAt = ?
    WHERE ownerUserId = ? AND status = 'active' AND isDefault = 1
  `).run(now, owner);
}

function promoteOldestDefault(database: DatabaseSync, owner: string, now: number): void {
  const row = database.prepare(`
    SELECT id FROM paper_portfolios WHERE ownerUserId = ? AND status = 'active'
    ORDER BY createdAt ASC, id ASC LIMIT 1
  `).get(owner) as { id: string } | undefined;
  if (row) database.prepare(`UPDATE paper_portfolios SET isDefault = 1, revision = revision + 1, updatedAt = ? WHERE ownerUserId = ? AND id = ?`)
    .run(now, owner, row.id);
}
