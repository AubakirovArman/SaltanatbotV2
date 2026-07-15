import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PaperMultiLegPanel } from "../src/trading/components/paper-multi-leg/PaperMultiLegPanel";

describe("paper multi-leg localized workspace", () => {
  it("renders the protected plan workflow in English, Russian and Kazakh", () => {
    const en = renderToStaticMarkup(<PaperMultiLegPanel locale="en" />);
    const ru = renderToStaticMarkup(<PaperMultiLegPanel locale="ru" />);
    const kk = renderToStaticMarkup(<PaperMultiLegPanel locale="kk" />);

    expect(en).toContain("Validated paper plan JSON");
    expect(en).toContain("no live orders");
    expect(ru).toContain("JSON проверенного paper-плана");
    expect(ru).toContain("без реальных ордеров");
    expect(kk).toContain("Тексерілген paper-жоспардың JSON-ы");
    expect(kk).toContain("нақты ордер жоқ");
    for (const markup of [en, ru, kk]) {
      expect(markup).toContain('action="/api/trade/paper-multi-leg/runs"');
      expect(markup).toContain('name="idempotency-key"');
      expect(markup).not.toContain("API secret");
    }
  });
});
