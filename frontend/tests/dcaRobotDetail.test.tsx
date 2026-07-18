// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { parseDcaParamsV1 } from "@saltanatbotv2/contracts";
import { enDca } from "../src/i18n/en/dca";
import { ruDca } from "../src/i18n/ru/dca";
import { PaperRobotDcaSection } from "../src/trading/components/paper-portfolio/PaperRobotDcaSection";
import { buildPaperRobotRows, PaperRobotViews } from "../src/trading/components/paper-portfolio/PaperRobotViews";
import { parsePaperPortfolioDetail } from "../src/trading/paperPortfolioParser";
import type { PaperRobotDcaRuntime } from "../src/trading/paperPortfolioTypes";
import { detailResponse, ownerUserId, portfolioId } from "./paperPortfolioFixture";

const dcaParams = parseDcaParamsV1({
  schemaVersion: "dca-params-v1",
  direction: "long",
  baseOrderQuote: 100,
  safetyOrderQuote: 50,
  maxSafetyOrders: 3,
  priceDeviationPct: 1.5,
  stepScale: 1.2,
  volumeScale: 2,
  takeProfitPct: 2,
  cooldownSeconds: 300,
  researchOnly: true,
  executionPermission: false
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("dca runtime metadata browser boundary", () => {
  it("parses the additive dca block leniently with canonical-money prices accepted", () => {
    const value = structuredClone(detailResponse);
    Reflect.set(value.robots[0]!, "dca", {
      cycleState: "position",
      safetyOrdersFilled: 1,
      safetyOrdersTotal: 3,
      averageEntryPrice: 64_100.5,
      nextSafetyOrderPrice: "62000.500000",
      takeProfitPrice: 65_000.25,
      cooldownUntil: 1_720_000_500_000,
      params: dcaParams,
      unknownFutureField: { nested: true }
    });
    const parsed = parsePaperPortfolioDetail(value, ownerUserId, portfolioId);
    expect(parsed.robots[0]?.dca).toEqual({
      cycleState: "position",
      safetyOrdersFilled: 1,
      safetyOrdersTotal: 3,
      averageEntryPrice: 64_100.5,
      nextSafetyOrderPrice: 62_000.5,
      takeProfitPrice: 65_000.25,
      cooldownUntil: 1_720_000_500_000,
      params: dcaParams
    });
  });

  it("drops malformed dca fields without failing the whole snapshot", () => {
    const value = structuredClone(detailResponse);
    Reflect.set(value.robots[0]!, "dca", {
      cycleState: "  ",
      safetyOrdersFilled: -1,
      safetyOrdersTotal: 2.5,
      averageEntryPrice: "junk",
      nextSafetyOrderPrice: -5,
      takeProfitPrice: Number.NaN,
      cooldownUntil: "soon",
      params: { schemaVersion: "dca-params-v1" }
    });
    expect(parsePaperPortfolioDetail(value, ownerUserId, portfolioId).robots[0]?.dca).toEqual({});

    const absent = structuredClone(detailResponse);
    expect(parsePaperPortfolioDetail(absent, ownerUserId, portfolioId).robots[0]?.dca).toBeUndefined();
    const scalar = structuredClone(detailResponse);
    Reflect.set(scalar.robots[0]!, "dca", "nope");
    expect(parsePaperPortfolioDetail(scalar, ownerUserId, portfolioId).robots[0]?.dca).toBeUndefined();
  });
});

describe("dca list and detail rendering", () => {
  it("badges DCA robots in the robot list built from runtime metadata", async () => {
    const value = structuredClone(detailResponse);
    Reflect.set(value.robots[0]!, "dca", { cycleState: "position", safetyOrdersFilled: 1, safetyOrdersTotal: 3, params: dcaParams });
    const parsed = parsePaperPortfolioDetail(value, ownerUserId, portfolioId);
    const rows = buildPaperRobotRows(parsed.snapshot.robots, parsed.robots);

    const { container, root } = await render(
      <PaperRobotViews rows={rows} locale="en" busy={false} actionsEnabled={false} onOpen={() => {}} onAction={() => {}} />
    );
    expect(container.querySelector(".paper-robot-table .ex-badge.dca")?.textContent).toBe(enDca.typeBadge);
    await act(async () => root.unmount());
  });

  it("renders the cycle section with localized state, safety progress and the params worst case", async () => {
    const runtime: PaperRobotDcaRuntime = {
      cycleState: "position",
      safetyOrdersFilled: 1,
      safetyOrdersTotal: 3,
      averageEntryPrice: 64_100.5,
      nextSafetyOrderPrice: 62_000.5,
      takeProfitPrice: 65_000.25,
      params: dcaParams
    };
    const { container, root } = await render(<PaperRobotDcaSection dca={runtime} locale="en" />);
    expect(container.textContent).toContain(enDca.cycleTitle);
    expect(container.textContent).toContain(enDca.statePosition);
    expect(container.textContent).toContain("1 / 3");
    expect(container.textContent).toContain("64,100.5");
    expect(container.textContent).toContain("62,000.5");
    expect(container.textContent).toContain("65,000.25");
    // Worst case (100 + 50 + 100 + 200) * 1.0005 from the shared contracts math.
    expect(container.querySelector(".paper-dca-params")?.textContent).toContain("450.225 USDT");
    expect(container.querySelector(".paper-dca-params")?.textContent).toContain(enDca.researchNote);
    await act(async () => root.unmount());
  });

  it("renders unavailable fields and unknown states leniently, localized per locale", async () => {
    const { container, root } = await render(<PaperRobotDcaSection dca={{ cycleState: "cooldown" }} locale="ru" />);
    expect(container.textContent).toContain(ruDca.stateCooldown);
    expect(container.textContent).toContain("Недоступно");
    expect(container.querySelector(".paper-dca-params")).toBeNull();
    await act(async () => root.unmount());

    const stopped = await render(<PaperRobotDcaSection dca={{ cycleState: "stopped" }} locale="en" />);
    expect(stopped.container.textContent).toContain("stopped");
    await act(async () => stopped.root.unmount());
  });
});

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
    await Promise.resolve();
  });
  return { container, root };
}
