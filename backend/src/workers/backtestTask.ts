import { parentPort } from "node:worker_threads";
import { runBacktest } from "@saltanatbotv2/backtest-core";
import { compactBacktestReport, parseBacktestTask } from "./backtestProtocol.js";

if (!parentPort) throw new Error("Backtest task must run in a worker thread");

parentPort.once("message", (input: unknown) => {
  try {
    const task = parseBacktestTask(input);
    const report = runBacktest(task.strategy, task.candles, task.config, undefined, task.context);
    parentPort!.postMessage({ ok: true, result: compactBacktestReport(report) });
  } catch (error) {
    parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
