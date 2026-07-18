import { expect, test, type Page } from "@playwright/test";
import { R4_OWNER_ID, R4_PRIMARY_PORTFOLIO_ID } from "./support/r4PaperPortfolioFixture";
import { installR6DcaRobotFixture, type R6DcaRobotFixture } from "./support/r6DcaRobotFixture";

test.use({ colorScheme: "dark", locale: "en-US", timezoneId: "UTC" });

/** The exact dca-params-v1 payload the default DCA draft must POST. */
const EXPECTED_DCA_PARAMS = {
  schemaVersion: "dca-params-v1",
  direction: "long",
  baseOrderQuote: 100,
  safetyOrderQuote: 100,
  maxSafetyOrders: 5,
  priceDeviationPct: 1,
  stepScale: 1.4,
  volumeScale: 1.5,
  takeProfitPct: 1.5,
  cooldownSeconds: 300,
  researchOnly: true,
  executionPermission: false
} as const;

test.describe("R6 DCA robot creation journey", () => {
  test("creates a paper DCA robot through the worst-case gate with the exact fail-closed POST body", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await openRobotsWorkspace(page);
    const form = page.locator("form.trade-form");

    // Toggle the robot type; DCA is paper-only by construction.
    await form.locator(".dca-type-toggle").getByRole("button", { name: "DCA", exact: true }).click();
    await expect(form.locator(".dca-params")).toBeVisible();
    const exchange = form.locator('select[name="exchange"]');
    await expect(exchange).toHaveValue("paper");
    await expect(exchange).toBeDisabled();
    await expect(form.getByRole("note").filter({ hasText: "simulated paper exchange only" })).toBeVisible();

    // Live worst-case preview from the shared contracts math for the defaults.
    const worstCase = form.locator(".dca-worst-case");
    await expect(worstCase).toContainText("1,419.459375 USDT");

    await form.getByRole("textbox", { name: "Bot name" }).fill("R6 DCA robot");
    await expect(form.locator('select[name="paper-portfolio-id"]')).toHaveValue(R4_PRIMARY_PORTFOLIO_ID);

    // An allocation below the worst case blocks creation fail-closed.
    const allocation = form.locator('input[name="paper-allocation"]');
    await allocation.fill("1000.000000");
    await expect(form.getByRole("alert").filter({ hasText: "The worst case exceeds" })).toBeVisible();
    const createButton = form.getByRole("button", { name: "Create bot", exact: true });
    await expect(createButton).toBeDisabled();
    expect(fixture.createRequests()).toHaveLength(0);

    // Raising the allocation clears the gate and creates the robot.
    await allocation.fill("2000.000000");
    await expect(form.getByRole("alert").filter({ hasText: "The worst case exceeds" })).toHaveCount(0);
    await expect(createButton).toBeEnabled();
    await createButton.click();
    await expect.poll(() => fixture.createRequests().length).toBe(1);

    const create = fixture.createRequests()[0]!;
    expect(create).toMatchObject({ ownerHeader: R4_OWNER_ID, csrfHeader: "csrf-r4-paper" });
    expect(create.idempotencyKey).toBeTruthy();
    expect(create.body).toMatchObject({
      name: "R6 DCA robot",
      strategyName: "DCA BTCUSDT",
      kind: "dca",
      dca: EXPECTED_DCA_PARAMS,
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
      paperAllocation: "2000.000000",
      expectedPortfolioRevision: 1,
      expectedLedgerEpoch: 1
    });
    // Fail-closed shape: no strategy IR travels with a DCA robot, and the dca
    // payload carries exactly the versioned parameter set.
    expect(create.body).not.toHaveProperty("ir");
    expect(Object.keys(create.body!.dca as Record<string, unknown>).sort())
      .toEqual(Object.keys(EXPECTED_DCA_PARAMS).sort());

    // The new robot lands in the list with the DCA badge and opens its detail.
    await expect(page.locator(".trade-detail-head strong")).toHaveText("R6 DCA robot", { timeout: 20_000 });
    await expect(page.locator(".trade-bot-id .ex-badge.dca").first()).toBeVisible();

    expect(fixture.botViolations).toEqual([]);
    expect(fixture.base.violations).toEqual([]);
    expect(fixture.base.unexpectedApiRequests).toEqual([]);
  });
});

async function openRobotsWorkspace(page: Page): Promise<R6DcaRobotFixture> {
  const fixture = await installR6DcaRobotFixture(page);
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
  // deliberate click away.
  const center = page.locator(".paper-portfolio-center");
  await expect(center).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "New bot", exact: true }).click();
  await expect(page.locator("form.trade-form")).toBeVisible({ timeout: 20_000 });
  return fixture;
}
