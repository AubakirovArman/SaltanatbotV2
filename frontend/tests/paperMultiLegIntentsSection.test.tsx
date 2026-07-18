// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enMultiLeg } from "../src/i18n/en/multiLeg";
import { kkMultiLeg } from "../src/i18n/kk/multiLeg";
import { ruMultiLeg } from "../src/i18n/ru/multiLeg";
import { PaperMultiLegIntentsSection } from "../src/trading/components/paper-portfolio/PaperMultiLegIntentsSection";
import { PaperPortfolioApiError } from "../src/trading/paperPortfolioClient";
import type { PaperMultiLegSection } from "../src/trading/paperPortfolioTypes";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const section: PaperMultiLegSection = {
  killSwitchEnabled: false,
  intents: [
    {
      intentId: "mleg-completed",
      status: "terminal",
      outcome: "completed",
      sourceEngine: "route-families-v1",
      sourceOpportunityId: "pairwise-opportunity:fixture",
      legCount: 2,
      reservedCapital: 1150.46,
      netPnl: 949.77,
      fees: 0.23,
      createdAt: 1_750_000_000_000,
      legs: [
        { venue: "fixture-a", instrumentId: "fixture-spot", side: "buy", plannedQuantity: 1, filledQuantity: 1, averagePrice: 100, fee: 0.02, compensated: false },
        { venue: "fixture-b", instrumentId: "fixture-future", side: "sell", plannedQuantity: 10, filledQuantity: 10, averagePrice: 105, fee: 0.21, compensated: false }
      ]
    },
    {
      intentId: "mleg-manual",
      status: "terminal",
      outcome: "manual-review-required",
      sourceEngine: "route-families-v1",
      sourceOpportunityId: "pairwise-opportunity:unwind",
      legCount: 2,
      reservedCapital: 1150.46,
      netPnl: -50.03,
      fees: 0.03,
      createdAt: 1_750_000_100_000,
      legs: [
        { venue: "fixture-a", instrumentId: "fixture-spot", side: "buy", plannedQuantity: 1, filledQuantity: 1, averagePrice: 100, fee: 0.03, compensated: true }
      ],
      residualExposure: [{ legId: "leg-long", instrumentId: "fixture-spot", quantityUnit: "base", quantity: 0.5 }]
    },
    { intentId: "mleg-running", status: "running", legs: [] }
  ]
};

function render(overrides: Partial<Parameters<typeof PaperMultiLegIntentsSection>[0]> = {}) {
  return renderToStaticMarkup(
    <PaperMultiLegIntentsSection
      locale="en"
      multiLeg={section}
      canMutate
      busy={false}
      onToggleKillSwitch={async () => {}}
      {...overrides}
    />
  );
}

