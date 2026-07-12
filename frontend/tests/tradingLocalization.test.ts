import { describe, expect, it } from "vitest";
import { commandReference } from "../src/trading/commandReference";
import { tradingCancelOrder, tradingFillCount, tradingLiveConfirm, tradingLocale, tradingSaveKeys, tradingTerm, tradingText } from "../src/i18n/trading";

describe("trading localization", () => {
  it("provides complete safety-critical Kazakh copy", () => {
    expect(tradingText("kk", "tradingLocked")).toBe("Сауда жабық");
    expect(tradingText("kk", "armLiveTrading")).toBe("Live сауданы қосу");
    expect(tradingSaveKeys("kk", "binance")).toBe("binance кілттерін сақтау");
    expect(tradingLiveConfirm("kk", "Bybit")).toContain("НАҚТЫ қаражатпен LIVE");
    expect(tradingCancelOrder("kk", "limit", "42")).toBe("limit 42 ордерін болдырмау");
    expect(tradingFillCount("kk", 3)).toBe("орындалулар: 3");
    expect(tradingTerm("kk", "partially_filled")).toBe("ішінара орындалды");
    expect(tradingLocale("kk")).toBe("kk-KZ");
  });

  it("localizes every Antares command group without changing commands", () => {
    const groups = commandReference("kk");
    expect(groups[0].title).toBe("Нарықтық және лимиттік ордерлер (neworder)");
    expect(groups.flatMap((group) => group.items).every((item) => item.label.length > 0 && item.command.includes("="))).toBe(true);
  });
});
