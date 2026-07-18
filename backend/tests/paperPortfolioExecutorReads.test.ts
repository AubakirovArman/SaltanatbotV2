import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutorCommandRepository } from "../src/database/executorCommandTypes.js";
import type { IdentityService } from "../src/identity/service.js";
import type { PaperLedgerEvent } from "../src/trading/paperLedger.js";
import { appendPaperLedgerEventsTo } from "../src/trading/paperLedgerStore.js";
import {
  paperPortfolioRequestHash,
  type PaperPortfolioReadPayload
} from "../src/trading/paperPortfolioCommandContract.js";
import {
  executePaperPortfolioRead,
  paperRobotHandle,
  PAPER_TRADES_FILL_LIMIT
} from "../src/trading/paperPortfolioExecutorReads.js";
import { PaperPortfolioReadService } from "../src/trading/paperPortfolioReadService.js";
import { createPaperPortfolioIn, reserveAndBindPaperBotIn } from "../src/trading/paperPortfolioStore.js";
import { createPaperPortfolioRuntime, type PaperPortfolioRuntime } from "../src/trading/paperPortfolioRuntime.js";
import { migrateTradingStore } from "../src/trading/storeSchema.js";
import { upsertBotIntoForOwner } from "../src/trading/store.js";
import type { TradingEngine } from "../src/trading/engine.js";
import type { BotConfig, FillRecord } from "../src/trading/types.js";
import { ExecutorCommandRepositoryDouble } from "./support/executorCommandRepositoryDouble.js";

const NOW = 1_752_000_000_000;
const DAY_START = Date.UTC(
  new Date(NOW).getUTCFullYear(),
  new Date(NOW).getUTCMonth(),
  new Date(NOW).getUTCDate()
);
const SEEDED_AT = DAY_START - 7_200_000;
const OWNER = "reads-owner";
const BOT_ID = `bot-${"0123456789abcdef".repeat(2)}`;
const SESSION = "a".repeat(64);
const REVISION = 7;
const EPOCH = 11;
const databases: DatabaseSync[] = [];
const runtimes: PaperPortfolioRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const database of databases.splice(0)) database.close();
});

