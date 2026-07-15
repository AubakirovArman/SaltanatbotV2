import { describe, expect, it } from "vitest";
import { automationText } from "../src/i18n/automation";

describe("automation information architecture localization", () => {
  it("provides the three primary spaces and robot center copy in EN/RU/KK", () => {
    expect(["en", "ru", "kk"].map((locale) => automationText(locale as "en" | "ru" | "kk", "monitoring"))).toEqual(["Monitoring", "Мониторинг", "Мониторинг"]);
    expect(automationText("ru", "automation")).toBe("Автоматизация");
    expect(automationText("kk", "robots")).toBe("Роботтар");
    expect(automationText("ru", "noRunning")).toBe("У вас пока ничего не запущено");
  });
});
