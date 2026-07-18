import { PAPER_FILL_MODEL_V1 } from "@saltanatbotv2/execution-core";
import type { Candle } from "../../types.js";
import type { RunningBot } from "../engineRuntime.js";
import { pauseRunningBot } from "../engineState.js";
import { notify } from "../notifications.js";
import { tradingOwnerForBot } from "../ownership.js";
import { getOrderJournal, getSetting, setSetting } from "../store.js";
import type { BotConfig, ExecOrder, ExecResult } from "../types.js";
import { recoverGridObservations, runGridClosedBar, toGridObservations, type GridRuntimeDeps } from "./runtime.js";
import {
  gridStateSettingsKey,
  initialGridState,
  parseGridStateSnapshotV1,
  type GridFillObservationV1,
  type GridStateV1
} from "./types.js";

/** In-memory machine attachment for one running grid robot. */
export interface EngineGridRuntime {
  state: GridStateV1;
  lastTransitionKey?: string;
  /** Fills reconciled from the durable order journal at restart, not yet consumed. */
  recovered: GridFillObservationV1[];
}

export interface EngineGridHooks {
  execute: (order: ExecOrder) => Promise<ExecResult>;
  /** Engine fill-accounting boundary shared with strategy executions. */
  applyResult: (result: ExecResult, order: ExecOrder) => void;
  log: (level: "info" | "warn" | "error", message: string) => void;
  stop: () => void;
}

/**
 * Closed-bar dispatcher for `kind === "grid"` robots. The first bar after a
 * restart restores the machine from its settings snapshot and reconciles
 * pending transitions against the order journal, so a mid-ladder robot resumes
 * exactly where the ledger left it without duplicating level orders. Any
 * execution failure pauses the robot (fail closed) instead of guessing at the
 * exchange state.
 */
export async function runEngineGridBar(bot: RunningBot, closed: Candle, hooks: EngineGridHooks): Promise<void> {
  const config = bot.config;
  try {
    const params = config.grid;
    if (config.kind !== "grid" || !params) throw new Error("Grid dispatch requires grid-params-v1 in the robot config");
    if (config.exchange !== "paper") throw new Error("Grid robots are research-only and run on the paper exchange");
    const deps: GridRuntimeDeps = {
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
      saveSnapshot: (snapshot) => setSetting(gridStateSettingsKey(config.id), snapshot)
    };
    if (!bot.grid) bot.grid = await loadEngineGridRuntime(config, deps);
    const runtime = bot.grid;
    if (runtime.state.phase === "stopped") return;
    const queued = bot.gridPendingFills?.splice(0) ?? [];
    const observations = [...runtime.recovered.splice(0), ...toGridObservations(queued)];
    const result = await runGridClosedBar(runtime.state, closed, observations, deps, runtime.lastTransitionKey);
    runtime.state = result.state;
    runtime.lastTransitionKey = result.lastTransitionKey;
    if (result.state.phase === "stopped") {
      const reason = result.state.stopReason ?? "Grid reached a terminal stop.";
      hooks.log("warn", reason);
      void notify({ ownerUserId: tradingOwnerForBot(config), event: "error", bot: config.name, symbol: config.symbol, text: reason }).catch(() => undefined);
      hooks.stop();
    }
  } catch (error) {
    // Drop the in-memory machine: after an operator resume the next closed bar
    // reloads the durable snapshot and re-reconciles it with the order journal.
    bot.grid = undefined;
    const reason = `Grid execution failed closed: ${error instanceof Error ? error.message : error}`;
    pauseRunningBot(bot, reason);
    hooks.log("error", reason);
  }
}

async function loadEngineGridRuntime(config: BotConfig, deps: GridRuntimeDeps): Promise<EngineGridRuntime> {
  const raw = getSetting<unknown>(gridStateSettingsKey(config.id));
  if (raw === undefined) return { state: initialGridState(), recovered: [] };
  const snapshot = parseGridStateSnapshotV1(raw);
  if (snapshot.botId !== config.id) throw new Error("Persisted grid state belongs to another robot");
  // A new ledger epoch (portfolio reset) starts from a clean machine state.
  if (snapshot.ledgerEpoch !== deps.ledgerEpoch) return { state: initialGridState(), recovered: [] };
  return {
    state: snapshot.state,
    lastTransitionKey: snapshot.idempotencyKey,
    recovered: await recoverGridObservations(snapshot.state, deps)
  };
}
