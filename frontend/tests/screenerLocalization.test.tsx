import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ScreenerRowV1 } from "@saltanatbotv2/contracts";
import { ScannerModeNav } from "../src/arbitrage/ScannerModeNav";
import { enScreener } from "../src/i18n/en/screener";
import { kkScreener } from "../src/i18n/kk/screener";
import { ruScreener } from "../src/i18n/ru/screener";
import { screenerText, type ScreenerMessageKey } from "../src/i18n/screener";
import { createFilterDraft } from "../src/screener/definitionForm";
import { TechnicalFilters } from "../src/screener/TechnicalFilters";
import { TechnicalResultsTable } from "../src/screener/TechnicalResultsTable";

const row: ScreenerRowV1 = {
  symbol: "BTCUSDT",
  lastClose: "64703.52",
  closedBarTime: 1_752_739_200_000,
  change24hPercent: "2.15",
  quoteVolume24h: "1284000000",
  metrics: { rsi: "28.4" },
  matchedFilters: 2
};

describe("technical screener localization", () => {
  it("keeps the en/ru/kk catalogs key-aligned with matching interpolation tokens", () => {
    const keys = Object.keys(enScreener).sort() as ScreenerMessageKey[];
    expect(Object.keys(ruScreener).sort()).toEqual(keys);
    expect(Object.keys(kkScreener).sort()).toEqual(keys);
    for (const key of keys) {
      for (const catalog of [enScreener, ruScreener, kkScreener]) {
        expect(catalog[key].trim(), `screener.${key} must not be empty`).not.toBe("");
      }
      expect(tokens(ruScreener[key]), `screener.${key} ru tokens`).toEqual(tokens(enScreener[key]));
      expect(tokens(kkScreener[key]), `screener.${key} kk tokens`).toEqual(tokens(enScreener[key]));
    }
  });

  it("provides typed Russian screener vocabulary with interpolation", () => {
    expect(screenerText("ru", "mode")).toBe("Технический скринер");
    expect(screenerText("ru", "run")).toBe("Запустить скрин");
    expect(screenerText("ru", "signInRequired")).toContain("Войдите в зарегистрированный аккаунт");
    expect(screenerText("ru", "noResultsHint")).toContain("никогда не считаются нулём");
    expect(screenerText("ru", "unavailableReasons", { count: "3", reasons: "indicator-warm-up × 2" })).toBe("Недоступные символы (3): indicator-warm-up × 2");
    expect(screenerText("ru", "truncated", { limit: "100" })).toBe("Показаны только первые 100 совпадений. Сузьте фильтры, чтобы увидеть все.");
    expect(screenerText("ru", "filterLimit", { limit: "12" })).toBe("Скрин принимает до 12 фильтров.");
    expect(screenerText("ru", "risk")).toContain("не размещает ордера");
    expect(screenerText("ru", "createAlert")).toBe("Создать алерт из этого скрина");
    expect(screenerText("ru", "alertCreated", { name: "Momentum" })).toContain("«Momentum» создан");
    expect(screenerText("ru", "alertQuotaExceeded")).toContain("лимит алертов скринера");
    expect(screenerText("ru", "alertCapacityExhausted")).toContain("не принимает новые алерты");
  });

  it("provides typed Kazakh screener vocabulary with interpolation", () => {
    expect(screenerText("kk", "mode")).toBe("Техникалық скринер");
    expect(screenerText("kk", "run")).toBe("Скринді іске қосу");
    expect(screenerText("kk", "signInRequired")).toContain("тіркелген аккаунтпен кіріңіз");
    expect(screenerText("kk", "noResultsHint")).toContain("ешқашан нөл болып саналмайды");
    expect(screenerText("kk", "unavailableReasons", { count: "3", reasons: "indicator-warm-up × 2" })).toBe("Қолжетімсіз символдар (3): indicator-warm-up × 2");
    expect(screenerText("kk", "truncated", { limit: "100" })).toBe("Тек алғашқы 100 сәйкестік көрсетілді. Барлығын көру үшін сүзгілерді тарылтыңыз.");
    expect(screenerText("kk", "filterLimit", { limit: "12" })).toBe("Скрин ең көбі 12 сүзгі қабылдайды.");
    expect(screenerText("kk", "risk")).toContain("пайда уәде етпейді");
    expect(screenerText("kk", "createAlert")).toBe("Осы скриннен ескерту жасау");
    expect(screenerText("kk", "alertCreated", { name: "Momentum" })).toContain("«Momentum» серверлік ескертуі жасалды");
    expect(screenerText("kk", "alertQuotaExceeded")).toContain("шегіне жеттіңіз");
    expect(screenerText("kk", "alertCapacityExhausted")).toContain("қабылдамайды");
  });

  it("renders Russian filter rows, results and the scanner mode label with aria semantics", () => {
    const filters = renderToStaticMarkup(<TechnicalFilters locale="ru" filters={[createFilterDraft("rsi", 1)]} disabled={false} onChange={() => {}} />);
    expect(filters).toContain('aria-label="Фильтр 1 · RSI"');
    expect(filters).toContain('aria-label="Удалить фильтр 1"');
    expect(filters).toContain("Тип нового фильтра");
    expect(filters).toContain("Добавить фильтр");

    const table = renderToStaticMarkup(<TechnicalResultsTable locale="ru" rows={[row]} onOpenRow={() => {}} />);
    expect(table).toContain('aria-label="Открыть график BTCUSDT с таймфреймом и индикаторами скрина"');
    expect(table).toContain("Результаты скрина");
    expect(table).toContain("Фильтров пройдено");

    const nav = renderToStaticMarkup(<ScannerModeNav locale="ru" mode="technical" onMode={() => {}} />);
    expect(nav).toContain("Технический скринер");
  });

  it("renders Kazakh filter rows, results and the scanner mode label with aria semantics", () => {
    const filters = renderToStaticMarkup(<TechnicalFilters locale="kk" filters={[createFilterDraft("rsi", 1)]} disabled={false} onChange={() => {}} />);
    expect(filters).toContain('aria-label="Сүзгі 1 · RSI"');
    expect(filters).toContain('aria-label="1-сүзгіні жою"');
    expect(filters).toContain("Жаңа сүзгі түрі");
    expect(filters).toContain("Сүзгі қосу");

    const table = renderToStaticMarkup(<TechnicalResultsTable locale="kk" rows={[row]} onOpenRow={() => {}} />);
    expect(table).toContain('aria-label="BTCUSDT графигін скрин таймфреймі мен индикаторларымен ашу"');
    expect(table).toContain("Скрин нәтижелері");
    expect(table).toContain("Өткен сүзгілер");

    const nav = renderToStaticMarkup(<ScannerModeNav locale="kk" mode="technical" onMode={() => {}} />);
    expect(nav).toContain("Техникалық скринер");
  });
});

function tokens(value: string): string[] {
  return [...value.matchAll(/\{[a-zA-Z0-9]+\}/g)].map((match) => match[0]).sort();
}
