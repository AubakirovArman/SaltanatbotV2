// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Locale } from "../src/i18n";
import { paperPortfolioText } from "../src/i18n/paperPortfolio";
import { BotDetail } from "../src/trading/components/BotDetail";
import type { TradingBot } from "../src/trading/tradeClient";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("paper bot immutable portfolio binding", () => {
  it("explains the immutable portfolio, canonical allocation and ledger epoch in EN, RU and KK", async () => {
    for (const locale of ["en", "ru", "kk"] as const satisfies readonly Locale[]) {
      const { container, root } = await render(boundPaperBot(), locale);
      const note = container.querySelector<HTMLElement>(".paper-binding-lock-note");

      expect(note).not.toBeNull();
      expect(note?.textContent).toContain(paperPortfolioText(locale, "bindingLocked"));
      expect(note?.textContent).toContain(paperPortfolioText(locale, "bindingLockedHint"));
      expect(note?.textContent).toContain(paperPortfolioText(locale, "boundPortfolio"));
      expect(note?.textContent).toContain("portfolio-durable-1");
      expect(note?.textContent).toContain("1234.500000 USDT");
      expect(note?.textContent).toContain("9");
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("does not show paper-binding UI on a live bot", async () => {
    const { container, root } = await render({ ...boundPaperBot(), exchange: "bybit" }, "en");
    expect(container.querySelector(".paper-binding-lock-note")).toBeNull();
    await act(async () => root.unmount());
  });
});

async function render(bot: TradingBot, locale: Locale) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<BotDetail bot={bot} orders={[]} orderJournal={[]} fills={[]} logs={[]} locale={locale} canControl={false} onChanged={() => {}} onDeleted={() => {}} />);
  });
  return { container, root };
}

function boundPaperBot(): TradingBot {
  return {
    id: "paper-bot-1",
    name: "Bound paper bot",
    strategyName: "Strategy",
    ir: {} as TradingBot["ir"],
    symbol: "BTCUSDT",
    timeframe: "1m",
    exchange: "paper",
    market: "futures",
    sizeMode: "quote",
    sizeValue: 100,
    leverage: 1,
    notifyMarkers: false,
    status: "running",
    paperPortfolioId: "portfolio-durable-1",
    paperAllocation: "1234.500000",
    paperLedgerEpoch: 9,
    createdAt: 1,
    updatedAt: 1
  };
}
