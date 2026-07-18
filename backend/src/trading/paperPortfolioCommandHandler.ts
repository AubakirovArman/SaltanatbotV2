import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  parseDcaParamsV1,
  parseGridParamsV1,
  worstCaseDcaCapitalQuote,
  worstCaseGridCapitalQuote,
  type DcaParamsV1,
  type GridParamsV1
} from "@saltanatbotv2/contracts";
import { PAPER_FILL_MODEL_V1 } from "@saltanatbotv2/execution-core";
import { replayPaperLedger } from "./paperLedger.js";
import { listPaperLedgerEventsFrom } from "./paperLedgerStore.js";
import {
  parsePaperPortfolioExecutorPayload,
  type PaperPortfolioExecutorPayload
} from "./paperPortfolioCommandContract.js";
import {
  archivePaperPortfolioIn,
  createPaperPortfolioIn,
  getPaperPortfolioEpochFrom,
  getPaperPortfolioFrom,
  listPaperBotAllocationsFrom,
  recordPaperExecutorReceiptIn,
  renamePaperPortfolioIn,
  reserveAndBindPaperBotIn,
  resetPaperPortfolioIn,
  setDefaultPaperPortfolioIn
} from "./paperPortfolioStore.js";
import {
  getPaperMutationReceiptFrom
} from "./paperPortfolioEvidenceStore.js";
import {
  PAPER_MONEY_MICROS_MAX
} from "./paperPortfolioMigration.js";
import {
  PaperPortfolioStoreError,
  type PaperMutationIdentity,
  type VerifiedFlatBotEvidence
} from "./paperPortfolioStoreSupport.js";
import type { BotConfig } from "./types.js";
import { upsertBotIntoForOwner, withDatabaseTransaction } from "./store.js";
import type { StrategyIR } from "./strategy/ir.js";
import { parseStrategyIR } from "./strategy/irSchema.js";

export interface PaperPortfolioApplicationContext {
  commandId: string;
  ownerUserId: string;
  idempotencyKey: string;
  requestHash: string;
  payload: Record<string, unknown>;
}

export interface PaperPortfolioApplicationResult {
  result: Record<string, unknown>;
  sqliteReceiptHash: string;
  replayed: boolean;
}

export interface PaperPortfolioReceiptProbeContext {
  commandId: string;
  ownerUserId: string;
  idempotencyKey: string;
  requestHash: string;
}

export interface PaperPortfolioCommandRuntime {
  isRunning(ownerUserId: string, botId: string): boolean;
  isPaused(ownerUserId: string, botId: string): boolean;
  start(ownerUserId: string, bot: BotConfig): Promise<void>;
  pause(ownerUserId: string, botId: string): Promise<boolean>;
  resume(ownerUserId: string, botId: string): Promise<boolean>;
  stop(ownerUserId: string, botId: string): Promise<void>;
}

export class PaperPortfolioCommandHandler {
  constructor(
    private readonly database: DatabaseSync,
    private readonly runtime: PaperPortfolioCommandRuntime,
    private readonly now: () => number = Date.now
  ) {}

  probeAppliedReceipt(context: PaperPortfolioReceiptProbeContext): { sqliteReceiptHash: string } | undefined {
    const prior = getPaperMutationReceiptFrom(
      this.database,
      context.ownerUserId,
      context.idempotencyKey
    );
    if (
      !prior
      || prior.status !== "applied"
      || prior.ownerUserId !== context.ownerUserId
      || prior.id !== context.commandId
      || prior.idempotencyKey !== context.idempotencyKey
      || prior.requestHash !== context.requestHash
      || !prior.result
      || !isRecord(prior.result)
    ) return undefined;
    return { sqliteReceiptHash: receiptHash(prior) };
  }

