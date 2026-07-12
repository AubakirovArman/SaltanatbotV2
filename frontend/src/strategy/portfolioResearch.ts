import {
  simulatePortfolioBacktest,
  type PortfolioBacktestConfig,
  type PortfolioBacktestResult
} from "@saltanatbotv2/backtest-core";
import type { Candle, DataExchange, Timeframe } from "../types";
import { runBacktest, type BacktestConfig } from "./backtest";
import { loadCandleHistory, type CandlePageLoader } from "./candleHistory";
import type { StrategyIR } from "./ir";
import { loadSecurityDataForIr } from "./securityLoader";

export interface PortfolioResearchRequest {
  ir: StrategyIR;
  symbols: string[];
  timeframe: Timeframe;
  bars: number;
  exchange: DataExchange;
  backtestConfig: BacktestConfig;
  portfolioConfig: PortfolioBacktestConfig;
  signal?: AbortSignal;
}

interface PortfolioResearchDependencies {
  loadHistory?: (request: Parameters<typeof loadCandleHistory>[0], loader?: CandlePageLoader) => Promise<Candle[]>;
  loadSecurity?: typeof loadSecurityDataForIr;
}

export async function runPortfolioResearch(
  request: PortfolioResearchRequest,
  dependencies: PortfolioResearchDependencies = {}
): Promise<PortfolioBacktestResult> {
  const symbols = uniqueSymbols(request.symbols);
  if (symbols.length < 2) throw new Error("Select at least two different markets for a portfolio backtest.");
  if (symbols.length > 6) throw new Error("A portfolio backtest supports up to six markets.");

  const loadHistory = dependencies.loadHistory ?? loadCandleHistory;
  const loadSecurity = dependencies.loadSecurity ?? loadSecurityDataForIr;
  const legs = await Promise.all(symbols.map(async (symbol) => {
    const candles = await loadHistory({
      symbol,
      timeframe: request.timeframe,
      bars: request.bars,
      exchange: request.exchange,
      signal: request.signal
    });
    if (candles.length < 30) throw new Error(`${symbol}: not enough history for this interval.`);
    const securityData = await loadSecurity(request.ir, {
      symbol,
      timeframe: request.timeframe,
      chartCandles: candles,
      exchange: request.exchange,
      signal: request.signal
    });
    return {
      symbol,
      candles,
      report: runBacktest(
        request.ir,
        candles,
        { ...request.backtestConfig, initialCapital: request.portfolioConfig.initialCapital },
        securityData,
        {
          symbol,
          timeframe: request.timeframe,
          exchange: request.exchange,
          marketType: "linear",
          priceType: "trade",
          requestedBars: request.bars
        }
      )
    };
  }));

  return simulatePortfolioBacktest(legs, request.portfolioConfig);
}

export function uniqueSymbols(symbols: string[]): string[] {
  return [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
}
