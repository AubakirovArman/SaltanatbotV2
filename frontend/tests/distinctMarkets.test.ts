import { describe, expect, it } from "vitest";
import { normalizeDistinctMarketSymbols, pickDistinctMarketSymbols } from "../src/app/distinctMarkets";
import type { Instrument } from "../src/types";

const instrument = (symbol: string, assetClass: Instrument["assetClass"] = "crypto"): Instrument => ({ symbol, displayName: symbol, assetClass, exchange: "Test", currency: "USDT", provider: assetClass === "crypto" ? "binance" : "synthetic", basePrice: 1, decimals: 2 });

describe("distinct market layout selection", () => {
  it("keeps the primary symbol and deterministically prefers familiar majors", () => {
    const catalog = [instrument("XRPUSDT"), instrument("BNBUSDT"), instrument("SOLUSDT"), instrument("ETHUSDT"), instrument("BTCUSDT")];
    expect(pickDistinctMarketSymbols("XRPUSDT", catalog)).toEqual(["XRPUSDT", "BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  });

  it("deduplicates and fills missing majors from crypto before synthetic markets", () => {
    const catalog = [instrument("BTCUSDT"), instrument("BTCUSDT"), instrument("ATOMUSDT"), instrument("LINKUSDT"), instrument("EURUSD", "forex")];
    expect(pickDistinctMarketSymbols("BTCUSDT", catalog)).toEqual(["BTCUSDT", "ATOMUSDT", "LINKUSDT", "EURUSD"]);
  });

  it("fails closed for invalid, duplicate and oversized runtime symbols", () => {
    expect(normalizeDistinctMarketSymbols("BTCUSDT", ["BTCUSDT", "ETHUSDT", "bad\n", "X".repeat(65), "SOLUSDT"], 4)).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  });
});
