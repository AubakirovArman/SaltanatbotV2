import type * as Blockly from "blockly/core";
import { DEFAULT_PORTFOLIO_BACKTEST_CONFIG, type PortfolioBacktestConfig, type PortfolioBacktestResult } from "@saltanatbotv2/backtest-core";
import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { runBacktest, previewStrategy, DEFAULT_CONFIG, type BacktestConfig, type BacktestResult, type PlotSeries, type ShapeOverlays } from "./backtest";
import { loadCandleHistory } from "./candleHistory";
import { compileWorkspace } from "./compile";
import type { StrategyIR } from "./ir";
import { type OptimizeResult, type WalkForwardResult } from "./optimizer";
import type { GeneticOptimizeResult, GeneticProgress } from "./geneticOptimizer";
import { runGeneticOptimizeInWorker, runOptimizeInWorker, runWalkForwardInWorker } from "./optimizerClient";
import { buildSpec, initOptSpec, type OptSpecState } from "./optimization/model";
import type { SecurityDataContext } from "./securityData";
import { loadSecurityDataForIr } from "./securityLoader";
import { runPortfolioResearch, uniqueSymbols } from "./portfolioResearch";
import type { Candle, DataExchange, Timeframe } from "../types";
import { applyOptimizedInputs } from "./applyOptimizedInputs";

interface UseStrategyResearchOptions {
  workspaceRef: RefObject<Blockly.WorkspaceSvg | null>;
  strategyInputs: StrategyIR["inputs"];
  initialSymbol: string;
  initialTimeframe: Timeframe;
  exchange: DataExchange;
  onApplyResult?: (result: BacktestResult, symbol: string, timeframe: Timeframe, visuals: { plots: PlotSeries[]; shapes: ShapeOverlays } | undefined, exchange: DataExchange) => void;
}

interface OptimizationEvidence {
  ir: StrategyIR;
  irSignature: string;
  candles: Candle[];
  securityData: SecurityDataContext;
  config: BacktestConfig;
  exchange: DataExchange;
  symbol: string;
  timeframe: Timeframe;
  bars: number;
}