  async apply(context: PaperPortfolioApplicationContext): Promise<PaperPortfolioApplicationResult> {
    const payload = parsePaperPortfolioExecutorPayload(context.payload);
    const prior = getPaperMutationReceiptFrom(this.database, context.ownerUserId, context.idempotencyKey);
    if (prior) {
      if (prior.id !== context.commandId || prior.requestHash !== context.requestHash) {
        fail("IDEMPOTENCY_CONFLICT", "Paper command identity was already used for another request");
      }
      if (prior.status === "applied" && prior.result && isRecord(prior.result)) {
        return {
          result: structuredClone(prior.result),
          sqliteReceiptHash: receiptHash(prior),
          replayed: true
        };
      }
      if (prior.status === "rejected") {
        const rejection = isRecord(prior.result) && isRecord(prior.result.error)
          ? prior.result.error
          : undefined;
        fail(
          typeof rejection?.code === "string" ? rejection.code : "MUTATION_REJECTED",
          typeof rejection?.message === "string" ? rejection.message : "Paper mutation was rejected"
        );
      }
    }
    const mutation = this.mutation(context);
    const result = await this.applyPayload(context.ownerUserId, mutation, payload);
    const receipt = getPaperMutationReceiptFrom(this.database, context.ownerUserId, context.idempotencyKey);
    if (!receipt || receipt.status !== "applied" || receipt.requestHash !== context.requestHash) {
      throw new Error("Paper executor completed without an exact durable SQLite receipt");
    }
    return {
      result: receipt.result && isRecord(receipt.result) ? structuredClone(receipt.result) : result,
      sqliteReceiptHash: receiptHash(receipt),
      replayed: prior?.status === "applied"
    };
  }

  private async applyPayload(
    ownerUserId: string,
    mutation: PaperMutationIdentity,
    payload: PaperPortfolioExecutorPayload
  ): Promise<Record<string, unknown>> {
    switch (payload.kind) {
      case "paper-portfolio.create": {
        const portfolio = createPaperPortfolioIn(this.database, ownerUserId, {
          ...mutation,
          portfolioId: payload.portfolioId,
          name: payload.name,
          initialCapitalMicros: payload.initialCapitalMicros,
          makeDefault: payload.makeDefault
        });
        return portfolioResult(portfolio.id, portfolio.revision, portfolio.currentEpoch);
      }
      case "paper-portfolio.rename": {
        const portfolio = renamePaperPortfolioIn(this.database, ownerUserId, {
          ...mutation,
          portfolioId: payload.portfolioId,
          expectedRevision: payload.expectedPortfolioRevision,
          expectedLedgerEpoch: payload.expectedLedgerEpoch,
          name: payload.name
        });
        return portfolioResult(portfolio.id, portfolio.revision, portfolio.currentEpoch);
      }
      case "paper-portfolio.default": {
        const portfolio = setDefaultPaperPortfolioIn(this.database, ownerUserId, {
          ...mutation,
          portfolioId: payload.portfolioId,
          expectedRevision: payload.expectedPortfolioRevision,
          expectedLedgerEpoch: payload.expectedLedgerEpoch
        });
        return portfolioResult(portfolio.id, portfolio.revision, portfolio.currentEpoch);
      }
      case "paper-portfolio.archive":
        return this.archive(ownerUserId, mutation, payload);
      case "paper-portfolio.reset":
        return this.reset(ownerUserId, mutation, payload);
      case "paper-robot.create":
        return this.createRobot(ownerUserId, mutation, payload);
      case "paper-robot.action":
        return this.robotAction(ownerUserId, mutation, payload);
      case "paper-portfolio.snapshot":
      case "paper-robot.trades":
        fail(
          "READ_ONLY_COMMAND",
          "Paper executor read commands are answered by the runtime and never mutate the store"
        );
    }
  }

