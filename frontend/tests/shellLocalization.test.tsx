import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AlertToasts } from "../src/components/AlertToasts";
import { StatsPanel } from "../src/components/StatsPanel";
import { shellText } from "../src/i18n/shell";

const instrument = { symbol: "BTCUSDT", displayName: "Bitcoin", assetClass: "crypto" as const, exchange: "Binance", currency: "USDT", provider: "binance" as const, basePrice: 100, decimals: 2 };

describe("shell localization", () => {
  it("provides typed Russian navigation and market vocabulary", () => {
    expect(shellText("ru", "commandPalette")).toBe("Палитра команд");
    expect(shellText("ru", "markets")).toBe("Рынки");
    expect(shellText("ru", "barStatistics")).toBe("Статистика свечи");
  });

  it("renders Russian statistics, alert form and toast semantics", () => {
    const stats = renderToStaticMarkup(
      <StatsPanel locale="ru" instrument={instrument} candles={[]} provider="binance" connection="connected" message="ok" alerts={[]} onAddAlert={() => {}} onRemoveAlert={() => {}} onResetAlert={() => {}} />
    );
    const toasts = renderToStaticMarkup(
      <AlertToasts locale="ru" toasts={[{ id: "a", symbol: "BTCUSDT", direction: "above", price: 100, hitPrice: 101 }]} decimalsFor={() => 2} onDismiss={() => {}} />
    );

    expect(stats).toContain('aria-label="Статистика свечи"');
    expect(stats).toContain('aria-label="Ценовые алерты"');
    expect(stats).toContain("Поток данных");
    expect(toasts).toContain("поднялся выше");
    expect(toasts).toContain('aria-label="Закрыть алерт"');
  });
});
