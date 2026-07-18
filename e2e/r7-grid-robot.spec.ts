import { expect, test, type Page } from "@playwright/test";
import { R4_OWNER_ID, R4_PRIMARY_PORTFOLIO_ID } from "./support/r4PaperPortfolioFixture";
import { installR6DcaRobotFixture, type R6DcaRobotFixture } from "./support/r6DcaRobotFixture";

test.use({ colorScheme: "dark", locale: "en-US", timezoneId: "UTC" });

/** The exact grid-params-v1 payload the default grid draft must POST. */
const EXPECTED_GRID_PARAMS = {
  schemaVersion: "grid-params-v1",
  mode: "neutral",
  spacing: "arithmetic",
  lowerBound: 100,
  upperBound: 200,
  gridLevels: 10,
  orderQuote: 100,
  recenter: "off",
  outsideRangeAction: "pause",
  cooldownSeconds: 300,
  researchOnly: true,
  executionPermission: false
} as const;

test.describe("R7 grid robot creation journey", () => {
  test("creates a paper grid robot through the worst-case gate with the level preview and exact POST body", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await openRobotsWorkspace(page);
    const form = page.locator("form.trade-form");

    // Toggle the robot type; grid is paper-only by construction.
    await form.locator(".dca-type-toggle").getByRole("button", { name: "Grid", exact: true }).click();
    await expect(form.locator(".grid-params")).toBeVisible();
    const exchange = form.locator('select[name="exchange"]');
    await expect(exchange).toHaveValue("paper");
    await expect(exchange).toBeDisabled();
    await expect(form.getByRole("note").filter({ hasText: "simulated paper exchange only" })).toBeVisible();

    // Live worst-case preview from the shared contracts math for the defaults.
    const worstCase = form.locator(".grid-worst-case");
    await expect(worstCase).toContainText("1,000.5 USDT");

    // Release criterion: the level-price preview is visible before start.
    const preview = form.locator(".grid-level-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("10 levels");
    const rows = preview.locator(".grid-level-row");
    await expect(rows).toHaveCount(10);
    await expect(rows.first()).toContainText("190.909091");
    await expect(rows.first().locator(".grid-level-side.sell")).toBeVisible();
    await expect(rows.last()).toContainText("109.090909");
    await expect(rows.last().locator(".grid-level-side.buy")).toBeVisible();

    await form.getByRole("textbox", { name: "Bot name" }).fill("R7 Grid robot");
    await expect(form.locator('select[name="paper-portfolio-id"]')).toHaveValue(R4_PRIMARY_PORTFOLIO_ID);

    // An allocation below the worst case blocks creation fail-closed.
    const allocation = form.locator('input[name="paper-allocation"]');
    await allocation.fill("1000.000000");
    await expect(form.getByRole("alert").filter({ hasText: "The worst case exceeds" })).toBeVisible();
    const createButton = form.getByRole("button", { name: "Create bot", exact: true });
    await expect(createButton).toBeDisabled();
    expect(fixture.createRequests()).toHaveLength(0);

    // Raising the allocation clears the gate and creates the robot.
    await allocation.fill("1200.000000");
    await expect(form.getByRole("alert").filter({ hasText: "The worst case exceeds" })).toHaveCount(0);
    await expect(createButton).toBeEnabled();
    await createButton.click();
    await expect.poll(() => fixture.createRequests().length).toBe(1);

    const create = fixture.createRequests()[0]!;
    expect(create).toMatchObject({ ownerHeader: R4_OWNER_ID, csrfHeader: "csrf-r4-paper" });
    expect(create.idempotencyKey).toBeTruthy();
    expect(create.body).toMatchObject({
      name: "R7 Grid robot",
      strategyName: "Grid BTCUSDT",
      kind: "grid",
      grid: EXPECTED_GRID_PARAMS,
      symbol: "BTCUSDT",
      timeframe: "1m",
      exchange: "paper",
      market: "futures",
      sizeMode: "quote",
      sizeValue: 100,
      leverage: 1,
      bybitCrossCollateral: false,
      notifyMarkers: true,
      paperPortfolioId: R4_PRIMARY_PORTFOLIO_ID,
      paperAllocation: "1200.000000",
      expectedPortfolioRevision: 1,
      expectedLedgerEpoch: 1
    });
    // Fail-closed shape: no strategy IR and no DCA payload travel with a grid
    // robot, and the grid payload carries exactly the versioned parameter set.
    expect(create.body).not.toHaveProperty("ir");
    expect(create.body).not.toHaveProperty("dca");
    expect(Object.keys(create.body!.grid as Record<string, unknown>).sort())
      .toEqual(Object.keys(EXPECTED_GRID_PARAMS).sort());

    // The new robot lands in the list with the grid badge and opens its detail.
    await expect(page.locator(".trade-detail-head strong")).toHaveText("R7 Grid robot", { timeout: 20_000 });
    await expect(page.locator(".trade-bot-id .ex-badge.grid").first()).toBeVisible();

    expect(fixture.botViolations).toEqual([]);
    expect(fixture.base.violations).toEqual([]);
    expect(fixture.base.unexpectedApiRequests).toEqual([]);
  });
});

async function openRobotsWorkspace(page: Page): Promise<R6DcaRobotFixture> {
  const fixture = await installR6DcaRobotFixture(page, { botIdPrefix: "paper-r7-grid-" });
  await page.clock.setFixedTime(new Date("2026-07-17T03:30:00.000Z"));
  await page.addInitScript(() => {
    localStorage.setItem("sbv2:locale", "en");
    localStorage.setItem("mf:theme", "dark");
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const navigation = page.getByRole("navigation", { name: "Primary workspaces" });
  await expect(navigation).toBeVisible({ timeout: 20_000 });
  const robots = navigation.getByRole("button", { name: "Robots", exact: true });
  if (!(await robots.isVisible())) {
    await navigation.getByRole("button", { name: "Automation", exact: true }).click();
    await expect(robots).toBeVisible();
  }
  await robots.click();
  // The trading shell opens on the portfolio center; the create form is one
  // deliberate click away behind the sidebar "New bot" button (the R6 lesson).
  const center = page.locator(".paper-portfolio-center");
  await expect(center).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "New bot", exact: true }).click();
  await expect(page.locator("form.trade-form")).toBeVisible({ timeout: 20_000 });
  return fixture;
}
