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
    expect(shellText("ru", "trendLine")).toBe("Линия тренда");
    expect(shellText("ru", "savedWorkspaces")).toBe("Сохранённые рабочие пространства");
  });

  it("provides typed Kazakh navigation and market vocabulary", () => {
    expect(shellText("kk", "commandPalette")).toBe("Пәрмендер палитрасы");
    expect(shellText("kk", "markets")).toBe("Нарықтар");
    expect(shellText("kk", "barStatistics")).toBe("Шам статистикасы");
    expect(shellText("kk", "trendLine")).toBe("Тренд сызығы");
    expect(shellText("kk", "savedWorkspaces")).toBe("Сақталған жұмыс кеңістіктері");
  });

  it("renders Russian statistics, alert form and toast semantics", () => {
    const stats = renderToStaticMarkup(
      <StatsPanel locale="ru" instrument={instrument} candles={[]} provider="binance" connection="connected" message="ok" exchange="binance" alerts={[]} onAddAlert={() => {}} onRemoveAlert={() => {}} onResetAlert={() => {}} />
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

  it("renders Kazakh statistics and alert semantics", () => {
    const stats = renderToStaticMarkup(
      <StatsPanel locale="kk" instrument={instrument} candles={[]} provider="binance" connection="connected" message="ok" exchange="binance" alerts={[]} onAddAlert={() => {}} onRemoveAlert={() => {}} onResetAlert={() => {}} />
    );
    const toasts = renderToStaticMarkup(
      <AlertToasts locale="kk" toasts={[{ id: "a", symbol: "BTCUSDT", direction: "above", price: 100, hitPrice: 101 }]} decimalsFor={() => 2} onDismiss={() => {}} />
    );

    expect(stats).toContain('aria-label="Шам статистикасы"');
    expect(stats).toContain('aria-label="Баға туралы ескертулер"');
    expect(stats).toContain("Арна");
    expect(toasts).toContain("жоғары көтерілді");
    expect(toasts).toContain('aria-label="Ескертуді өшіру"');
  });
});
