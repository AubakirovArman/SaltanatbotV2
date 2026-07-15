// @vitest-environment jsdom
import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FundingStatus } from "../src/arbitrage/FundingCurveWorkbench";

describe("funding curve universe accessibility states", () => {
  it("announces loading without exposing an actionable empty form", () => {
    const html = renderToStaticMarkup(<FundingStatus locale="en" universeState="loading" requestState="idle" instruments={[]} sourceErrors={[]} />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading the verified instrument registry");
  });

  it("announces transport failures as alerts with bounded detail", () => {
    const html = renderToStaticMarkup(<FundingStatus locale="ru" universeState="error" requestState="idle" instruments={[]} sourceErrors={[]} errorDetail="HTTP 503" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Публичный реестр инструментов временно недоступен");
    expect(html).toContain("HTTP 503");
  });

  it("announces a valid but empty server-owned universe as status", () => {
    const html = renderToStaticMarkup(<FundingStatus locale="kk" universeState="ready" requestState="idle" instruments={[]} sourceErrors={[]} />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Public funding мүмкіндігі бар fresh perpetual құралдары жоқ");
    expect(html).not.toContain('role="alert"');
  });

  it("keeps a partial non-empty universe usable while announcing degraded sources", () => {
    const html = renderToStaticMarkup(<FundingStatus locale="en" universeState="ready" requestState="idle" instruments={[{} as RegistryInstrument]} sourceErrors={["gate perpetual: timeout"]} />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Some registry sources are unavailable");
    expect(html).not.toContain('role="alert"');
  });
});
