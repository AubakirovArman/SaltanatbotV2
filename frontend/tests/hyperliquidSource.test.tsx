import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Watchlist } from "../src/components/Watchlist";

describe("Hyperliquid market source", () => {
  it("is exposed as a first-class selected source in the market list", () => {
    const html = renderToStaticMarkup(
      <Watchlist
        locale="ru"
        instruments={[{
          symbol: "BTCUSDT",
          displayName: "Bitcoin / Tether",
          assetClass: "crypto",
          exchange: "Binance / Bybit / Hyperliquid",
          currency: "USDT",
          provider: "binance",
          basePrice: 60_000,
          decimals: 2
        }]}
        selectedSymbol="BTCUSDT"
        selectedAsset="crypto"
        cryptoExchange="hyperliquid"
        onSelectSymbol={() => {}}
        onSelectAsset={() => {}}
        onSelectExchange={() => {}}
      />
    );

    expect(html).toContain("Hyperliquid");
    expect(html).toContain('title="Показывать цены криптовалют с Hyperliquid"');
    expect(html).toMatch(/class="active"[^>]*aria-pressed="true"[^>]*title="Показывать цены криптовалют с Hyperliquid"/);
  });
});
