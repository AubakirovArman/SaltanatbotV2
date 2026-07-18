import { Worker } from "node:worker_threads";

/**
 * Bounded promise adapter over the EXISTING backtestTask worker-thread
 * protocol: one thread per run, one message in ({strategy, candles, config,
 * context}), one envelope out ({ok, result|error}). In-process research job
 * kinds (multi-market evaluation) use it to keep CPU-heavy backtests off the
 * research worker's main thread while candle fetches stay in-process (R5.2
 * lesson: worker_threads have no network access here).
 */

export const BACKTEST_THREAD_RUN_TIMEOUT_MS = 60_000;
const BACKTEST_THREAD_MEMORY_MB = 512;

export interface BacktestThreadRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface BacktestThreadRunner {
  run(task: Record<string, unknown>, options?: BacktestThreadRunOptions): Promise<Record<string, unknown>>;
}

export function createBacktestThreadRunner(options: { workerEntry?: URL; memoryMb?: number } = {}): BacktestThreadRunner {
  const workerEntry = options.workerEntry ?? new URL("./backtestTask.js", import.meta.url);
  const memoryMb = options.memoryMb ?? BACKTEST_THREAD_MEMORY_MB;
  return {
    run(task, runOptions = {}) {
      return new Promise((resolve, reject) => {
        const worker = new Worker(workerEntry, {
          resourceLimits: { maxOldGenerationSizeMb: memoryMb, stackSizeMb: 8 }
        });
        let settled = false;
        const finish = (operation: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          runOptions.signal?.removeEventListener("abort", onAbort);
          void worker.terminate().catch(() => undefined);
          operation();
        };
        const onAbort = () => finish(() => reject(new Error("Backtest run was aborted.")));
        const timeout = setTimeout(
          () => finish(() => reject(new Error("Backtest run exceeded its time limit."))),
          runOptions.timeoutMs ?? BACKTEST_THREAD_RUN_TIMEOUT_MS
        );
        timeout.unref?.();
        worker.once("message", (message: unknown) => {
          if (isSuccessEnvelope(message)) finish(() => resolve(message.result));
          else finish(() => reject(new Error(failureMessage(message))));
        });
        worker.once("error", (error) => finish(() => reject(error)));
        worker.once("exit", (code) => {
          if (!settled) finish(() => reject(new Error(`Backtest worker exited before returning a result (code ${code}).`)));
        });
        if (runOptions.signal?.aborted) {
          onAbort();
          return;
        }
        runOptions.signal?.addEventListener("abort", onAbort, { once: true });
        try {
          worker.postMessage(task);
        } catch (error) {
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        }
      });
    }
  };
}

function isSuccessEnvelope(value: unknown): value is { ok: true; result: Record<string, unknown> } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { ok?: unknown; result?: unknown };
  return candidate.ok === true && !!candidate.result && typeof candidate.result === "object" && !Array.isArray(candidate.result);
}

function failureMessage(value: unknown): string {
  if (!value || typeof value !== "object") return "Backtest worker returned an invalid response.";
  const error = (value as { error?: unknown }).error;
  return typeof error === "string" && error.length > 0 ? error.slice(0, 4_000) : "Backtest failed.";
}
