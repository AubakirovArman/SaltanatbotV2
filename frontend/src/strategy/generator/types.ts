import type { StrategyIR } from "../ir";

export const GENERATOR_LIMITS = {
  minPopulation: 2,
  maxPopulation: 128,
  maxGenerations: 32,
  maxCandidates: 2_048,
  maxAttemptsPerGeneration: 8_192,
  maxMutationLogEntries: 16,
  maxIrInputs: 16,
  maxIrNodes: 160
} as const;

export type StrategyFamily = "trend" | "mean-reversion" | "breakout" | "momentum";
export type TradeDirection = "long" | "short";
export type GeneratorMaKind = "sma" | "ema" | "wma";

export type SignalGenome =
  | { family: "trend"; variant: "ma-cross"; maKind: GeneratorMaKind; fastPeriod: number; slowPeriod: number }
  | { family: "trend"; variant: "price-ma"; maKind: GeneratorMaKind; period: number }
  | { family: "mean-reversion"; variant: "rsi-reentry"; period: number; trigger: number; exitLevel: number }
  | { family: "mean-reversion"; variant: "bollinger-fade"; period: number; deviation: number }
  | { family: "breakout"; variant: "donchian"; period: number; exitPeriod: number }
  | { family: "breakout"; variant: "bollinger-break"; period: number; deviation: number }
  | { family: "momentum"; variant: "roc"; period: number; threshold: number }
  | { family: "momentum"; variant: "macd"; fastPeriod: number; slowPeriod: number; signalPeriod: number };

export interface RiskGenome {
  stopMode: "percent" | "atr";
  stopValue: number;
  targetMode: "percent" | "atr";
  targetValue: number;
  positionPct: number;
}

export interface StrategyGenome {
  direction: TradeDirection;
  signal: SignalGenome;
  risk: RiskGenome;
}

export interface MutationRecord {
  operator: "replace" | "bounded-step";
  field: string;
  from: string | number;
  to: string | number;
}

export interface CandidateValidationFlags {
  schemaVersion: boolean;
  finiteInputs: boolean;
  boundedInputs: boolean;
  supportedGrammar: boolean;
  entryAndExit: boolean;
  riskControls: boolean;
  withinNodeBudget: boolean;
}

export interface CandidateValidation {
  valid: boolean;
  flags: CandidateValidationFlags;
  issues: string[];
}

export interface GenerationProvenance {
  engine: "bounded-grammar-v1";
  seed: number;
  generation: number;
  origin: "seed" | "mutation" | "crossover" | "crossover-mutation";
  parentFingerprints: string[];
  mutationLog: MutationRecord[];
}

export interface GeneratedStrategyCandidate {
  fingerprint: string;
  ir: StrategyIR;
  genome: StrategyGenome;
  provenance: GenerationProvenance;
  validation: CandidateValidation;
}

export interface StrategyGeneratorSpec {
  seed?: number;
  populationSize?: number;
  generations?: number;
  families?: readonly StrategyFamily[];
  directions?: readonly TradeDirection[];
  crossoverRate?: number;
  mutationRate?: number;
}

export interface ResolvedGeneratorConfig {
  seed: number;
  populationSize: number;
  generations: number;
  families: StrategyFamily[];
  directions: TradeDirection[];
  crossoverRate: number;
  mutationRate: number;
  targetCandidates: number;
}

export interface GeneratorProgress {
  phase: "seed" | "evolve";
  generation: number;
  generations: number;
  accepted: number;
  targetCandidates: number;
  attempts: number;
  duplicates: number;
}

export interface GeneratorRuntimeOptions {
  signal?: AbortSignal;
  onProgress?: (progress: GeneratorProgress) => void;
}

export interface StrategyGenerationResult {
  candidates: GeneratedStrategyCandidate[];
  config: ResolvedGeneratorConfig;
  attempts: number;
  duplicates: number;
  exhausted: boolean;
}

export interface EvaluationMetrics {
  netProfitPct: number;
  sharpe: number;
  profitFactor: number;
  maxDrawdownPct: number;
  trades: number;
  liquidated: boolean;
}

export interface MarketEvaluation {
  marketId: string;
  train: EvaluationMetrics;
  outOfSample: EvaluationMetrics;
}

export interface CandidateEvaluationSet {
  candidateFingerprint: string;
  markets: readonly MarketEvaluation[];
}

export interface MultiMarketRankingPolicy {
  minMarkets: number;
  minTradesPerWindow: number;
  trainWeight: number;
  outOfSampleWeight: number;
  netProfitWeight: number;
  sharpeWeight: number;
  profitFactorWeight: number;
  drawdownPenalty: number;
  tradeShortfallPenalty: number;
  liquidationPenalty: number;
  generalizationGapPenalty: number;
  outOfSampleLossPenalty: number;
  crossMarketDispersionPenalty: number;
  losingMarketPenalty: number;
  medianWeight: number;
  worstMarketWeight: number;
}

export interface MarketScore {
  marketId: string;
  trainScore: number;
  outOfSampleScore: number;
  generalizationPenalty: number;
  outOfSampleLossPenalty: number;
  total: number;
}

export interface RankingValidationFlags {
  hasRequiredMarkets: boolean;
  uniqueMarkets: boolean;
  finiteMetrics: boolean;
  enoughTrades: boolean;
  noLiquidations: boolean;
  majorityOutOfSampleProfitable: boolean;
}

export interface RankingValidation {
  valid: boolean;
  flags: RankingValidationFlags;
  issues: string[];
}

export interface RankedCandidateEvaluation {
  candidateFingerprint: string;
  score: number;
  marketScores: MarketScore[];
  aggregate: {
    median: number;
    worstMarket: number;
    dispersion: number;
    dispersionPenalty: number;
    losingMarketPenalty: number;
  };
  validation: RankingValidation;
}
