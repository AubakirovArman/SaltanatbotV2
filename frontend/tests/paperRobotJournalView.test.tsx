// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { paperPortfolioText } from "../src/i18n/paperPortfolio";
import type { Locale } from "../src/i18n";
import { PaperCashCurve } from "../src/trading/components/paper-portfolio/PaperRobotJournalView";
import { buildPaperRobotRows, PaperRobotDetailDrawer } from "../src/trading/components/paper-portfolio/PaperRobotViews";
import { detailResponse, journal, projection } from "./paperPortfolioFixture";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("paper robot journal and analytics view", () => {
  it("renders an accessible code-native curve and compact disclosure sections inside the detail drawer", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const row = buildPaperRobotRows(projection.robots, detailResponse.robots)[0]!;

    await act(async () => root.render(
      <PaperRobotDetailDrawer row={row} locale="en" busy={false} actionsEnabled={false} onClose={() => {}} onAction={() => {}} />
    ));

    const curve = host.querySelector<SVGElement>('svg[role="img"].paper-cash-curve');
    expect(curve?.getAttribute("viewBox")).toBe("0 0 320 116");
    expect(curve?.querySelector("desc")?.textContent).toContain("not historical mark-to-market equity");
    expect(curve?.querySelector(".paper-curve-cash-line")).not.toBeNull();
    expect(curve?.querySelector(".paper-curve-current circle")).not.toBeNull();
    expect(host.textContent).toContain("First cash");
    expect(host.textContent).toContain("Latest cash");
    expect(host.textContent).toContain("Current equity point");

    const summaries = [...host.querySelectorAll<HTMLElement>(".paper-journal-disclosure > summary")];
    expect(summaries.map((summary) => summary.textContent)).toEqual([
      expect.stringContaining("Performance and risk"),
      expect.stringContaining("Recent fills"),
      expect.stringContaining("Recent ledger events")
    ]);
    expect(summaries.every((summary) => summary.parentElement?.hasAttribute("open") === false)).toBe(true);
    summaries[0]!.focus();
    expect(document.activeElement).toBe(summaries[0]);

    await click(summaries[0]!);
    expect(host.textContent).toContain("Fees paid");
    expect(host.textContent).toContain("Funding net");
    expect(host.textContent).toContain("Net exposure");
    expect(host.textContent).toContain("Borrowing");
    expect(host.textContent).toContain("Closed trades");
    expect(host.textContent).toContain("Win rate");
    expect(host.textContent).toContain("Profit factor");
    expect(host.textContent).toContain("Paper margin model is not available");
    expect(host.textContent).toContain("Insufficient sample");

    await click(summaries[1]!);
    const fillRegion = host.querySelector<HTMLElement>(".paper-fill-list");
    expect(fillRegion?.getAttribute("aria-label")).toBe("Recent fills");
    expect(fillRegion?.textContent).toContain("BTCUSDT");
    expect(fillRegion?.textContent).toContain("65,000");
    expect(fillRegion?.textContent).toContain("2 USDT");

    await click(summaries[2]!);
    const eventRegion = host.querySelector<HTMLElement>(".paper-event-list");
    expect(eventRegion?.getAttribute("aria-label")).toBe("Recent ledger events");
    expect(eventRegion?.querySelector("code")?.textContent).toBe("Cash adjustment");
    expect(eventRegion?.querySelector("code")?.getAttribute("data-event-type")).toBe("cash");
    expect(eventRegion?.querySelector("code")?.getAttribute("title")).toBe("cash");
    expect(eventRegion?.textContent).toContain("#5");
    await act(async () => root.unmount());
  });

  it("keeps stale and unavailable current equity out of the curve and explains why", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const cashOnly = { ...journal, curve: { ...journal.curve, points: journal.curve.points.filter((point) => point.basis === "cash-realized") } };
    const staleRobot = structuredClone(projection.robots[0]!);
    staleRobot.metrics.equity = {
      status: "stale",
      lastValue: "1020.000000",
      observedAt: 1_719_000_000_000,
      source: "expired-mark",
      staleByMs: 60_000,
      reason: "Mark expired"
    };

    await act(async () => root.render(<PaperCashCurve robot={staleRobot} journal={cashOnly} locale="en" />));
    expect(host.querySelector(".paper-curve-current")).toBeNull();
    expect(host.textContent).toContain(paperPortfolioText("en", "currentEquityStale"));
    expect(host.textContent).toContain("Mark expired");
    expect(host.textContent).toContain("1,020");

    const unavailableRobot = structuredClone(staleRobot);
    unavailableRobot.metrics.equity = { status: "unavailable", reason: "No durable mark" };
    await act(async () => root.render(<PaperCashCurve robot={unavailableRobot} journal={cashOnly} locale="ru" />));
    expect(host.querySelector(".paper-curve-current")).toBeNull();
    expect(host.textContent).toContain(paperPortfolioText("ru", "currentEquityMissing"));
    expect(host.textContent).toContain("No durable mark");
    await act(async () => root.unmount());
  });

  it("provides all journal labels in EN, RU and KK and responsive 44/48px keyboard targets", () => {
    for (const locale of ["en", "ru", "kk"] as const satisfies readonly Locale[]) {
      for (const key of ["analytics", "cashCurve", "cashCurveHint", "recentFills", "recentEvents", "truncatedWindow"] as const) {
        expect(paperPortfolioText(locale, key)).toBeTruthy();
      }
    }
    const css = readFileSync(path.resolve(process.cwd(), "frontend/src/styles/paper-portfolio-journal.css"), "utf8");
    expect(css).toMatch(/paper-journal-disclosure > summary[\s\S]*min-block-size:\s*44px/);
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*min-block-size:\s*48px/);
    expect(css).toMatch(/@container \(max-width: 360px\)/);
  });
});

async function click(element: HTMLElement): Promise<void> {
  await act(async () => { element.click(); await Promise.resolve(); });
}
