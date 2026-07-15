import { evaluateOptionsParity } from "./evaluate.js";
import type { OptionsParityEngineOptions, OptionsParityEvaluationRequest } from "./types.js";

/** Transport-free research engine. It cannot place orders and retains no account state. */
export class OptionsParityResearchEngine {
  private readonly now: () => number;
  private readonly options: OptionsParityEngineOptions;

  constructor(options: OptionsParityEngineOptions = {}) {
    this.now = options.now ?? Date.now;
    this.options = { ...(options.limits ? { limits: { ...options.limits } } : {}) };
  }

  evaluate(request: Omit<OptionsParityEvaluationRequest, "evaluatedAt"> & { evaluatedAt?: number }) {
    return evaluateOptionsParity({
      ...request,
      evaluatedAt: request.evaluatedAt ?? this.now(),
      limits: { ...this.options.limits, ...request.limits }
    });
  }
}