  private createRobot(
    ownerUserId: string,
    mutation: PaperMutationIdentity,
    payload: Extract<PaperPortfolioExecutorPayload, { kind: "paper-robot.create" }>
  ): Record<string, unknown> {
    if (payload.bot.id !== payload.botId || payload.bot.accountId !== `paper:${payload.botId}`) {
      fail("BOT_BINDING_INVALID", "Paper robot identity does not match its account binding");
    }
    if (payload.bot.symbol !== payload.bot.symbol.toUpperCase()) {
      fail("BOT_CONFIG_INVALID", "Paper robot symbol must be canonical uppercase");
    }
    const strategy = this.robotStrategy(payload);
    return withDatabaseTransaction(this.database, () => {
      const { ir: _ir, dca: _dca, grid: _grid, ...base } = payload.bot;
      const bot: BotConfig = {
        ...base,
        ...strategy,
        ownerUserId,
        status: "stopped",
        createdAt: mutation.now,
        updatedAt: mutation.now
      };
      const created = upsertBotIntoForOwner(
        this.database,
        ownerUserId,
        bot,
        { maxBots: payload.maxBots }
      );
      if (created.revision !== payload.expectedBotRevision) {
        fail("BOT_REVISION_CONFLICT", "Paper robot already exists");
      }
      const bound = reserveAndBindPaperBotIn(this.database, ownerUserId, {
        ...mutation,
        portfolioId: payload.portfolioId,
        expectedRevision: payload.expectedPortfolioRevision,
        expectedLedgerEpoch: payload.expectedLedgerEpoch,
        botId: payload.botId,
        expectedBotRevision: payload.expectedBotRevision,
        allocationMicros: payload.allocationMicros
      });
      return {
        portfolioId: bound.portfolio.id,
        portfolioRevision: bound.portfolio.revision,
        ledgerEpoch: bound.portfolio.currentEpoch,
        botId: payload.botId,
        botRevision: bound.botRevision
      };
    });
  }

  /** DCA/grid robots validate shared versioned params + the worst-case reservation instead of strategy IR. */
  private robotStrategy(
    payload: Extract<PaperPortfolioExecutorPayload, { kind: "paper-robot.create" }>
  ): { kind: "dca"; dca: DcaParamsV1 } | { kind: "grid"; grid: GridParamsV1 } | { ir: StrategyIR } {
    if (payload.bot.kind === "dca") {
      let dca: DcaParamsV1;
      try {
        dca = parseDcaParamsV1(payload.bot.dca);
      } catch (error) {
        fail("BOT_CONFIG_INVALID", `Paper robot DCA parameters are invalid: ${error instanceof Error ? error.message : error}`);
      }
      this.assertWorstCaseWithinAllocation("DCA", worstCaseDcaCapitalQuote(dca, PAPER_FILL_MODEL_V1.feePct), payload.allocationMicros);
      return { kind: "dca", dca };
    }
    if (payload.bot.kind === "grid") {
      let grid: GridParamsV1;
      try {
        grid = parseGridParamsV1(payload.bot.grid);
      } catch (error) {
        fail("BOT_CONFIG_INVALID", `Paper robot grid parameters are invalid: ${error instanceof Error ? error.message : error}`);
      }
      this.assertWorstCaseWithinAllocation("grid", worstCaseGridCapitalQuote(grid, PAPER_FILL_MODEL_V1.feePct), payload.allocationMicros);
      return { kind: "grid", grid };
    }
    const ir = parseStrategyIR(payload.bot.ir);
    if (!ir.ok) fail("BOT_CONFIG_INVALID", `Paper robot strategy IR is invalid: ${ir.error}`);
    return { ir: ir.ir };
  }

  private assertWorstCaseWithinAllocation(kindLabel: string, worstCase: number, allocationMicros: number): void {
    if (Math.round(worstCase * 1_000_000) > allocationMicros) {
      fail(
        "WORST_CASE_EXCEEDS_ALLOCATION",
        `Worst-case ${kindLabel} capital ${worstCase} USDT exceeds the reserved allocation of ${allocationMicros / 1_000_000} USDT`
      );
    }
  }

  private archive(
    ownerUserId: string,
    mutation: PaperMutationIdentity,
    payload: Extract<PaperPortfolioExecutorPayload, { kind: "paper-portfolio.archive" }>
  ): Record<string, unknown> {
    const current = this.confirmedPortfolio(ownerUserId, payload.portfolioId, payload.confirmName);
    const portfolio = archivePaperPortfolioIn(this.database, ownerUserId, {
      ...mutation,
      portfolioId: current.id,
      expectedRevision: payload.expectedPortfolioRevision,
      expectedLedgerEpoch: payload.expectedLedgerEpoch
    });
    return portfolioResult(portfolio.id, portfolio.revision, portfolio.currentEpoch);
  }

