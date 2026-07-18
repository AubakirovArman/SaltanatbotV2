import { PAPER_FILL_MODEL_V1 } from "@saltanatbotv2/execution-core";
import type { Candle } from "../types.js";
import { recoverDcaObservations, runDcaClosedBar, toDcaObservations, type DcaRuntimeDeps } from "./dca/runtime.js";
import {
  initialDcaState,
  parseDcaStateSnapshotV1,
  type DcaFillObservationV1,
  type DcaStateSnapshotV1
} from "./dca/types.js";
import { paperFillBehavior, paperStartBalance } from "./engineAdapters.js";
import { PaperAdapter, type PaperState } from "./exchange/paper.js";
import { OrderLifecycle, type OrderLifecycleWriter } from "./orderLifecycle.js";
import { replayPaperLedger, type PaperLedgerEvent, type PaperLedgerState } from "./paperLedger.js";
import { botTradingAccountId } from "./tradingAccounts.js";
import type { BotConfig, FillRecord, OrderEventRecord, OrderJournalRecord } from "./types.js";

/**
 * Deterministic golden-replay harness: drives the REAL engine order path
 * (PaperAdapter + OrderLifecycle + PaperLedgerController) bar by bar over
 * in-memory stores. The injected clock advances with bar time and every id is
 * derived from (botId, bar, ordinal), so the same candle path always produces
 * a byte-identical ledger event stream. R6 drives DCA robots; the strategy
 * evaluator joins in R7. Shipped in src for reuse by tests and later releases.
 */
export interface GoldenReplayJournal {
  orders: OrderJournalRecord[];
  events: OrderEventRecord[];
}

/** Durable artifacts of a previous drive, replayed to resume mid-cycle. */
export interface GoldenReplayResume {
  ledgerEvents: readonly PaperLedgerEvent[];
  dcaSnapshot?: DcaStateSnapshotV1;
  journal?: GoldenReplayJournal;
}

export interface GoldenReplayOptions {
  /** Deterministic clock; defaults to the current bar's open time. */
  now?: () => number;
  /** Deterministic identity source; defaults to `<botId>:<barTime>:<ordinal>`. */
  createId?: () => string;
  resume?: GoldenReplayResume;
}

export interface GoldenReplayResult {
  events: PaperLedgerEvent[];
  finalState: PaperState;
  /** Independent fail-closed replay of the recorded events. */
  projection: PaperLedgerState;
  dcaSnapshot?: DcaStateSnapshotV1;
  journal: GoldenReplayJournal;
}

