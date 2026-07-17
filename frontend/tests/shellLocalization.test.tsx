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
      <StatsPanel locale="ru" instrument={instrument} candles={[]} provider="binance" connection="connected" message="ok" exchange="binance" timeframe="1m" alerts={[]} alertSync={{ status: "synced", events: [], outbox: [], refresh: () => undefined }} onAddAlert={() => {}} onRemoveAlert={() => {}} onResetAlert={() => {}} />
    );
    const toasts = renderToStaticMarkup(
      <AlertToasts locale="ru" toasts={[{ id: "a", symbol: "BTCUSDT", direction: "above", price: 100, hitPrice: 101 }]} decimalsFor={() => 2} onDismiss={() => {}} />
    );

    expect(stats).toContain('aria-label="Статистика свечи"');
    expect(stats).toContain('aria-label="Ценовые алерты"');
    expect(stats).toContain("Серверные алерты синхронизированы");
    expect(stats).toContain("Поток данных");
    expect(toasts).toContain("поднялся выше");
    expect(toasts).toContain('aria-label="Закрыть алерт"');
  });

  it("renders Kazakh statistics and alert semantics", () => {
    const stats = renderToStaticMarkup(
      <StatsPanel locale="kk" instrument={instrument} candles={[]} provider="binance" connection="connected" message="ok" exchange="binance" timeframe="1m" alerts={[]} alertSync={{ status: "legacy", events: [], outbox: [], refresh: () => undefined }} onAddAlert={() => {}} onRemoveAlert={() => {}} onResetAlert={() => {}} />
    );
    const toasts = renderToStaticMarkup(
      <AlertToasts locale="kk" toasts={[{ id: "a", symbol: "BTCUSDT", direction: "above", price: 100, hitPrice: 101 }]} decimalsFor={() => 2} onDismiss={() => {}} />
    );

    expect(stats).toContain('aria-label="Шам статистикасы"');
    expect(stats).toContain('aria-label="Баға туралы ескертулер"');
    expect(stats).toContain("Тек браузерде");
    expect(stats).toContain("Арна");
    expect(toasts).toContain("жоғары көтерілді");
    expect(toasts).toContain('aria-label="Ескертуді өшіру"');
  });

  it("explains unsupported database alert routes in all shipped locales", () => {
    expect(shellText("en", "alertServerRouteUnavailable")).toContain("last price");
    expect(shellText("ru", "alertServerRouteUnavailable")).toContain("серверный алерт недоступен");
    expect(shellText("kk", "alertServerRouteUnavailable")).toContain("сервер ескертуі қолжетімсіз");
    expect(shellText("ru", "alertDisabled")).toBe("отключён");
    expect(shellText("ru", "alertEventTriggered")).toBe("Алерт сработал");
    expect(shellText("kk", "alertEventTriggered")).toBe("Ескерту іске қосылды");
    expect(shellText("en", "alertDeliveryDelivered")).toBe("available in app");
    expect(shellText("ru", "alertDeliveryDelivered")).toBe("доступно в приложении");
    expect(shellText("kk", "alertDeliveryDelivered")).toBe("қолданбада қолжетімді");
    expect(shellText("ru", "alertClosedCandleSemantics")).toContain("после закрытия");
    expect(shellText("ru", "alertInactive")).toBe("неактивен");
  });

  it("renders a localized server-alert toast with a dedicated visual state", () => {
    const toast = renderToStaticMarkup(
      <AlertToasts
        locale="ru"
        toasts={[{ id: "server:event", source: "server", symbol: "BTCUSDT", summary: "Raw backend summary.", occurredAt: "2026-07-17T08:00:00.000Z" }]}
        decimalsFor={() => 2}
        onDismiss={() => {}}
      />
    );
    expect(toast).toContain("alert-toast server");
    expect(toast).toContain("Серверный алерт сработал");
    expect(toast).toContain('title="Raw backend summary."');
    expect(toast).not.toContain(">Raw backend summary.<");
  });

  it("labels a disabled server projection honestly", () => {
    const stats = renderToStaticMarkup(
      <StatsPanel
        locale="ru"
        instrument={instrument}
        candles={[]}
        provider="binance"
        connection="connected"
        message="ok"
        exchange="binance"
        timeframe="1m"
        alerts={[{ id: "00000000-0000-4000-8000-000000000041", symbol: "BTCUSDT", price: 100, direction: "above", timeframe: "1m", createdAt: 1, triggered: false, exchange: "binance", marketType: "spot", priceType: "last", source: "server", suspended: true, syncState: "syncing", serverRuleId: "00000000-0000-4000-8000-000000000041", serverRevision: 1, serverLifecycle: "disabled" }]}
        alertSync={{ status: "synced", events: [], outbox: [], refresh: () => undefined }}
        onAddAlert={() => {}}
        onRemoveAlert={() => {}}
        onResetAlert={() => {}}
      />
    );
    expect(stats).toContain("отключён");
    expect(stats).toContain("синхронизация");
  });
});
