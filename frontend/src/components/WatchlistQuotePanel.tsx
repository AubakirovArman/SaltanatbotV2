import { useMemo } from "react";
import type { Locale } from "../i18n";
import { recordBrowserRender } from "../performance/browserProbe";
import { useSparklines } from "../hooks/useSparklines";
import type { AssetClass, Candle, DataExchange, DataMarketType, Instrument, PriceType, Timeframe } from "../types";
import { Watchlist } from "./Watchlist";

interface WatchlistQuotePanelProps {
  enabled: boolean;
  locale: Locale;
  instruments: Instrument[];
  quoteInstruments: Instrument[];
  selectedSymbol: string;
  selectedAsset: AssetClass | "all";
  latest?: Candle;
  timeframe: Timeframe;
  exchange: DataExchange;
  marketType: DataMarketType;
  priceType: PriceType;
  onSelectSymbol: (symbol: string) => void;
  onSelectAsset: (asset: AssetClass | "all") => void;
  onSelectExchange: (exchange: DataExchange) => void;
  storageOwnerId?: string;
}

export function selectWatchlistQuoteSymbols(selectedSymbol: string, instruments: Instrument[]): string[] {
  return [...new Set([selectedSymbol, ...instruments.map((instrument) => instrument.symbol)].filter(Boolean))].slice(0, 40);
}

/**
 * Owns the watchlist quote subscription and its high-frequency state.
 *
 * Keeping this boundary below ChartWorkspaceRuntime prevents quote ticks from
 * rerendering the chart canvas or either surrounding desktop panel.
 */
export function WatchlistQuotePanel({
  enabled,
  locale,
  instruments,
  quoteInstruments,
  selectedSymbol,
  selectedAsset,
  latest,
  timeframe,
  exchange,
  marketType,
  priceType,
  onSelectSymbol,
  onSelectAsset,
  onSelectExchange,
  storageOwnerId
}: WatchlistQuotePanelProps) {
  recordBrowserRender("WatchlistQuotePanel");
  const quoteSymbols = useMemo(
    () => selectWatchlistQuoteSymbols(selectedSymbol, quoteInstruments),
    [quoteInstruments, selectedSymbol]
  );
  const sparklines = useSparklines(quoteSymbols, timeframe, exchange, {
    enabled,
    marketType,
    priceType
  });

  return (
    <Watchlist
      locale={locale}
      instruments={instruments}
      selectedSymbol={selectedSymbol}
      selectedAsset={selectedAsset}
      latest={latest}
      sparklines={sparklines}
      cryptoExchange={exchange}
      onSelectSymbol={onSelectSymbol}
      onSelectAsset={onSelectAsset}
      onSelectExchange={onSelectExchange}
      storageOwnerId={storageOwnerId}
    />
  );
}