describe("paper portfolio executor read kinds", () => {
  it("summarizes the default portfolio with exact realized totals and the UTC-day slice", () => {
    const value = database();
    seedDefaultPortfolio(value);
    const fillYesterday = closedFill("fill-day-prev", DAY_START - 3_600_000, 10);
    const fillToday = closedFill("fill-day-current", DAY_START + 3_600_000, 5);
    appendPaperLedgerEventsTo(value, [
      fillEvent(2, fillYesterday),
      realizedCashEvent(3, fillYesterday),
      fillEvent(4, fillToday),
      realizedCashEvent(5, fillToday)
    ]);

    const result = executePaperPortfolioRead(service(value), OWNER, snapshotPayload(), NOW);

    expect(result).toMatchObject({
      schemaVersion: "paper-telegram-snapshot-v1",
      kind: "paper-portfolio.snapshot",
      portfolio: { id: "reads-portfolio", name: "Reads portfolio", ledgerEpoch: 1 },
      capital: {
        available: "90000.000000",
        reserved: "10000.000000",
        initial: "100000.000000"
      },
      realizedPnl: {
        total: "15.000000",
        utcDay: {
          status: "available",
          value: "5.000000",
          source: "paper-ledger-realized-cash"
        }
      },
      robotsTruncated: false
    });
    expect((result.robots as Record<string, unknown>[])[0]).toEqual({
      idPrefix8: "01234567",
      fullId: BOT_ID,
      botRevision: 2,
      name: "Reads bot",
      status: "stopped",
      realizedPnl: "15.000000",
      recentWinLoss: { wins: 2, losses: 0, truncated: false }
    });
    expect(paperRobotHandle("not-a-hex-identifier")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("keeps unavailable evidence unavailable and bounds trades to the newest ten fills", () => {
    const value = database();
    seedDefaultPortfolio(value);
    const events: PaperLedgerEvent[] = [];
    for (let index = 0; index < 12; index += 1) {
      const fill = openFill(index);
      events.push(fillEvent(2 + index * 2, fill), feeEvent(3 + index * 2, fill));
    }
    events.push(positionEvent(26, SEEDED_AT + 3_000));
    appendPaperLedgerEventsTo(value, events);

    const snapshot = executePaperPortfolioRead(service(value), OWNER, snapshotPayload(), NOW);
    const trades = executePaperPortfolioRead(
      service(value),
      OWNER,
      { version: 1, kind: "paper-robot.trades", botId: BOT_ID },
      NOW
    );

    expect(snapshot.equity).toMatchObject({ status: "unavailable" });
    expect(snapshot.unrealizedPnl).toMatchObject({ status: "unavailable" });
    expect(trades).toMatchObject({
      schemaVersion: "paper-telegram-trades-v1",
      kind: "paper-robot.trades",
      portfolioId: "reads-portfolio",
      robot: { idPrefix8: "01234567", fullId: BOT_ID, name: "Reads bot", status: "stopped" },
      truncated: true
    });
    const fills = trades.trades as Array<Record<string, unknown>>;
    expect(fills).toHaveLength(PAPER_TRADES_FILL_LIMIT);
    expect(fills[0]).toEqual({
      time: SEEDED_AT + 1_000 + 11,
      symbol: "BTCUSDT",
      side: "buy",
      qty: 0.001,
      price: "50000.000000"
    });
    expect(
      () => executePaperPortfolioRead(
        service(value),
        OWNER,
        { version: 1, kind: "paper-robot.trades", botId: "bot-unknown" },
        NOW
      )
    ).toThrow(/not found/i);
  });

  it("applies snapshot reads through the fenced executor without any store mutation", async () => {
    const fixture = fencedFixture();
    seedDefaultPortfolio(fixture.database);
    const payload = snapshotPayload();
    const queued = await fixture.repository.enqueue({
      ownerUserId: OWNER,
      actorUserId: OWNER,
      sessionIdHash: SESSION,
      authorizationRevision: REVISION,
      authorizationEpoch: EPOCH,
      commandType: payload.kind,
      targetType: "paper-portfolio",
      targetId: "default",
      idempotencyKey: "telegram:fp:1001",
      requestHash: paperPortfolioRequestHash(OWNER, payload),
      payload
    });

    await fixture.runtime.start();
    await waitFor(() => fixture.repository.inspect(queued.command.id)?.status === "applied");

    const applied = fixture.repository.inspect(queued.command.id);
    expect(applied).toMatchObject({
      status: "applied",
      sqliteReceiptHash: expect.stringMatching(/^[0-9a-f]{64}$/)
    });
    expect(applied?.result).toMatchObject({
      kind: "paper-portfolio.snapshot",
      portfolio: { id: "reads-portfolio" }
    });
    expect(fixture.database.prepare("SELECT COUNT(*) AS value FROM paper_portfolio_mutations").get())
      .toEqual({ value: 2 });
  });

  it("rejects a read command whose queue target does not match its payload", async () => {
    const fixture = fencedFixture();
    seedDefaultPortfolio(fixture.database);
    const payload = snapshotPayload();
    const queued = await fixture.repository.enqueue({
      ownerUserId: OWNER,
      actorUserId: OWNER,
      sessionIdHash: SESSION,
      authorizationRevision: REVISION,
      authorizationEpoch: EPOCH,
      commandType: payload.kind,
      targetType: "paper-portfolio",
      targetId: "tampered",
      idempotencyKey: "telegram:fp:1002",
      requestHash: paperPortfolioRequestHash(OWNER, payload),
      payload
    });

    await fixture.runtime.start();
    await waitFor(() => fixture.repository.inspect(queued.command.id)?.status === "rejected");

    expect(fixture.repository.inspect(queued.command.id)).toMatchObject({
      status: "rejected",
      errorCode: "invalid_command_identity"
    });
  });
});

function database(): DatabaseSync {
  const value = new DatabaseSync(":memory:");
  databases.push(value);
  migrateTradingStore(value, () => SEEDED_AT, { legacyOwnerUserId: OWNER });
  return value;
}

function service(value: DatabaseSync): PaperPortfolioReadService {
  return new PaperPortfolioReadService(value, { isRunning: () => false, isPaused: () => false });
}

function snapshotPayload(): PaperPortfolioReadPayload {
  return { version: 1, kind: "paper-portfolio.snapshot", origin: "telegram" };
}

function seedDefaultPortfolio(value: DatabaseSync): void {
  const portfolio = createPaperPortfolioIn(value, OWNER, {
    mutationId: "reads-create",
    idempotencyKey: "reads-create-key",
    requestHash: "b".repeat(64),
    now: SEEDED_AT,
    portfolioId: "reads-portfolio",
    name: "Reads portfolio",
    initialCapitalMicros: 100_000_000_000,
    makeDefault: true
  });
  const bot = upsertBotIntoForOwner(value, OWNER, paperBot());
  reserveAndBindPaperBotIn(value, OWNER, {
    mutationId: "reads-bind",
    idempotencyKey: "reads-bind-key",
    requestHash: "c".repeat(64),
    now: SEEDED_AT + 1,
    portfolioId: portfolio.id,
    expectedRevision: portfolio.revision,
    expectedLedgerEpoch: portfolio.currentEpoch,
    botId: bot.id,
    expectedBotRevision: bot.revision!,
    allocationMicros: 10_000_000_000
  });
}

function paperBot(): BotConfig {
  return {
    id: BOT_ID,
    ownerUserId: OWNER,
    accountId: `paper:${BOT_ID}`,
    name: "Reads bot",
    strategyName: "Reads strategy",
    ir: { name: "reads", inputs: [], body: [] },
    symbol: "BTCUSDT",
    timeframe: "1m",
    exchange: "paper",
    market: "futures",
    sizeMode: "quote",
    sizeValue: 100,
    leverage: 1,
    notifyMarkers: false,
    status: "stopped",
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT
  };
}

function realizedCashEvent(sequence: number, fill: FillRecord): PaperLedgerEvent {
  return {
    id: `event-cash-${sequence}`,
    botId: BOT_ID,
    ledgerEpoch: 1,
    sequence,
    type: "cash",
    data: { amount: fill.realizedPnl, reason: "realized-pnl", fillId: fill.id },
    ts: fill.ts
  };
}

function closedFill(id: string, ts: number, realizedPnl: number): FillRecord {
  return {
    id,
    botId: BOT_ID,
    symbol: "BTCUSDT",
    side: "sell",
    qty: 0.001,
    price: 50_000,
    fee: 0,
    realizedPnl,
    kind: "close",
    reason: "reads-test",
    ts
  };
}

function openFill(index: number): FillRecord {
  return {
    id: `fill-${index}`,
    botId: BOT_ID,
    symbol: "BTCUSDT",
    side: "buy",
    qty: 0.001,
    price: 50_000,
    fee: 0.05,
    realizedPnl: 0,
    kind: "open",
    reason: "reads-test",
    ts: SEEDED_AT + 1_000 + index
  };
}

function positionEvent(sequence: number, ts: number): PaperLedgerEvent {
  return {
    id: `event-position-${sequence}`,
    botId: BOT_ID,
    ledgerEpoch: 1,
    sequence,
    type: "position",
    data: {
      position: {
        symbol: "BTCUSDT",
        side: "long",
        qty: 0.012,
        entryPrice: 50_000,
        leverage: 1,
        openedAt: ts
      }
    },
    ts
  };
}

function fillEvent(sequence: number, fill: FillRecord): PaperLedgerEvent {
  return {
    id: `event-fill-${sequence}`,
    botId: BOT_ID,
    ledgerEpoch: 1,
    sequence,
    type: "fill",
    data: { fill },
    ts: fill.ts
  };
}

function feeEvent(sequence: number, fill: FillRecord): PaperLedgerEvent {
  return {
    id: `event-fee-${sequence}`,
    botId: BOT_ID,
    ledgerEpoch: 1,
    sequence,
    type: "fee",
    data: { fillId: fill.id, amount: fill.fee, asset: "USDT" },
    ts: fill.ts
  };
}

function fencedFixture() {
  const value = database();
  const repository = new ExecutorCommandRepositoryDouble(3);
  const runtime = createPaperPortfolioRuntime({
    database: value,
    engine: engineDouble(),
    executorCommands: repository as ExecutorCommandRepository,
    identityService: identityDouble(),
    workerId: "paper-reads-test"
  });
  runtimes.push(runtime);
  return { database: value, repository, runtime };
}

function identityDouble(): IdentityService {
  const user = {
    id: OWNER,
    login: OWNER,
    loginNormalized: OWNER,
    passwordHash: "test-only-password-hash",
    status: "active",
    appRole: "user",
    tradingRole: "paper-trade",
    mustChangePassword: false,
    authorizationRevision: REVISION,
    createdAt: new Date(SEEDED_AT),
    updatedAt: new Date(SEEDED_AT)
  };
  const session = {
    publicId: "11111111-1111-4111-8111-111111111111",
    idHash: SESSION,
    userId: OWNER,
    csrfHash: "d".repeat(64),
    expiresAt: new Date(Date.now() + 60_000),
    lastSeenAt: new Date(),
    createdAt: new Date()
  };
  return {
    repository: {
      findSession: vi.fn(async (hash: string) => hash === SESSION ? { session, user } : undefined)
    },
    executionAuthorizationSnapshot: vi.fn(async (ownerUserId: string) => ({
      ownerUserId,
      authorizationRevision: REVISION,
      authorizationEpoch: EPOCH,
      role: "paper-trade"
    })),
    isExecutionAuthorizationCurrent: vi.fn(() => true)
  } as unknown as IdentityService;
}

function engineDouble(): TradingEngine {
  return {
    isRunningForOwner: () => false,
    isPausedForOwner: () => false,
    async startForOwner() {},
    async pauseForOwner() { return false; },
    async confirmResumeForOwner() { return false; },
    async stopSafelyForOwner() {}
  } as unknown as TradingEngine;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for executor result");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
