import type { DataExchange, DataMarketType, PriceType } from "../types";

/** Complete chart route emitted by scanner rows; never infer perpetual vs spot from a symbol. */
export interface ArbitrageChartTarget {
  symbol: string;
  exchange: DataExchange;
  marketType: DataMarketType;
  priceType: PriceType;
}
