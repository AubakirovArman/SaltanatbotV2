import type * as Blockly from "blockly/core";
import { useEffect, useRef, useState, type RefObject } from "react";
import { runBacktest, previewStrategy, DEFAULT_CONFIG, type BacktestConfig, type BacktestResult, type PlotSeries, type ShapeOverlays } from "./backtest";
import { loadCandleHistory } from "./candleHistory";
import { compileWorkspace } from "./compile";
import type { StrategyIR } from "./ir";
import { cloneWithInputs, type OptimizeResult, type WalkForwardResult } from "./optimizer";
import { runOptimizeInWorker, runWalkForwardInWorker } from "./optimizerClient";
import { buildSpec, initOptSpec, type OptSpecState } from "./optimization/model";
import type { SecurityDataContext } from "./securityData";
import { loadSecurityDataForIr } from "./securityLoader";
import type { Candle, DataExchange, Timeframe } from "../types";

interface UseStrategyResearchOptions {
  workspaceRef: RefObject<Blockly.WorkspaceSvg | null>;
  strategyInputs: StrategyIR["inputs"];
  initialSymbol: string;
  initialTimeframe: Timeframe;
  exchange: DataExchange;
  onApplyResult?: (
    result: BacktestResult,
    symbol: string,
    timeframe: Timeframe,
    visuals?: { plots: PlotSeries[]; shapes: ShapeOverlays }
  ) => void;
}

export function useStrategyResearch(options: UseStrategyResearchOptions) {
  const [errors, setErrors] = useState<string[]>([]);
  const [result, setResult] = useState<BacktestResult>();
  const [config, setConfig] = useState<BacktestConfig>(DEFAULT_CONFIG);
  const [symbol, setSymbol] = useState(options.initialSymbol);
  const [timeframe, setTimeframe] = useState<Timeframe>(options.initialTimeframe);
  const [bars, setBars] = useState(1_000);
  const [running, setRunning] = useState(false);
  const [optOpen, setOptOpen] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [optProgress, setOptProgress] = useState({ done: 0, total: 0 });
  const [optSpec, setOptSpec] = useState<OptSpecState | null>(null);
  const [optimizeResult, setOptimizeResult] = useState<OptimizeResult>();
  const [walkForwardOn, setWalkForwardOn] = useState(false);
  const [optFolds, setOptFolds] = useState(4);
  const [walkForwardResult, setWalkForwardResult] = useState<WalkForwardResult>();
  const optCandlesRef = useRef<Candle[]>([]);
  const optIrRef = useRef<StrategyIR>();
  const optSecurityRef = useRef<SecurityDataContext>({});
  const operationRef = useRef(0);
  const abortRef = useRef<AbortController>();

  const inputKey = options.strategyInputs.map((input) => input.name).join("|");
  useEffect(() => {
    setOptSpec(options.strategyInputs.length > 0
      ? initOptSpec({ name: "", inputs: options.strategyInputs, body: [] })
      : null);
    // Only reset ranges when the set of named inputs changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey]);

  useEffect(() => () => {
    operationRef.current += 1;
    abortRef.current?.abort();
  }, []);

  const beginOperation = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const id = ++operationRef.current;
    return { id, signal: controller.signal };
  };
  const isCurrent = (id: number) => operationRef.current === id;

  const loadHistory = (signal: AbortSignal) => loadCandleHistory({
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
      return;
    }
    const operation = beginOperation();
    setErrors([]);
    setRunning(true);
    try {
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
      const backtest = runBacktest(compiled.ir, candles, config, securityData);
      const visuals = previewStrategy(compiled.ir, candles, securityData);
      if (!isCurrent(operation.id)) return;
      setResult(backtest);
      setOptimizeResult(undefined);
      options.onApplyResult?.(backtest, symbol, timeframe, { plots: visuals.plots, shapes: visuals.shapes });
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
    const spec = buildSpec(optSpec);
    if (spec.params.length === 0) {
      setErrors(["Pick at least one input to sweep."]);
      return;
    }
    const operation = beginOperation();
    setErrors([]);
    setOptimizing(true);
    setOptProgress({ done: 0, total: 0 });
    setResult(undefined);
    setOptimizeResult(undefined);
    setWalkForwardResult(undefined);
    try {
      const candles = await loadHistory(operation.signal);
      if (!isCurrent(operation.id)) return;
      if (candles.length < 60) {
        setErrors(["Need at least 60 bars to split into in-sample / out-of-sample."]);
        return;
      }
      optCandlesRef.current = candles;
      optIrRef.current = compiled.ir;
      const securityData = await loadSecurityDataForIr(compiled.ir, {
        symbol,
        timeframe,
        chartCandles: candles,
        exchange: options.exchange,
        signal: operation.signal
      });
      if (!isCurrent(operation.id)) return;
      optSecurityRef.current = securityData;
      const onProgress = (done: number, total: number) => {
        if (isCurrent(operation.id)) setOptProgress({ done, total });
      };
      if (walkForwardOn) {
        const walkForward = await runWalkForwardInWorker(compiled.ir, candles, config, spec, { folds: optFolds }, onProgress, securityData);
        if (!isCurrent(operation.id)) return;
        setWalkForwardResult(walkForward);
      }
      const optimized = await runOptimizeInWorker(compiled.ir, candles, config, spec, onProgress, securityData);
      if (isCurrent(operation.id)) setOptimizeResult(optimized);
    } catch (cause) {
      if (isCurrent(operation.id) && !operation.signal.aborted) {
        setErrors([cause instanceof Error ? cause.message : "Optimization failed."]);
      }
    } finally {
      if (isCurrent(operation.id)) setOptimizing(false);
    }
  };

  const applyCombo = (params: Record<string, number>) => {
    const ir = optIrRef.current;
    const candles = optCandlesRef.current;
    if (!ir || candles.length === 0) return;
    const cloned = cloneWithInputs(ir, params);
    const securityData = optSecurityRef.current;
    const backtest = runBacktest(cloned, candles, config, securityData);
    const visuals = previewStrategy(cloned, candles, securityData);
    setResult(backtest);
    setOptimizeResult(undefined);
    options.onApplyResult?.(backtest, symbol, timeframe, { plots: visuals.plots, shapes: visuals.shapes });
  };

  const clearResult = () => {
    operationRef.current += 1;
    abortRef.current?.abort();
    setRunning(false);
    setOptimizing(false);
    setResult(undefined);
  };

  return {
    errors, setErrors, result, clearResult,
    config, setConfig, symbol, setSymbol, timeframe, setTimeframe, bars, setBars,
    running, run, optOpen, setOptOpen, optimizing, optProgress, optSpec, setOptSpec,
    optimizeResult, walkForwardOn, setWalkForwardOn, optFolds, setOptFolds,
    walkForwardResult, optimize, applyCombo
  };
}