  private async reset(
    ownerUserId: string,
    mutation: PaperMutationIdentity,
    payload: Extract<PaperPortfolioExecutorPayload, { kind: "paper-portfolio.reset" }>
  ): Promise<Record<string, unknown>> {
    const portfolio = this.confirmedPortfolio(ownerUserId, payload.portfolioId, payload.confirmName);
    if (portfolio.revision !== payload.expectedPortfolioRevision || portfolio.currentEpoch !== payload.expectedLedgerEpoch) {
      fail("REVISION_CONFLICT", "Paper portfolio revision or epoch changed");
    }
    const epoch = getPaperPortfolioEpochFrom(this.database, ownerUserId, portfolio.id, portfolio.currentEpoch);
    if (!epoch) fail("EPOCH_NOT_FOUND", "Paper portfolio epoch was not found");
    const allocations = listPaperBotAllocationsFrom(this.database, ownerUserId, portfolio.id, portfolio.currentEpoch)
      .filter((allocation) => allocation.status === "active");
    for (const allocation of allocations) {
      if (this.runtime.isRunning(ownerUserId, allocation.botId)) {
        await this.runtime.stop(ownerUserId, allocation.botId);
      }
    }
    const flatBots = allocations.map((allocation): VerifiedFlatBotEvidence => {
      const state = replayPaperLedger(
        listPaperLedgerEventsFrom(this.database, allocation.botId, allocation.ledgerEpoch),
        allocation.botId,
        allocation.ledgerEpoch
      );
      if (!state.initialized || state.position || state.orders.length > 0) {
        fail("OPEN_RISK", `Paper bot ${allocation.botId} must be flat with zero open orders before reset`);
      }
      return {
        botId: allocation.botId,
        botRevision: allocation.botRevision,
        positionFlat: true,
        openOrders: 0,
        returnedCapitalMicros: paperNumberToMicros(state.balance),
        checkedAt: mutation.now,
        source: "paper-ledger-replay",
        verified: true
      };
    });
    const result = resetPaperPortfolioIn(this.database, ownerUserId, {
      ...mutation,
      portfolioId: portfolio.id,
      expectedRevision: payload.expectedPortfolioRevision,
      expectedLedgerEpoch: payload.expectedLedgerEpoch,
      initialCapitalMicros: payload.initialCapitalMicros ?? epoch.initialCapitalMicros,
      flatBots
    });
    return {
      ...portfolioResult(result.portfolio.id, result.portfolio.revision, result.portfolio.currentEpoch),
      rebindRequired: result.rebindRequired
    };
  }

