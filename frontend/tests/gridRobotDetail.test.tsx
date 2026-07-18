// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { parseGridParamsV1 } from "@saltanatbotv2/contracts";
import { enGrid } from "../src/i18n/en/grid";
import { ruGrid } from "../src/i18n/ru/grid";
import { PaperRobotGridSection } from "../src/trading/components/paper-portfolio/PaperRobotGridSection";
import { buildPaperRobotRows, PaperRobotViews } from "../src/trading/components/paper-portfolio/PaperRobotViews";
import { parsePaperPortfolioDetail } from "../src/trading/paperPortfolioParser";
import type { PaperRobotGridRuntime } from "../src/trading/paperPortfolioTypes";
import { detailResponse, ownerUserId, portfolioId } from "./paperPortfolioFixture";

const gridParams = parseGridParamsV1({
  schemaVersion: "grid-params-v1",
  mode: "neutral",
  spacing: "arithmetic",
  lowerBound: 100,
  upperBound: 200,
  gridLevels: 4,
  orderQuote: 50,
  outsideRangeAction: "pause",
  cooldownSeconds: 60,
  researchOnly: true,
  executionPermission: false
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("grid runtime metadata browser boundary", () => {
  it("parses the additive grid block leniently with canonical-money prices and signed inventory accepted", () => {
    const value = structuredClone(detailResponse);
    Reflect.set(value.robots[0]!, "grid", {
      schemaVersion: "grid-state-v1",
      phase: "active",
      mode: "neutral",
      spacing: "arithmetic",
      lowerBound: 100,
      upperBound: "200.000000",
      levelsTotal: 4,
      levelsResting: 2,
      levelsFilled: 1,
      levelsCooldown: 1,
      inventoryBaseQty: -0.75,
      inventoryAvgCost: "120.500000",
      realizedGridPnl: "-3.250000",
      cyclesCompleted: 5,
      updatedAt: 1_720_000_500_000,
      params: gridParams,
      unknownFutureField: { nested: true }
    });
    const parsed = parsePaperPortfolioDetail(value, ownerUserId, portfolioId);
    // A short grid's inventory is signed: negative values must survive parsing.
    expect(parsed.robots[0]?.grid).toEqual({
      phase: "active",
      mode: "neutral",
      spacing: "arithmetic",
      lowerBound: 100,
      upperBound: 200,
      levelsTotal: 4,
      levelsResting: 2,
      levelsFilled: 1,
      levelsCooldown: 1,
      inventoryBaseQty: -0.75,
      inventoryAvgCost: 120.5,
      realizedGridPnl: -3.25,
      cyclesCompleted: 5,
      params: gridParams
    });
  });

  it("drops malformed grid fields without failing the whole snapshot", () => {
    const value = structuredClone(detailResponse);
    Reflect.set(value.robots[0]!, "grid", {
      phase: "  ",
      mode: 5,
      spacing: null,
      lowerBound: "junk",
      upperBound: -5,
      levelsTotal: -1,
      levelsResting: 2.5,
      levelsFilled: "many",
      levelsCooldown: Number.NaN,
      inventoryBaseQty: "junk",
      inventoryAvgCost: 0,
      realizedGridPnl: Number.NaN,
      cyclesCompleted: "soon",
      stopReason: "   ",
      params: { schemaVersion: "grid-params-v1" }
    });
    expect(parsePaperPortfolioDetail(value, ownerUserId, portfolioId).robots[0]?.grid).toEqual({});

    const absent = structuredClone(detailResponse);
    expect(parsePaperPortfolioDetail(absent, ownerUserId, portfolioId).robots[0]?.grid).toBeUndefined();
    const scalar = structuredClone(detailResponse);
    Reflect.set(scalar.robots[0]!, "grid", "nope");
    expect(parsePaperPortfolioDetail(scalar, ownerUserId, portfolioId).robots[0]?.grid).toBeUndefined();
  });
});

describe("grid list and detail rendering", () => {
  it("badges grid robots in the robot list built from runtime metadata", async () => {
    const value = structuredClone(detailResponse);
    Reflect.set(value.robots[0]!, "grid", { phase: "active", mode: "neutral", levelsTotal: 4, params: gridParams });
    const parsed = parsePaperPortfolioDetail(value, ownerUserId, portfolioId);
    const rows = buildPaperRobotRows(parsed.snapshot.robots, parsed.robots);

    const { container, root } = await render(
      <PaperRobotViews rows={rows} locale="en" busy={false} actionsEnabled={false} onOpen={() => {}} onAction={() => {}} />
    );
    expect(container.querySelector(".paper-robot-table .ex-badge.grid")?.textContent).toBe(enGrid.typeBadge);
    await act(async () => root.unmount());
  });

  it("renders the grid section with localized phase, ladder counters and strictly separated PnLs", async () => {
    const runtime: PaperRobotGridRuntime = {
      phase: "active",
      mode: "neutral",
      spacing: "arithmetic",
      lowerBound: 100,
      upperBound: 200,
      levelsTotal: 4,
      levelsResting: 2,
      levelsFilled: 1,
      levelsCooldown: 1,
      inventoryBaseQty: 0.75,
      inventoryAvgCost: 120.5,
      realizedGridPnl: -3.25,
      cyclesCompleted: 5,
      params: gridParams
    };
    const inventoryPnl = { status: "available", value: "5.000000", observedAt: 1_720_000_000_000, source: "paper-ledger" } as const;
    const { container, root } = await render(<PaperRobotGridSection grid={runtime} inventoryPnl={inventoryPnl} locale="en" />);
    expect(container.textContent).toContain(enGrid.gridTitle);
    expect(container.textContent).toContain(enGrid.phaseActive);
    expect(container.textContent).toContain(enGrid.modeNeutral);
    expect(container.textContent).toContain("0.75");
    expect(container.textContent).toContain("120.5");
    expect(container.textContent).toContain("-3.25 USDT");
    // Realized grid PnL and the evidence-aware inventory mark stay separated.
    expect(container.querySelector(".paper-evidence.available")?.textContent).toContain("5 USDT");
    expect(container.textContent).toContain(enGrid.pnlSeparationNote);
    // Worst case 4 x 50 x 1.0005 from the shared contracts math.
    expect(container.querySelector(".paper-grid-params")?.textContent).toContain("200.1 USDT");
    expect(container.querySelector(".paper-grid-params")?.textContent).toContain(enGrid.researchNote);
    await act(async () => root.unmount());
  });

  it("renders unavailable fields, signed short inventory and unknown phases leniently per locale", async () => {
    const { container, root } = await render(<PaperRobotGridSection grid={{ phase: "paused", inventoryBaseQty: -0.75 }} locale="ru" />);
    expect(container.textContent).toContain(ruGrid.phasePaused);
    expect(container.textContent).toContain("-0,75");
    expect(container.textContent).toContain("Недоступно");
    expect(container.querySelector(".paper-evidence.unavailable")).not.toBeNull();
    expect(container.querySelector(".paper-grid-params")).toBeNull();
    await act(async () => root.unmount());

    const unknown = await render(<PaperRobotGridSection grid={{ phase: "future-phase", stopReason: "Halted by ops." }} locale="en" />);
    expect(unknown.container.textContent).toContain("future-phase");
    expect(unknown.container.textContent).toContain("Halted by ops.");
    await act(async () => unknown.root.unmount());
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
