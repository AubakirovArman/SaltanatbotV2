import type { Candle } from "@saltanatbotv2/contracts";
export type SecurityDataContext = Map<string, Candle[]> | Record<string, Candle[]>;
export declare function securitySeriesKey(symbol: string, timeframe: string): string;
export declare function getSecurityCandles(context: SecurityDataContext | undefined, symbol: string, timeframe: string): Candle[] | undefined;
export declare function alignSecuritySeries(chartCandles: Candle[], sourceCandles: Candle[], sourceValues: number[]): number[];
