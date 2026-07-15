/// <reference lib="webworker" />
import type { Candle } from "../types";
import type { BacktestConfig } from "./backtest";
import type { StrategyIR } from "./ir";
import type { SecurityDataContext } from "./securityData";
import {
  optimizeGenetic,
  type GeneticOptimizeResult,
  type GeneticOptimizeSpec,
  type GeneticProgress
} from "./geneticOptimizer";
import {
  optimize,
  walkForward,
  type OptimizeResult,
  type OptimizeSpec,
  type WalkForwardOptions,
  type WalkForwardResult
} from "./optimizer";

/**
 * Module worker that runs the (heavy, synchronous) optimizer off the main
 * thread so the UI never freezes. It streams progress back as it grinds and
 * posts the final result. The compute itself lives in optimizer.ts — this file
 * is only the transport shell. Kept side-effect free at import time apart from
 * wiring the message handler.
 */

export interface OptimizeRequest {
  kind: "optimize";
  ir: StrategyIR;
  candles: Candle[];
  config: BacktestConfig;
  spec: OptimizeSpec;
  securityData?: SecurityDataContext;
}

export interface WalkForwardRequest {
  kind: "walkforward";
  ir: StrategyIR;
  candles: Candle[];
  config: BacktestConfig;
  spec: OptimizeSpec;
  options: WalkForwardOptions;
  securityData?: SecurityDataContext;
}

export interface GeneticOptimizeRequest {
  kind: "genetic";
  ir: StrategyIR;
  candles: Candle[];
  config: BacktestConfig;
  spec: GeneticOptimizeSpec;
  securityData?: SecurityDataContext;
}

export type WorkerRequest = OptimizeRequest | WalkForwardRequest | GeneticOptimizeRequest;

export type WorkerResponse =
  | { kind: "progress"; done: number; total: number; genetic?: GeneticProgress }
  | { kind: "optimize-result"; result: OptimizeResult }
  | { kind: "walkforward-result"; result: WalkForwardResult }
  | { kind: "genetic-result"; result: GeneticOptimizeResult }
  | { kind: "error"; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  try {
    const onProgress = (done: number, total: number) => {
      const msg: WorkerResponse = { kind: "progress", done, total };
      ctx.postMessage(msg);
    };
    if (req.kind === "optimize") {
      const result = optimize(req.ir, req.candles, req.config, req.spec, onProgress, req.securityData);
      const msg: WorkerResponse = { kind: "optimize-result", result };
      ctx.postMessage(msg);
    } else if (req.kind === "walkforward") {
      const result = walkForward(req.ir, req.candles, req.config, req.spec, req.options, onProgress, req.securityData);
      const msg: WorkerResponse = { kind: "walkforward-result", result };
      ctx.postMessage(msg);
    } else if (req.kind === "genetic") {
      const result = optimizeGenetic(req.ir, req.candles, req.config, req.spec, {
        onProgress: (progress) => {
          if (progress.processed % progress.populationSize !== 0 && progress.processed !== progress.total) return;
          const msg: WorkerResponse = { kind: "progress", done: progress.processed, total: progress.total, genetic: progress };
          ctx.postMessage(msg);
        }
      }, req.securityData);
      const msg: WorkerResponse = { kind: "genetic-result", result };
      ctx.postMessage(msg);
    }
  } catch (cause) {
    const msg: WorkerResponse = { kind: "error", message: cause instanceof Error ? cause.message : String(cause) };
    ctx.postMessage(msg);
  }
});
