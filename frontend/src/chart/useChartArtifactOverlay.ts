import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { BacktestResult } from "../strategy/backtest";
import type { StrategyArtifact } from "../strategy/library";
import type { Candle, DataExchange, Timeframe } from "../types";
import type { ChartMarker, ChartPlot, ChartShapes, ChartTable, ChartTrade } from "./types";

export interface StrategyChartOverlay {
  id?: string;
  name: string;
  signals: ChartMarker[];
  trades: ChartTrade[];
  plots?: ChartPlot[];
  shapes?: ChartShapes;
  tables?: ChartTable[];
  inputs?: { name: string; value: number }[];
  summary?: string;
  symbol: string;
  timeframe: Timeframe;
}

export interface BuildOverlayRequest {
  artifact: StrategyArtifact;
  overrides: Record<string, number>;
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  exchange: DataExchange;
}

export interface BuiltArtifactOverlay {
  overlay: StrategyChartOverlay;
  focusTime: number;
}

export type ArtifactOverlayBuilder = (request: BuildOverlayRequest) => Promise<BuiltArtifactOverlay | undefined>;

interface UseChartArtifactOverlayOptions {
  artifacts: StrategyArtifact[];
  inputOverrides: Record<string, Record<string, number>>;
  setInputOverrides: Dispatch<SetStateAction<Record<string, Record<string, number>>>>;
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  exchange: DataExchange;
  showChart(symbol: string, timeframe: Timeframe): void;
  buildOverlay?: ArtifactOverlayBuilder;
}

export function useChartArtifactOverlay(options: UseChartArtifactOverlayOptions) {
  const [overlay, setOverlay] = useState<StrategyChartOverlay>();
  const [focusTime, setFocusTime] = useState<number>();
  const requestId = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestId.current += 1;
    };
  }, []);

  useEffect(() => {
    requestId.current += 1;
  }, [options.symbol, options.timeframe, options.exchange]);

  const activeOverlay = useMemo(() =>
    overlay?.symbol === options.symbol && overlay.timeframe === options.timeframe ? overlay : undefined,
  [overlay, options.symbol, options.timeframe]);

  const addArtifact = useCallback(async (id: string, explicitOverrides?: Record<string, number>) => {
    const artifact = options.artifacts.find((item) => item.id === id);
    if (!artifact) return;
    const currentRequest = ++requestId.current;
    const built = await (options.buildOverlay ?? buildArtifactOverlay)({
      artifact,
      overrides: explicitOverrides ?? options.inputOverrides[id] ?? {},
      symbol: options.symbol,
      timeframe: options.timeframe,
      candles: options.candles,
      exchange: options.exchange
    });
    if (!built || !mounted.current || currentRequest !== requestId.current) return;
    setOverlay(built.overlay);
    setFocusTime(built.focusTime);
  }, [options.artifacts, options.buildOverlay, options.candles, options.exchange, options.inputOverrides, options.symbol, options.timeframe]);

  const updateInput = useCallback((name: string, value: number) => {
    const id = activeOverlay?.id;
    if (!id) return;
    const next = { ...(options.inputOverrides[id] ?? {}), [name]: value };
    options.setInputOverrides((current) => ({ ...current, [id]: next }));
    void addArtifact(id, next);
  }, [activeOverlay?.id, addArtifact, options.inputOverrides, options.setInputOverrides]);

  const applyBacktestResult = useCallback((
    result: BacktestResult,
    resultSymbol: string,
    resultTimeframe: Timeframe,
    visuals?: { plots?: ChartPlot[]; shapes?: ChartShapes }
  ) => {
    requestId.current += 1;
    setOverlay({
      name: result.name,
      signals: result.signals,
      trades: result.trades,
      plots: visuals?.plots,
      shapes: visuals?.shapes,
      symbol: resultSymbol,
      timeframe: resultTimeframe
    });
  }, []);

  const showOnChart = useCallback((resultSymbol: string, resultTimeframe: Timeframe) => {
    options.showChart(resultSymbol, resultTimeframe);
    const times = [
      ...(overlay?.signals ?? []).map((marker) => marker.time),
      ...(overlay?.trades ?? []).map((trade) => trade.exitTime)
    ];
    setFocusTime(times.length ? Math.max(...times) : Date.now());
  }, [options.showChart, overlay]);

  const clear = useCallback(() => {
    requestId.current += 1;
    setOverlay(undefined);
  }, []);

  return { overlay, activeOverlay, focusTime, addArtifact, updateInput, applyBacktestResult, showOnChart, clear };
}

export async function buildArtifactOverlay(request: BuildOverlayRequest): Promise<BuiltArtifactOverlay | undefined> {
  const [{ compileXmlToIr }, backtest, { loadSecurityDataForIr }, cycles] = await Promise.all([
    import("../strategy/compileArtifact"),
    import("../strategy/backtest"),
    import("../strategy/securityLoader"),
    import("../strategy/pine/cyclesAnalysisPreview")
  ]);
  const compiled = compileXmlToIr(request.artifact.xml);
  if (!compiled.ir) return undefined;
  const compatibleIr = cycles.withCyclesAnalysisInputs(compiled.ir);
  const ir = {
    ...compatibleIr,
    inputs: compatibleIr.inputs.map((input) => ({
      ...input,
      value: request.overrides[input.name] ?? input.value
    }))
  };
  const securityData = await loadSecurityDataForIr(ir, {
    symbol: request.symbol,
    timeframe: request.timeframe,
    chartCandles: request.candles,
    exchange: request.exchange
  });
  const preview = cycles.previewCyclesAnalysis(ir, request.candles) ??
    backtest.previewStrategy(ir, request.candles, securityData);
  const result = backtest.runBacktest(ir, request.candles, backtest.DEFAULT_CONFIG, securityData);
  const times = [...preview.signals.map((signal) => signal.time), ...result.trades.map((trade) => trade.exitTime)];
  return {
    overlay: {
      id: request.artifact.id,
      name: request.artifact.name,
      plots: preview.plots,
      shapes: preview.shapes,
      tables: preview.tables,
      inputs: ir.inputs,
      signals: preview.signals,
      trades: result.trades,
      summary: "summary" in preview ? preview.summary : undefined,
      symbol: request.symbol,
      timeframe: request.timeframe
    },
    focusTime: times.length ? Math.max(...times) : Date.now()
  };
}
