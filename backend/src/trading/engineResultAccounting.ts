import { commitExecutionFill } from "./executionCommit.js";
import type { RunningBot } from "./engineRuntime.js";
import { persistPaper } from "./engineState.js";
import { listOrderJournal } from "./store.js";
import type { AccountState, ExecOrder, ExecResult, FillRecord, PositionState } from "./types.js";

interface ResultCallbacks {
  log(level: "info" | "error", message: string): void;
  fill(fill: FillRecord, account?: AccountState, position?: PositionState | null): void;
  state(account?: AccountState, position?: PositionState | null): void;
}

export interface EngineResultAccounting {
  committedFills: FillRecord[];
  duplicateFills: FillRecord[];
  failures: Array<{ fill: FillRecord; error: Error }>;
}

export function applyEngineResult(bot: RunningBot, result: ExecResult, order: ExecOrder, callbacks: ResultCallbacks): EngineResultAccounting {
  const committedFills: FillRecord[] = [];
  const duplicateFills: FillRecord[] = [];
  const failures: EngineResultAccounting["failures"] = [];
  let journal = listOrderJournal(bot.config.id, 500).find((candidate) => (
    (order.clientId !== undefined && candidate.clientId === order.clientId)
    || (order.orderId !== undefined && candidate.exchangeOrderId === order.orderId)
  ));
  for (const fill of result.fills) {
    if (!journal) {
      const error = new Error(`Execution ${fill.id} has no durable order identity`);
      failures.push({ fill, error });
      callbacks.log("error", `${error.message}; accounting remains fail-closed.`);
      continue;
    }
    try {
      const committed = commitExecutionFill(journal, fill);
      journal = committed.record;
      if (committed.inserted) {
        committedFills.push(fill);
        callbacks.fill(fill, result.account, result.position);
      } else if (committed.alreadyAccounted) {
        duplicateFills.push(fill);
      }
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      failures.push({ fill, error: normalized });
      callbacks.log("error", `Execution ${fill.id} accounting failed: ${normalized.message}`);
    }
  }
  if (result.message) callbacks.log(result.ok ? "info" : "error", result.message);
  if (bot.paper) persistPaper(bot);
  if (result.account || result.position !== undefined) callbacks.state(result.account, result.position);
  return { committedFills, duplicateFills, failures };
}
