import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AlertToasts } from "../src/components/AlertToasts";
import { StatsPanel } from "../src/components/StatsPanel";
import { shellText } from "../src/i18n/shell";

const instrument = { symbol: "BTCUSDT", displayName: "Bitcoin", assetClass: "crypto" as const, exchange: "Binance", currency: "USDT", provider: "binance" as const, basePrice: 100, decimals: 2 };

const SCREEN_RULE_ID = "00000000-0000-4000-8000-000000000042";

const screenerAlertRule = {
  schemaVersion: "alert-rule-record-v1" as const,
  id: SCREEN_RULE_ID,
  clientId: "screen-alert-01",
  revision: 1,
  definition: {
    schemaVersion: "alert-rule-v1" as const,
    kind: "screener" as const,
    name: "Momentum screen",
    enabled: true,
    cooldownSeconds: 3600,
    deliveryChannels: ["in-app" as const],
    screen: {
      schemaVersion: "screener-definition-v1" as const,
      kind: "technical" as const,
      name: "Momentum screen",
      exchange: "binance" as const,
      marketType: "spot" as const,
      priceType: "last" as const,
      timeframe: "1h" as const,
      universeLimit: 100,
      sort: { key: "quoteVolume24h" as const, direction: "desc" as const },
      filters: [{ kind: "quote-volume-24h" as const, min: "1000000" }],
      researchOnly: true as const,
      executionPermission: false as const
    },
    repeat: "on-change" as const,
    researchOnly: true as const,
    executionPermission: false as const
  },
  lifecycleState: "armed" as const,
  createdAt: "2026-07-17T08:00:00.000Z",
  updatedAt: "2026-07-17T08:01:00.000Z",
  researchOnly: true as const,
  executionPermission: false as const
};

const screenerAlertEvent = {
  schemaVersion: "alert-event-v1" as const,
  id: "00000000-0000-4000-8000-000000000051",
  ruleId: SCREEN_RULE_ID,
  ruleRevision: 1,
  ruleKind: "screener" as const,
  eventType: "triggered" as const,
  subjectKey: `${"d".repeat(64)}:bar:1752739200000`,
  transitionKey: "1".padStart(64, "0"),
  occurredAt: "2026-07-17T08:04:00.000Z",
  summary: "Screen match set changed.",
  researchOnly: true as const,
  executionPermission: false as const
};

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

  it("labels screener alert records and their controls in every shipped locale", () => {
    expect(shellText("en", "screenerAlerts")).toBe("Screen alerts");
    expect(shellText("ru", "screenerAlerts")).toBe("Алерты скринера");
    expect(shellText("kk", "screenerAlerts")).toBe("Скринер ескертулері");
    for (const locale of ["en", "ru", "kk"] as const) {
      for (const key of ["screenerAlerts", "screenerAlertKind", "screenerAlertEnable", "screenerAlertDisable", "screenerAlertArchive"] as const) {
        expect(shellText(locale, key).trim(), `shell.${key} (${locale})`).not.toBe("");
      }
    }
    expect(shellText("kk", "screenerAlertArchive")).toBe("Скринер ескертуін мұрағаттау");

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
        alerts={[]}
        alertSync={{ status: "synced", events: [screenerAlertEvent], outbox: [], refresh: () => undefined }}
        screenerAlerts={[screenerAlertRule]}
        onAddAlert={() => {}}
        onRemoveAlert={() => {}}
        onResetAlert={() => {}}
        onToggleScreenerAlert={() => {}}
        onArchiveScreenerAlert={() => {}}
      />
    );
    expect(stats).toContain("Алерты скринера");
    expect(stats).toContain(">скрин<");
    expect(stats).toContain("Momentum screen");
    expect(stats).toContain('aria-label="Отключить алерт скринера Momentum screen"');
    expect(stats).toContain('aria-label="Архивировать алерт скринера Momentum screen"');
    // Recent activity names the screen because screener events have no symbol.
    expect(stats).toContain("Momentum screen · Алерт сработал");
  });

  it("labels the chart research tools and note editor in every shipped locale", () => {
    expect(shellText("en", "textNote")).toBe("Text note");
    expect(shellText("ru", "textNote")).toBe("Текстовая заметка");
    expect(shellText("kk", "textNote")).toBe("Мәтіндік жазба");
    expect(shellText("ru", "parallelChannel")).toBe("Параллельный канал");
    expect(shellText("kk", "parallelChannel")).toBe("Параллель канал");
    for (const locale of ["en", "ru", "kk"] as const) {
      for (const key of ["parallelChannel", "textNote", "editTextNote", "textNoteContent", "textNotePlaceholder", "noteEditorHint", "saveNote", "cancelNote"] as const) {
        expect(shellText(locale, key).trim(), `shell.${key} (${locale})`).not.toBe("");
      }
      expect(shellText(locale, "noteEditorHint")).toContain("Ctrl+Enter");
    }
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
