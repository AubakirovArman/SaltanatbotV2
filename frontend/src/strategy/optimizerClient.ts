import type { Candle } from "../types";
import type { BacktestConfig } from "./backtest";
import type { StrategyIR } from "./ir";
import type { SecurityDataContext } from "./securityData";
import { GeneticOptimizationAbortedError, type GeneticOptimizeResult, type GeneticOptimizeSpec, type GeneticProgress } from "./geneticOptimizer";
import { optimize, walkForward, type OptimizeResult, type OptimizeSpec, type WalkForwardOptions, type WalkForwardResult } from "./optimizer";
import type { WorkerRequest, WorkerResponse } from "./optimizer.worker";

/**
 * Promise-based client for the optimizer worker. Runs the heavy sweep off the
 * main thread when Worker + module-worker support is available. Grid and
 * walk-forward retain their bounded compatibility fallback. Genetic search is
 * intentionally worker-only so its visible cancel control can always be
 * serviced instead of freezing the browser event loop.
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

export function runOptimizeInWorker(ir: StrategyIR, candles: Candle[], config: BacktestConfig, spec: OptimizeSpec, onProgress?: Progress, securityData?: SecurityDataContext, signal?: AbortSignal): Promise<OptimizeResult> {
  if (signal?.aborted) return Promise.reject(new GeneticOptimizationAbortedError());
  const worker = makeWorker();
  if (!worker) {
    // No worker available — run synchronously on the main thread.
    return Promise.resolve().then(() => optimize(ir, candles, config, spec, onProgress, securityData));
  }
  return new Promise<OptimizeResult>((resolve, reject) => {
    const abort = () => {
      worker.terminate();
      reject(new GeneticOptimizationAbortedError());
    };
    signal?.addEventListener("abort", abort, { once: true });
    const finish = () => signal?.removeEventListener("abort", abort);
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (msg.kind === "progress") onProgress?.(msg.done, msg.total);
      else if (msg.kind === "optimize-result") {
        finish();
        resolve(msg.result);
        worker.terminate();
      } else if (msg.kind === "error") {
        finish();
        reject(new Error(msg.message));
        worker.terminate();
      }
    };
    worker.onerror = (event) => {
      // Worker crashed (e.g. import failure) — fall back to the main thread.
      worker.terminate();
      finish();
      if (signal?.aborted) {
        reject(new GeneticOptimizationAbortedError());
        return;
      }
      try {
        resolve(optimize(ir, candles, config, spec, onProgress, securityData));
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(event.message ?? cause)));
      }
    };
    const req: WorkerRequest = { kind: "optimize", ir, candles, config, spec, securityData };
    worker.postMessage(req);
  });
}

export function runWalkForwardInWorker(ir: StrategyIR, candles: Candle[], config: BacktestConfig, spec: OptimizeSpec, options: WalkForwardOptions, onProgress?: Progress, securityData?: SecurityDataContext, signal?: AbortSignal): Promise<WalkForwardResult> {
  if (signal?.aborted) return Promise.reject(new GeneticOptimizationAbortedError());
  const worker = makeWorker();
  if (!worker) {
    return Promise.resolve().then(() => walkForward(ir, candles, config, spec, options, onProgress, securityData));
  }
  return new Promise<WalkForwardResult>((resolve, reject) => {
    const abort = () => {
      worker.terminate();
      reject(new GeneticOptimizationAbortedError());
    };
    signal?.addEventListener("abort", abort, { once: true });
    const finish = () => signal?.removeEventListener("abort", abort);
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (msg.kind === "progress") onProgress?.(msg.done, msg.total);
      else if (msg.kind === "walkforward-result") {
        finish();
        resolve(msg.result);
        worker.terminate();
      } else if (msg.kind === "error") {
        finish();
        reject(new Error(msg.message));
        worker.terminate();
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      finish();
      if (signal?.aborted) {
        reject(new GeneticOptimizationAbortedError());
        return;
      }
      try {
        resolve(walkForward(ir, candles, config, spec, options, onProgress, securityData));
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(event.message ?? cause)));
      }
    };
    const req: WorkerRequest = { kind: "walkforward", ir, candles, config, spec, options, securityData };
    worker.postMessage(req);
  });
}

export function runGeneticOptimizeInWorker(ir: StrategyIR, candles: Candle[], config: BacktestConfig, spec: GeneticOptimizeSpec, onProgress?: (progress: GeneticProgress) => void, securityData?: SecurityDataContext, signal?: AbortSignal): Promise<GeneticOptimizeResult> {
  if (signal?.aborted) return Promise.reject(new GeneticOptimizationAbortedError());
  const worker = makeWorker();
  if (!worker) {
    return Promise.reject(new Error("Genetic optimization requires Web Worker support in this browser."));
  }
  return new Promise<GeneticOptimizeResult>((resolve, reject) => {
    const abort = () => {
      worker.terminate();
      reject(new GeneticOptimizationAbortedError());
    };
    signal?.addEventListener("abort", abort, { once: true });
    const finish = () => signal?.removeEventListener("abort", abort);
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.kind === "progress" && message.genetic) onProgress?.(message.genetic);
      else if (message.kind === "genetic-result") {
        finish();
        worker.terminate();
        resolve(message.result);
      } else if (message.kind === "error") {
        finish();
        worker.terminate();
        reject(new Error(message.message));
      }
    };
    worker.onerror = (event) => {
      finish();
      worker.terminate();
      if (signal?.aborted) {
        reject(new GeneticOptimizationAbortedError());
        return;
      }
      reject(new Error(event.message || "The genetic optimizer worker failed."));
    };
    const request: WorkerRequest = { kind: "genetic", ir, candles, config, spec, securityData };
    worker.postMessage(request);
  });
}

function generationProgress(callback: ((progress: GeneticProgress) => void) | undefined) {
  if (!callback) return undefined;
  return (progress: GeneticProgress) => {
    if (progress.processed % progress.populationSize === 0 || progress.processed === progress.total) callback(progress);
  };
}