describe("paper multi-leg intents section", () => {
  it("renders outcome badges, signed PnL, the all-costs note and per-leg disclosure", () => {
    const html = render();
    expect(html).toContain(enMultiLeg.intentsTitle);
    expect(html).toContain(enMultiLeg.pnlNote);
    expect(html).toContain(enMultiLeg.outcomeCompleted);
    expect(html).toContain(enMultiLeg.outcomeManualReview);
    expect(html).toContain(enMultiLeg.statusRunning);
    // Signed rendering: profit carries an explicit plus, loss an explicit minus.
    expect(html).toContain("+949.77 USDT");
    expect(html).toMatch(/[-−]50\.03 USDT/u);
    expect(html).toContain("1,150.46 USDT");
    // Per-leg disclosure with fills, fees and compensation flags.
    expect(html).toContain(enMultiLeg.legsDisclosure);
    expect(html).toContain("fixture-spot");
    expect(html).toContain("fixture-future");
    expect(html).toContain(enMultiLeg.sideBuy);
    expect(html).toContain(enMultiLeg.sideSell);
    expect(html).toContain(enMultiLeg.killSwitchOff);
  });

  it("always lists residual exposure for compensated and manual-review outcomes", () => {
    const html = render();
    expect(html).toContain(enMultiLeg.residualTitle);
    expect(html).toContain(enMultiLeg.residualNote);
    expect(html).toContain("0.5 base");
    // The fully-completed intent shows no residual block.
    const completedCard = html.slice(html.indexOf("mleg-completed"), html.indexOf("mleg-manual"));
    expect(completedCard).not.toContain(enMultiLeg.residualTitle);
  });

  it("renders absence as unavailable, never as zero", () => {
    const html = render({
      multiLeg: { intents: [{ intentId: "mleg-sparse", legs: [] }] }
    });
    expect(html).toContain(enMultiLeg.unavailable);
    expect(html).toContain(enMultiLeg.killSwitchUnknown);
    expect(html).not.toContain("0 USDT");
  });

  it("renders ru and kk catalogs", () => {
    const ru = render({ locale: "ru" });
    expect(ru).toContain(ruMultiLeg.intentsTitle);
    expect(ru).toContain(ruMultiLeg.pnlNote);
    expect(ru).toContain(ruMultiLeg.outcomeManualReview);
    expect(ru).toContain(ruMultiLeg.residualTitle);

    const kk = render({ locale: "kk" });
    expect(kk).toContain(kkMultiLeg.intentsTitle);
    expect(kk).toContain(kkMultiLeg.outcomeCompleted);
    expect(kk).toContain(kkMultiLeg.killSwitchOff);
  });

  it("shows the empty state without inventing intents", () => {
    const html = render({ multiLeg: { killSwitchEnabled: false, intents: [] } });
    expect(html).toContain(enMultiLeg.noIntents);
  });

  it("toggles the kill switch only through the confirm dialog", async () => {
    const onToggleKillSwitch = vi.fn(async () => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(
      <PaperMultiLegIntentsSection
        locale="en"
        multiLeg={section}
        canMutate
        busy={false}
        onToggleKillSwitch={onToggleKillSwitch}
      />
    ));

    const toggle = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes(enMultiLeg.killSwitchEnable))!;
    await act(async () => { toggle.click(); await Promise.resolve(); });
    const dialog = host.querySelector<HTMLElement>('.paper-dialog[role="dialog"]')!;
    expect(dialog.textContent).toContain(enMultiLeg.killSwitchConfirmEnable);
    expect(onToggleKillSwitch).not.toHaveBeenCalled();

    await act(async () => {
      dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(onToggleKillSwitch).toHaveBeenCalledExactlyOnceWith(true);
    expect(host.querySelector('.paper-dialog[role="dialog"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it("surfaces the exact rejection code when the kill switch change fails", async () => {
    const onToggleKillSwitch = vi.fn(async () => {
      throw new PaperPortfolioApiError(409, "multi_leg_kill_switch", "Submissions are disabled.");
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(
      <PaperMultiLegIntentsSection
        locale="en"
        multiLeg={{ killSwitchEnabled: true, intents: [] }}
        canMutate
        busy={false}
        onToggleKillSwitch={onToggleKillSwitch}
      />
    ));

    const toggle = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes(enMultiLeg.killSwitchDisable))!;
    await act(async () => { toggle.click(); await Promise.resolve(); });
    await act(async () => {
      host.querySelector('.paper-dialog[role="dialog"] form')!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(onToggleKillSwitch).toHaveBeenCalledExactlyOnceWith(false);
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("multi_leg_kill_switch");
    expect(alert?.textContent).toContain("Submissions are disabled.");
    await act(async () => root.unmount());
  });

  it("hides the toggle for read-only viewers while keeping the state visible", () => {
    const html = render({ canMutate: false, multiLeg: { killSwitchEnabled: true, intents: [] } });
    expect(html).toContain(enMultiLeg.killSwitchOn);
    expect(html).not.toContain(enMultiLeg.killSwitchDisable);
  });
});