export function useStrategyResearch(options: UseStrategyResearchOptions) {
  const [errors, setErrors] = useState<string[]>([]);
  const [result, setResult] = useState<BacktestResult>();
  const [portfolioResult, setPortfolioResult] = useState<PortfolioBacktestResult>();
  const [config, setConfig] = useState<BacktestConfig>(DEFAULT_CONFIG);
  const [symbol, setSymbol] = useState(options.initialSymbol);
  const [timeframe, setTimeframe] = useState<Timeframe>(options.initialTimeframe);
  const [bars, setBars] = useState(1_000);
  const [portfolioEnabled, setPortfolioEnabled] = useState(false);
  const [portfolioSymbols, setPortfolioSymbols] = useState<string[]>([]);
  const [portfolioConfig, setPortfolioConfig] = useState<PortfolioBacktestConfig>({
    ...DEFAULT_PORTFOLIO_BACKTEST_CONFIG
  });
  const [running, setRunning] = useState(false);
  const [optOpen, setOptOpen] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [optProgress, setOptProgress] = useState({ done: 0, total: 0 });
  const [optSpec, setOptSpec] = useState<OptSpecState | null>(null);
  const [optimizeResult, setOptimizeResult] = useState<OptimizeResult>();
  const [optimizationMode, setOptimizationMode] = useState<"grid" | "genetic">("grid");
  const [geneticResult, setGeneticResult] = useState<GeneticOptimizeResult>();
  const [geneticProgress, setGeneticProgress] = useState<GeneticProgress>();
  const [geneticConfig, setGeneticConfig] = useState({ populationSize: 48, generations: 30, mutationRate: 0.15, seed: 42 });
  const [walkForwardOn, setWalkForwardOn] = useState(false);
  const [optFolds, setOptFolds] = useState(4);
  const [walkForwardMode, setWalkForwardMode] = useState<"rolling" | "anchored">("rolling");
  const [walkForwardResult, setWalkForwardResult] = useState<WalkForwardResult>();
  const optimizationEvidenceRef = useRef<OptimizationEvidence>();
  const operationRef = useRef(0);
  const abortRef = useRef<AbortController>();
  const exchangeRef = useRef(options.exchange);

  const inputKey = options.strategyInputs.map((input) => input.name).join("|");
  useEffect(() => {
    setOptSpec(options.strategyInputs.length > 0 ? initOptSpec({ name: "", inputs: options.strategyInputs, body: [] }) : null);
    // Only reset ranges when the set of named inputs changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey]);

  useEffect(
    () => () => {
      operationRef.current += 1;
      abortRef.current?.abort();
    },
    []
  );

  const beginOperation = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const id = ++operationRef.current;
    return { id, signal: controller.signal };
  };
  const isCurrent = (id: number) => operationRef.current === id;

  const clearOptimizationEvidence = () => {
    optimizationEvidenceRef.current = undefined;
    setOptimizeResult(undefined);
    setGeneticResult(undefined);
    setGeneticProgress(undefined);
    setWalkForwardResult(undefined);
  };

  const invalidateResearchScope = () => {
    operationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = undefined;
    setRunning(false);
    setOptimizing(false);
    setResult(undefined);
    setPortfolioResult(undefined);
    setOptProgress({ done: 0, total: 0 });
    clearOptimizationEvidence();
  };

  useEffect(() => {
    if (exchangeRef.current === options.exchange) return;
    exchangeRef.current = options.exchange;
    invalidateResearchScope();
    // The exchange is the complete dependency: the invalidation helper always
    // uses the current refs and React state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.exchange]);

  const cancelOptimization = () => {
    if (!optimizing) return;
    operationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = undefined;
    setOptimizing(false);
    setOptProgress({ done: 0, total: 0 });
    clearOptimizationEvidence();
  };

  const invalidateOptimizerConfiguration = () => {
    if (optimizing) cancelOptimization();
    else clearOptimizationEvidence();
  };

  const updateConfig: Dispatch<SetStateAction<BacktestConfig>> = (next) => {
    invalidateResearchScope();
    setConfig(next);
  };
  const updateSymbol: Dispatch<SetStateAction<string>> = (next) => {
    invalidateResearchScope();
    setSymbol(next);
  };
  const updateTimeframe: Dispatch<SetStateAction<Timeframe>> = (next) => {
    invalidateResearchScope();
    setTimeframe(next);
  };
  const updateBars: Dispatch<SetStateAction<number>> = (next) => {
    invalidateResearchScope();
    setBars(next);
  };
  const updateOptSpec: Dispatch<SetStateAction<OptSpecState | null>> = (next) => {
    invalidateOptimizerConfiguration();
    setOptSpec(next);
  };
  const updateOptimizationMode = (next: "grid" | "genetic") => {
    invalidateOptimizerConfiguration();
    setOptimizationMode(next);
  };
  const updateGeneticConfig: Dispatch<SetStateAction<typeof geneticConfig>> = (next) => {
    invalidateOptimizerConfiguration();
    setGeneticConfig(next);
  };

  const loadHistory = (signal: AbortSignal) =>
    loadCandleHistory({
      symbol,
      timeframe,
      bars,
      exchange: options.exchange,
      signal
    });

  const run = async () => {
    const workspace = options.workspaceRef.current;
    if (!workspace || running || optimizing) return;
    const compiled = compileWorkspace(workspace);
    if (!compiled.ir || compiled.errors.length > 0) {
      setErrors(compiled.errors.length > 0 ? compiled.errors : ["Nothing to run."]);
      setResult(undefined);
      setPortfolioResult(undefined);
      return;
    }
    const operation = beginOperation();
    setErrors([]);
    setRunning(true);
    try {
      if (portfolioEnabled) {
        const symbols = uniqueSymbols([symbol, ...portfolioSymbols]);
        const portfolio = await runPortfolioResearch({
          ir: compiled.ir,
          symbols,
          timeframe,
          bars,
          exchange: options.exchange,
          backtestConfig: config,
          portfolioConfig: { ...portfolioConfig, initialCapital: config.initialCapital },
          signal: operation.signal
        });
        if (!isCurrent(operation.id)) return;
        setPortfolioResult(portfolio);
        setResult(undefined);
        setOptimizeResult(undefined);
        setGeneticResult(undefined);
        return;
      }
      const candles = await loadHistory(operation.signal);
      if (!isCurrent(operation.id)) return;
      if (candles.length < 30) {
        setErrors(["Not enough history for this market/interval."]);
        return;
      }
      const securityData = await loadSecurityDataForIr(compiled.ir, {
        symbol,
        timeframe,
        chartCandles: candles,
        exchange: options.exchange,
        signal: operation.signal
      });
      if (!isCurrent(operation.id)) return;
      const backtest = runBacktest(compiled.ir, candles, config, securityData, reportContext());
      const visuals = previewStrategy(compiled.ir, candles, securityData);
      if (!isCurrent(operation.id)) return;
      setResult(backtest);
      setPortfolioResult(undefined);
      setOptimizeResult(undefined);
      setGeneticResult(undefined);
      options.onApplyResult?.(backtest, symbol, timeframe, { plots: visuals.plots, shapes: visuals.shapes }, options.exchange);
    } catch (cause) {
      if (isCurrent(operation.id) && !operation.signal.aborted) {
        setErrors([cause instanceof Error ? cause.message : "History request failed."]);
      }
    } finally {
      if (isCurrent(operation.id)) setRunning(false);
    }
  };

  const optimize = async () => {
    const workspace = options.workspaceRef.current;
    if (!workspace || running || optimizing) return;
    const compiled = compileWorkspace(workspace);
    if (!compiled.ir || compiled.errors.length > 0 || compiled.ir.inputs.length === 0 || !optSpec) {
      setErrors(compiled.errors.length > 0 ? compiled.errors : ["This strategy has no numeric inputs to optimize."]);
      return;
    }
    const spec = buildSpec(optSpec, optimizationMode === "genetic" ? 12 : 3);
    if (spec.params.length === 0) {
      setErrors(["Pick at least one input to sweep."]);
      return;
    }
    const operation = beginOperation();
    const evidenceScope = { symbol, timeframe, bars, exchange: options.exchange, config: { ...config } };
    setErrors([]);
    setOptimizing(true);
    setOptProgress({ done: 0, total: 0 });
    setResult(undefined);
    setPortfolioResult(undefined);
    setOptimizeResult(undefined);
    setGeneticResult(undefined);
    setGeneticProgress(undefined);
    setWalkForwardResult(undefined);
    try {
      const candles = await loadHistory(operation.signal);
      if (!isCurrent(operation.id)) return;
      if (candles.length < 60) {
        setErrors(["Need at least 60 bars to split into in-sample / out-of-sample."]);
        return;
      }
      const securityData = await loadSecurityDataForIr(compiled.ir, {
        symbol,
        timeframe,
        chartCandles: candles,
        exchange: options.exchange,
        signal: operation.signal
      });
      if (!isCurrent(operation.id)) return;
      const evidence: OptimizationEvidence = {
        ir: compiled.ir,
        irSignature: JSON.stringify(compiled.ir),
        candles,
        securityData,
        ...evidenceScope
      };
      const onProgress = (done: number, total: number) => {
        if (isCurrent(operation.id)) setOptProgress({ done, total });
      };
      if (optimizationMode === "grid" && walkForwardOn) {
        const walkForward = await runWalkForwardInWorker(compiled.ir, candles, config, spec, { folds: optFolds, mode: walkForwardMode }, onProgress, securityData, operation.signal);
        if (!isCurrent(operation.id)) return;
        setWalkForwardResult(walkForward);
      }
      if (optimizationMode === "genetic") {
        const optimized = await runGeneticOptimizeInWorker(
          compiled.ir,
          candles,
          config,
          {
            params: spec.params,
            trainFrac: spec.trainFrac,
            populationSize: geneticConfig.populationSize,
            generations: geneticConfig.generations,
            mutationRate: geneticConfig.mutationRate,
            seed: geneticConfig.seed
          },
          (progress) => {
            if (!isCurrent(operation.id)) return;
            setGeneticProgress(progress);
            setOptProgress({ done: progress.processed, total: progress.total });
          },
          securityData,
          operation.signal
        );
        if (isCurrent(operation.id)) {
          optimizationEvidenceRef.current = evidence;
          setGeneticResult(optimized);
        }
      } else {
        const optimized = await runOptimizeInWorker(compiled.ir, candles, config, spec, onProgress, securityData, operation.signal);
        if (isCurrent(operation.id)) {
          optimizationEvidenceRef.current = evidence;
          setOptimizeResult(optimized);
        }
      }
    } catch (cause) {
      if (isCurrent(operation.id) && !operation.signal.aborted) {
        setErrors([cause instanceof Error ? cause.message : "Optimization failed."]);
      }
    } finally {
      if (isCurrent(operation.id)) setOptimizing(false);
    }
  };

  const applyCombo = (params: Record<string, number>) => {
    const workspace = options.workspaceRef.current;
    const evidence = optimizationEvidenceRef.current;
    if (!workspace || !evidence) {
      setErrors(["Optimization evidence is no longer current. Run the optimizer again."]);
      clearOptimizationEvidence();
      return;
    }
    const current = compileWorkspace(workspace);
    if (!current.ir || current.errors.length > 0 || JSON.stringify(current.ir) !== evidence.irSignature) {
      setErrors(["The strategy changed after optimization. Run the optimizer again before applying parameters."]);
      clearOptimizationEvidence();
      return;
    }
    try {
      applyOptimizedInputs(workspace, params);
      const applied = compileWorkspace(workspace);
      if (!applied.ir || applied.errors.length > 0 || Object.entries(params).some(([name, value]) => applied.ir?.inputs.find((input) => input.name === name)?.value !== value)) {
        throw new Error("The optimized parameters could not be verified in the strategy workspace.");
      }
      const backtest = runBacktest(applied.ir, evidence.candles, evidence.config, evidence.securityData, reportContext(evidence));
      const visuals = previewStrategy(applied.ir, evidence.candles, evidence.securityData);
      setErrors([]);
      setResult(backtest);
      setPortfolioResult(undefined);
      clearOptimizationEvidence();
      options.onApplyResult?.(backtest, evidence.symbol, evidence.timeframe, { plots: visuals.plots, shapes: visuals.shapes }, evidence.exchange);
    } catch (cause) {
      setErrors([cause instanceof Error ? cause.message : "Optimized parameters could not be applied."]);
      clearOptimizationEvidence();
    }
  };

  const clearResult = () => {
    invalidateResearchScope();
  };

  return {
    errors,
    setErrors,
    result,
    portfolioResult,
    clearResult,
    config,
    setConfig: updateConfig,
    symbol,
    setSymbol: updateSymbol,
    timeframe,
    setTimeframe: updateTimeframe,
    bars,
    setBars: updateBars,
    portfolioEnabled,
    setPortfolioEnabled,
    portfolioSymbols,
    setPortfolioSymbols,
    portfolioConfig,
    setPortfolioConfig,
    running,
    run,
    optOpen,
    setOptOpen,
    optimizing,
    optProgress,
    optSpec,
    setOptSpec: updateOptSpec,
    optimizeResult,
    optimizationMode,
    setOptimizationMode: updateOptimizationMode,
    geneticConfig,
    setGeneticConfig: updateGeneticConfig,
    geneticResult,
    geneticProgress,
    walkForwardOn,
    setWalkForwardOn,
    optFolds,
    setOptFolds,
    walkForwardMode,
    setWalkForwardMode,
    walkForwardResult,
    optimize,
    cancelOptimization,
    applyCombo
  };

  function reportContext(scope: Pick<OptimizationEvidence, "symbol" | "timeframe" | "bars" | "exchange"> = { symbol, timeframe, bars, exchange: options.exchange }) {
    return {
      symbol: scope.symbol,
      timeframe: scope.timeframe,
      exchange: scope.exchange,
      marketType: "linear" as const,
      priceType: "trade" as const,
      requestedBars: scope.bars
    };
  }
}
