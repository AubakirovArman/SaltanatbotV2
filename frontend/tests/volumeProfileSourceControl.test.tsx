import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VolumeProfileSourceControl } from "../src/components/chartCanvas/VolumeProfileSourceControl";
import type { Locale } from "../src/i18n";

const expected: Record<Locale, string[]> = {
  en: ["Volume profile", "Profile timeframe", "As chart"],
  ru: ["Профиль объёма", "Таймфрейм профиля", "Как на графике"],
  kk: ["Көлем профилі", "Профиль таймфреймі", "Графиктегідей"]
};

describe("volume profile source control", () => {
  it.each(["en", "ru", "kk"] as const)("renders localized, natively labelled controls in %s", (locale) => {
    const html = renderToStaticMarkup(
      <VolumeProfileSourceControl
        locale={locale}
        chartTimeframe="1h"
        enabled
        onEnabledChange={() => {}}
        state={{ source: "chart", setSource: () => {}, timeframe: "1h", status: "ready", candles: [], profileCandles: undefined }}
      />
    );
    for (const text of expected[locale]) expect(html).toContain(text);
    expect(html).toContain('type="checkbox"');
    expect(html).toMatch(/<label[^>]*for="[^"]+"/);
    expect(html).toMatch(/<select[^>]*aria-describedby="[^"]+"/);
    expect(html).toContain('aria-live="polite"');
  });
});
