import type { Candle } from "../types";
import type { BacktestConfig } from "./backtest";
import type { StrategyIR } from "./ir";
import {
  optimize,
  walkForward,
  type OptimizeResult,
  type OptimizeSpec,
  type WalkForwardOptions,
  type WalkForwardResult
} from "./optimizer";
import type { WorkerRequest, WorkerResponse } from "./optimizer.worker";

/**
 * Promise-based client for the optimizer worker. Runs the heavy sweep off the
 * main thread when Worker + module-worker support is available; otherwise falls
 * back to running the pure `optimize` / `walkForward` on the main thread so the
 * feature still works everywhere (tests, SSR, old browsers). The core is
 * identical either way — only the thread differs.
 */

type Progress = (done: number, total: number) => void;

/** Spawn the module worker via Vite's supported `new URL(...)` import syntax. */
function makeWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  try {
    return new Worker(new URL("./optimizer.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
}

export function runOptimizeInWorker(
  ir: StrategyIR,
  candles: Candle[],
  config: BacktestConfig,
  spec: OptimizeSpec,
  onProgress?: Progress
): Promise<OptimizeResult> {
  const worker = makeWorker();
  if (!worker) {
    // No worker available — run synchronously on the main thread.
    return Promise.resolve().then(() => optimize(ir, candles, config, spec, onProgress));
  }
  return new Promise<OptimizeResult>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (msg.kind === "progress") onProgress?.(msg.done, msg.total);
      else if (msg.kind === "optimize-result") { resolve(msg.result); worker.terminate(); }
      else if (msg.kind === "error") { reject(new Error(msg.message)); worker.terminate(); }
    };
    worker.onerror = (event) => {
      // Worker crashed (e.g. import failure) — fall back to the main thread.
      worker.terminate();
      try {
        resolve(optimize(ir, candles, config, spec, onProgress));
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(event.message ?? cause)));
      }
    };
    const req: WorkerRequest = { kind: "optimize", ir, candles, config, spec };
    worker.postMessage(req);
  });
}

export function runWalkForwardInWorker(
  ir: StrategyIR,
  candles: Candle[],
  config: BacktestConfig,
  spec: OptimizeSpec,
  options: WalkForwardOptions,
  onProgress?: Progress
): Promise<WalkForwardResult> {
  const worker = makeWorker();
  if (!worker) {
    return Promise.resolve().then(() => walkForward(ir, candles, config, spec, options, onProgress));
  }
  return new Promise<WalkForwardResult>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (msg.kind === "progress") onProgress?.(msg.done, msg.total);
      else if (msg.kind === "walkforward-result") { resolve(msg.result); worker.terminate(); }
      else if (msg.kind === "error") { reject(new Error(msg.message)); worker.terminate(); }
    };
    worker.onerror = (event) => {
      worker.terminate();
      try {
        resolve(walkForward(ir, candles, config, spec, options, onProgress));
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(event.message ?? cause)));
      }
    };
    const req: WorkerRequest = { kind: "walkforward", ir, candles, config, spec, options };
    worker.postMessage(req);
  });
}