  private async robotAction(
    ownerUserId: string,
    mutation: PaperMutationIdentity,
    payload: Extract<PaperPortfolioExecutorPayload, { kind: "paper-robot.action" }>
  ): Promise<Record<string, unknown>> {
    const portfolio = getPaperPortfolioFrom(this.database, ownerUserId, payload.portfolioId);
    if (!portfolio) fail("NOT_FOUND", "Paper portfolio was not found");
    if (
      portfolio.status !== "active"
      || portfolio.revision !== payload.expectedPortfolioRevision
      || portfolio.currentEpoch !== payload.expectedLedgerEpoch
    ) fail("REVISION_CONFLICT", "Paper portfolio revision or epoch changed");
    const allocation = listPaperBotAllocationsFrom(
      this.database,
      ownerUserId,
      portfolio.id,
      portfolio.currentEpoch
    ).find((item) => item.botId === payload.botId && item.botRevision === payload.expectedBotRevision);
    if (!allocation || allocation.status !== "active") fail("ALLOCATION_NOT_ACTIVE", "Paper robot has no active capital reservation");
    const bot = currentBoundBot(
      this.database,
      ownerUserId,
      payload.botId,
      payload.expectedBotRevision,
      portfolio.id,
      portfolio.currentEpoch,
      allocation.reservedCapitalMicros
    );

    switch (payload.action) {
      case "start":
        if (!this.runtime.isRunning(ownerUserId, bot.id)) await this.runtime.start(ownerUserId, bot);
        break;
      case "pause":
        if (!this.runtime.isRunning(ownerUserId, bot.id)) fail("BOT_NOT_RUNNING", "Paper robot is not running");
        if (!this.runtime.isPaused(ownerUserId, bot.id) && !(await this.runtime.pause(ownerUserId, bot.id))) {
          fail("PAUSE_FAILED", "Paper robot could not be paused");
        }
        break;
      case "resume":
        if (!this.runtime.isRunning(ownerUserId, bot.id)) fail("BOT_NOT_RUNNING", "Paper robot is not running");
        if (this.runtime.isPaused(ownerUserId, bot.id) && !(await this.runtime.resume(ownerUserId, bot.id))) {
          fail("RESUME_FAILED", "Paper robot could not be resumed");
        }
        break;
      case "stop":
        if (this.runtime.isRunning(ownerUserId, bot.id)) await this.runtime.stop(ownerUserId, bot.id);
        break;
    }
    const result = {
      ...portfolioResult(portfolio.id, portfolio.revision, portfolio.currentEpoch),
      botId: bot.id,
      botRevision: payload.expectedBotRevision,
      action: payload.action
    };
    recordPaperExecutorReceiptIn(this.database, ownerUserId, {
      ...mutation,
      portfolioId: portfolio.id,
      ledgerEpoch: portfolio.currentEpoch,
      result
    });
    return result;
  }

  private confirmedPortfolio(ownerUserId: string, portfolioId: string, confirmName: string) {
    const portfolio = getPaperPortfolioFrom(this.database, ownerUserId, portfolioId);
    if (!portfolio) fail("NOT_FOUND", "Paper portfolio was not found");
    if (portfolio.name !== confirmName) fail("CONFIRMATION_MISMATCH", "Portfolio name confirmation does not match");
    return portfolio;
  }

  private mutation(context: PaperPortfolioApplicationContext): PaperMutationIdentity {
    return {
      mutationId: context.commandId,
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash,
      now: this.now()
    };
  }
}

function currentBoundBot(
  database: DatabaseSync,
  ownerUserId: string,
  botId: string,
  revision: number,
  portfolioId: string,
  ledgerEpoch: number,
  allocationMicros: number
): BotConfig {
  const row = database.prepare(`
    SELECT config, revision FROM bots WHERE ownerUserId = ? AND id = ?
  `).get(ownerUserId, botId) as { config: string; revision: number } | undefined;
  if (!row || row.revision !== revision) fail("BOT_REVISION_CONFLICT", "Paper robot revision changed");
  let bot: BotConfig;
  try { bot = JSON.parse(row.config) as BotConfig; } catch { fail("BOT_CONFIG_INVALID", "Paper robot configuration is invalid"); }
  if (
    bot.exchange !== "paper"
    || bot.paperPortfolioId !== portfolioId
    || bot.paperLedgerEpoch !== ledgerEpoch
    || bot.paperAllocationMicros !== allocationMicros
  ) {
    fail("BOT_BINDING_INVALID", "Paper robot portfolio binding is invalid");
  }
  return { ...bot, ownerUserId, revision: row.revision };
}

function paperNumberToMicros(value: number): number {
  if (!Number.isFinite(value) || value < 0) fail("INVALID_MONEY", "Paper balance is invalid");
  const micros = Math.round(value * 1_000_000);
  if (
    !Number.isSafeInteger(micros)
    || micros > PAPER_MONEY_MICROS_MAX
    || Math.abs(value - micros / 1_000_000) > 1e-9
  ) fail("INVALID_MONEY", "Paper balance is not representable in fixed USDT micros");
  return micros;
}

function portfolioResult(portfolioId: string, portfolioRevision: number, ledgerEpoch: number): Record<string, unknown> {
  return { portfolioId, portfolioRevision, ledgerEpoch };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function receiptHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string): never {
  throw new PaperPortfolioStoreError(code, message);
}