export async function drive(
  candles: readonly Candle[],
  botConfig: BotConfig,
  options: GoldenReplayOptions = {}
): Promise<GoldenReplayResult> {
  const config = structuredClone(botConfig);
  const params = config.dca;
  if (config.kind !== "dca" || !params) throw new Error("Golden replay drives DCA robots in R6; strategy robots arrive with R7");
  if (config.exchange !== "paper") throw new Error("Golden replay only drives the paper exchange");
  assertCandlePath(candles);

  const botId = config.id;
  const ledgerEpoch = config.paperLedgerEpoch ?? 1;
  const accountId = botTradingAccountId(config);
  let barTime = candles[0]?.time ?? 1;
  let idOrdinal = 0;
  let price = 0;
  const now = options.now ?? (() => barTime);
  const createId = options.createId ?? (() => `${botId}:${barTime}:${++idOrdinal}`);

  const journal = createJournalStore(options.resume?.journal);
  const lifecycle = new OrderLifecycle(journal.writer, { now, createId });
  const adapter = new PaperAdapter({
    botId,
    ledgerEpoch,
    accountId,
    market: config.market,
    startBalance: paperStartBalance(config),
    feePct: PAPER_FILL_MODEL_V1.feePct,
    slipPct: PAPER_FILL_MODEL_V1.slipPct,
    fillBehavior: paperFillBehavior(config),
    getPrice: () => price,
    now,
    createId,
    initialEvents: options.resume ? structuredClone([...options.resume.ledgerEvents]) : undefined
  });

  let state = initialDcaState();
  let lastKey: string | undefined;
  let lastSnapshot: DcaStateSnapshotV1 | undefined;
  if (options.resume?.dcaSnapshot) {
    const snapshot = parseDcaStateSnapshotV1(options.resume.dcaSnapshot);
    if (snapshot.botId !== botId || snapshot.ledgerEpoch !== ledgerEpoch) {
      throw new Error("Golden replay resume snapshot belongs to another robot or ledger epoch");
    }
    state = snapshot.state;
    lastKey = snapshot.idempotencyKey;
    lastSnapshot = snapshot;
  }
  const deps: DcaRuntimeDeps = {
    botId,
    symbol: config.symbol,
    market: config.market,
    ledgerEpoch,
    params,
    fillModel: PAPER_FILL_MODEL_V1,
    execute: (order) => lifecycle.execute({ botId, accountId, exchange: "paper", market: config.market, barTime }, order, () => adapter.execute(order)),
    getOrder: (id) => journal.get(botId, id),
    saveSnapshot: (snapshot) => { lastSnapshot = snapshot; }
  };

  let observations: DcaFillObservationV1[] = options.resume ? await recoverDcaObservations(state, deps) : [];
  for (const candle of candles) {
    barTime = candle.time;
    idOrdinal = 0;
    price = candle.close;
    const triggered = adapter.onPrice(config.symbol, candle.close);
    for (const fill of triggered) recordTriggerFill(journal, lifecycle, botId, fill);
    observations.push(...toDcaObservations(triggered));
    const result = await runDcaClosedBar(state, candle, observations, deps, lastKey);
    state = result.state;
    lastKey = result.lastTransitionKey;
    observations = [];
  }

  const events = adapter.getLedgerEvents();
  return {
    events,
    finalState: adapter.getState(),
    projection: replayPaperLedger(events, botId, ledgerEpoch),
    dcaSnapshot: lastSnapshot ? structuredClone(lastSnapshot) : undefined,
    journal: journal.export()
  };
}

interface JournalStore {
  writer: OrderLifecycleWriter;
  get(botId: string, id: string): OrderJournalRecord | undefined;
  export(): GoldenReplayJournal;
}

function createJournalStore(initial?: GoldenReplayJournal): JournalStore {
  const orders = new Map<string, OrderJournalRecord>();
  const events: OrderEventRecord[] = structuredClone(initial?.events ?? []);
  for (const record of initial?.orders ?? []) orders.set(`${record.botId}:${record.id}`, structuredClone(record));
  return {
    writer: {
      upsertOrder: (record) => { orders.set(`${record.botId}:${record.id}`, structuredClone(record)); },
      insertEvent: (event) => { events.push(structuredClone(event)); },
      getOrder: (botId, id) => structuredClone(orders.get(`${botId}:${id}`)),
      listEvents: (botId, orderId) => structuredClone(events.filter((event) => event.botId === botId && event.orderId === orderId))
    },
    get: (botId, id) => structuredClone(orders.get(`${botId}:${id}`)),
    export: () => structuredClone({ orders: [...orders.values()], events })
  };
}

/** Mirror of the engine's price-event journal accounting for trigger fills. */
function recordTriggerFill(journal: JournalStore, lifecycle: OrderLifecycle, botId: string, fill: FillRecord): void {
  if (!fill.clientId || !(fill.qty > 0)) return;
  const record = journal.get(botId, fill.clientId);
  if (record) lifecycle.recordFill(record, fill);
}

function assertCandlePath(candles: readonly Candle[]): void {
  let previous = 0;
  for (const candle of candles) {
    if (
      !Number.isSafeInteger(candle.time)
      || candle.time <= previous
      || ![candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(value) && value > 0)
      || candle.low > Math.min(candle.open, candle.close)
      || candle.high < Math.max(candle.open, candle.close)
    ) {
      throw new Error("Golden replay requires a strictly ascending, well-formed candle path");
    }
    previous = candle.time;
  }
}
