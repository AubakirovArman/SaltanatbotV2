/// <reference lib="webworker" />
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
}

export interface WalkForwardRequest {
  kind: "walkforward";
  ir: StrategyIR;
  candles: Candle[];
  config: BacktestConfig;
  spec: OptimizeSpec;
  options: WalkForwardOptions;
}

export type WorkerRequest = OptimizeRequest | WalkForwardRequest;

export type WorkerResponse =
  | { kind: "progress"; done: number; total: number }
  | { kind: "optimize-result"; result: OptimizeResult }
  | { kind: "walkforward-result"; result: WalkForwardResult }
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
      const result = optimize(req.ir, req.candles, req.config, req.spec, onProgress);
      const msg: WorkerResponse = { kind: "optimize-result", result };
      ctx.postMessage(msg);
    } else if (req.kind === "walkforward") {
      const result = walkForward(req.ir, req.candles, req.config, req.spec, req.options, onProgress);
      const msg: WorkerResponse = { kind: "walkforward-result", result };
      ctx.postMessage(msg);
    }
  } catch (cause) {
    const msg: WorkerResponse = { kind: "error", message: cause instanceof Error ? cause.message : String(cause) };
    ctx.postMessage(msg);
  }
});
