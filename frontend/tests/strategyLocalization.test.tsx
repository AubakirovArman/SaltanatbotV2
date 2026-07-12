// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PineImportDialog } from "../src/components/PineImportDialog";
import { strategyCategory, strategyObjective, strategyText } from "../src/i18n/strategy";

describe("strategy workspace localization", () => {
  it("keeps typed English, Russian and Kazakh resources in parity", () => {
    expect(strategyText("en", "runBacktest")).toBe("Run backtest");
    expect(strategyText("ru", "runBacktest")).toBe("Запустить бэктест");
    expect(strategyCategory("ru", "Mean reversion")).toBe("Возврат к среднему");
    expect(strategyObjective("ru", "returnOverDd")).toBe("Доходность / макс. просадка");
    expect(strategyObjective("ru", "customObjective")).toBe("customObjective");
    expect(strategyText("kk", "runBacktest")).toBe("Бэктестті іске қосу");
    expect(strategyCategory("kk", "Mean reversion")).toBe("Орташа мәнге оралу");
    expect(strategyObjective("kk", "returnOverDd")).toBe("Қайтару / MaxDD");
  });

  it("renders Russian Pine import semantics while preserving Pine identifiers", () => {
    const html = renderToStaticMarkup(<PineImportDialog locale="ru" onClose={() => {}} onImportMany={() => {}} />);

    expect(html).toContain('aria-label="Импорт Pine Script"');
    expect(html).toContain("Загрузить файл(ы) .pine");
    expect(html).toContain("Преобразовать");
    expect(html).toContain("indicator()");
    expect(html).toContain("strategy()");
  });

  it("renders Kazakh Pine import semantics while preserving Pine identifiers", () => {
    const html = renderToStaticMarkup(<PineImportDialog locale="kk" onClose={() => {}} onImportMany={() => {}} />);

    expect(html).toContain('aria-label="Pine сценарийін импорттау"');
    expect(html).toContain(".pine файлдарын жүктеңіз");
    expect(html).toContain("Түрлендіру");
    expect(html).toContain("indicator()");
    expect(html).toContain("strategy()");
  });
});
