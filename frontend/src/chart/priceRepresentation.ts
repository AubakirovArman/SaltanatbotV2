import type { Candle, ChartType } from "../types";
import { toHeikinAshi } from "./heikinAshi";
import { buildKagi } from "./kagi";
import { buildLineBreak } from "./lineBreak";
import { buildRenko } from "./renko";
import { buildPointAndFigure } from "./pointAndFigure";
import { DEFAULT_PRICE_REPRESENTATION_SETTINGS, type PriceRepresentationSettings } from "./priceRepresentationSettings";

export function preparePriceCandles(candles: Candle[], chartType: ChartType, decimals: number, settings: PriceRepresentationSettings = DEFAULT_PRICE_REPRESENTATION_SETTINGS): Candle[] {
  if (chartType === "heikin") return toHeikinAshi(candles);
  if (chartType === "linebreak") return buildLineBreak(candles, settings.lineBreakDepth);
  if (chartType === "renko") return buildRenko(candles, { decimals, brickPercent: settings.renkoBrickPercent });
  if (chartType === "kagi") return buildKagi(candles, { decimals, reversalPercent: settings.kagiReversalPercent });
  if (chartType === "pnf") return buildPointAndFigure(candles, { decimals, boxPercent: settings.pnfBoxPercent, reversalBoxes: settings.pnfReversalBoxes });
  return candles;
}
