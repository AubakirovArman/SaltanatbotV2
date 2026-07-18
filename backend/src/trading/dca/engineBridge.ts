import { PAPER_FILL_MODEL_V1 } from "@saltanatbotv2/execution-core";
import type { Candle } from "../../types.js";
import type { RunningBot } from "../engineRuntime.js";
import { pauseRunningBot } from "../engineState.js";
import { notify } from "../notifications.js";
import { tradingOwnerForBot } from "../ownership.js";
import { getOrderJournal, getSetting, setSetting } from "../store.js";
import type { BotConfig, ExecOrder, ExecResult } from "../types.js";
import { recoverDcaObservations, runDcaClosedBar, toDcaObservations, type DcaRuntimeDeps } from "./runtime.js";
import {
  dcaStateSettingsKey,
  initialDcaState,
  parseDcaStateSnapshotV1,
  type DcaFillObservationV1,
  type DcaStateV1
} from "./types.js";

/** In-memory machine attachment for one running DCA robot. */
export interface EngineDcaRuntime {
  state: DcaStateV1;
  lastTransitionKey?: string;
  /** Fills reconciled from the durable order journal at restart, not yet consumed. */
  recovered: DcaFillObservationV1[];
}

export interface EngineDcaHooks {
  execute: (order: ExecOrder) => Promise<ExecResult>;
  /** Engine fill-accounting boundary shared with strategy executions. */
  applyResult: (result: ExecResult, order: ExecOrder) => void;
  log: (level: "info" | "warn" | "error", message: string) => void;
  stop: () => void;
}

/**
 * Closed-bar dispatcher for `kind === "dca"` robots. The first bar after a
 * restart restores the machine from its settings snapshot and reconciles
 * pending transitions against the order journal, so a mid-cycle robot resumes
 * exactly where the ledger left it. Any execution failure pauses the robot
 * (fail closed) instead of guessing at the exchange state.
 */
export async function runEngineDcaBar(bot: RunningBot, closed: Candle, hooks: EngineDcaHooks): Promise<void> {
  const config = bot.config;
  try {
    const params = config.dca;
    if (config.kind !== "dca" || !params) throw new Error("DCA dispatch requires dca-params-v1 in the robot config");
    if (config.exchange !== "paper") throw new Error("DCA robots are research-only and run on the paper exchange");
    const deps: DcaRuntimeDeps = {
      botId: config.id,
      symbol: config.symbol,
      market: config.market,
      ledgerEpoch: config.paperLedgerEpoch ?? 1,
      params,
      fillModel: PAPER_FILL_MODEL_V1,
      execute: async (order) => {
        const result = await hooks.execute(order);
        hooks.applyResult(result, order);
        return result;
      },
      getOrder: (id) => getOrderJournal(config.id, id),
      saveSnapshot: (snapshot) => setSetting(dcaStateSettingsKey(config.id), snapshot)
    };
    if (!bot.dca) bot.dca = await loadEngineDcaRuntime(config, deps);
    const runtime = bot.dca;
    if (runtime.state.phase === "stopped") return;
    const queued = bot.dcaPendingFills?.splice(0) ?? [];
    const observations = [...runtime.recovered.splice(0), ...toDcaObservations(queued)];
    const result = await runDcaClosedBar(runtime.state, closed, observations, deps, runtime.lastTransitionKey);
    runtime.state = result.state;
    runtime.lastTransitionKey = result.lastTransitionKey;
    if (result.state.phase === "stopped") {
      const reason = result.state.stopReason ?? "DCA cycle reached a terminal stop.";
      hooks.log("warn", reason);
      void notify({ ownerUserId: tradingOwnerForBot(config), event: "error", bot: config.name, symbol: config.symbol, text: reason }).catch(() => undefined);
      hooks.stop();
    }
  } catch (error) {
    // Drop the in-memory machine: after an operator resume the next closed bar
    // reloads the durable snapshot and re-reconciles it with the order journal.
    bot.dca = undefined;
    const reason = `DCA execution failed closed: ${error instanceof Error ? error.message : error}`;
    pauseRunningBot(bot, reason);
    hooks.log("error", reason);
  }
}

async function loadEngineDcaRuntime(config: BotConfig, deps: DcaRuntimeDeps): Promise<EngineDcaRuntime> {
  const raw = getSetting<unknown>(dcaStateSettingsKey(config.id));
  if (raw === undefined) return { state: initialDcaState(), recovered: [] };
  const snapshot = parseDcaStateSnapshotV1(raw);
  if (snapshot.botId !== config.id) throw new Error("Persisted DCA state belongs to another robot");
  // A new ledger epoch (portfolio reset) starts from a clean machine state.
  if (snapshot.ledgerEpoch !== deps.ledgerEpoch) return { state: initialDcaState(), recovered: [] };
  return {
    state: snapshot.state,
    lastTransitionKey: snapshot.idempotencyKey,
    recovered: await recoverDcaObservations(snapshot.state, deps)
  };
}
