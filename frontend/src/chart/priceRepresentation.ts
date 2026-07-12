import type { Candle, ChartType } from "../types";
import { toHeikinAshi } from "./heikinAshi";
import { buildKagi } from "./kagi";
import { buildLineBreak } from "./lineBreak";
import { buildRenko } from "./renko";

export function preparePriceCandles(candles: Candle[], chartType: ChartType, decimals: number): Candle[] {
  if (chartType === "heikin") return toHeikinAshi(candles);
  if (chartType === "linebreak") return buildLineBreak(candles);
  if (chartType === "renko") return buildRenko(candles, { decimals });
  if (chartType === "kagi") return buildKagi(candles, { decimals });
  return candles;
}
