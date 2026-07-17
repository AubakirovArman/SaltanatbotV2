import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";
import {
  installR4PaperPortfolioFixture,
  R4_ARCHIVE_PORTFOLIO_ID,
  R4_OWNER_ID,
  R4_PRIMARY_PORTFOLIO_ID,
  type R4PaperPortfolioFixture
} from "./support/r4PaperPortfolioFixture";

test.use({ colorScheme: "dark", locale: "en-US", timezoneId: "UTC" });

test.describe("R4 canonical paper portfolio center", () => {
  test("desktop covers durable journal, robot confirmation and the complete portfolio lifecycle", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await openPaperPortfolioCenter(page);

    const center = page.locator(".paper-portfolio-center");
    await expect(center.getByRole("heading", { name: "Paper portfolios", exact: true })).toBeVisible();
    await expect(center.getByRole("region", { name: "Portfolio" })).toContainText("Primary Paper");
    await expect(center.getByRole("region", { name: "Portfolio" })).toContainText("Default");
    await expect(center.getByRole("table", { name: "Robots" })).toBeVisible();
    await expect(center.locator(".paper-robot-cards")).toBeHidden();
    await assertTimeframeControlContainsTrigger(page);
    await assertNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);
    await captureAudit(page, "01-desktop-portfolio-list.png");

    const robotTrigger = center.locator(".paper-robot-open").filter({ hasText: "Momentum Guardian" });
    await robotTrigger.click();
    const drawer = page.getByRole("dialog", { name: "Momentum Guardian" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("img", { name: /Realized cash curve/u })).toBeVisible();
    await expectNoAxeViolations(page);
    await captureAudit(page, "02a-desktop-equity-curve.png");
    await expect(drawer).toContainText("Historical points use persisted current-epoch cash events");
    await expect(drawer.getByRole("note").filter({ hasText: "Current equity evidence is stale" })).toBeVisible();
    await expect(drawer.locator(".paper-evidence-notice")).toContainText([
      "No durable paper margin evidence exists.",
      "No durable paper borrowing evidence exists."
    ]);

    await openDisclosure(drawer, "Performance and risk");
    await expect(drawer.locator(".paper-analytics-grid")).toContainText("Closed trades");
    await expect(drawer.locator(".paper-analytics-grid")).toContainText("Profit factor");
    await openDisclosure(drawer, "Recent fills");
    await expect(drawer.getByRole("list", { name: "Recent fills" }).getByRole("listitem")).toHaveCount(2);
    await expect(drawer.getByRole("list", { name: "Recent fills" })).toContainText("BTCUSDT");
    await openDisclosure(drawer, "Recent ledger events");
    await expect(drawer.getByRole("list", { name: "Recent ledger events" }).getByRole("listitem")).toHaveCount(4);
    await expect(drawer.getByRole("list", { name: "Recent ledger events" })).toContainText("Command completed");
    await captureAudit(page, "02-desktop-robot-detail-journal.png");

    await drawer.getByRole("button", { name: "Pause", exact: true }).click();
    const actionDialog = page.getByRole("dialog", { name: "Confirm robot action" });
    await expect(actionDialog).toContainText("Ledger epoch");
    await expect(actionDialog).toContainText("Revision");
    await captureAudit(page, "03-desktop-robot-action-confirmation.png");
    await actionDialog.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(actionDialog).toBeHidden();
    await expect(drawer.locator(".paper-robot-status")).toContainText("Paused");
    await expect.poll(() => actionRequests(fixture).length).toBe(1);
    expect(actionRequests(fixture)[0]).toMatchObject({
      method: "POST",
      ownerHeader: R4_OWNER_ID,
      csrfHeader: "csrf-r4-paper",
      body: {
        expectedPortfolioRevision: 1,
        expectedLedgerEpoch: 1,
        expectedBotRevision: 7,
        action: "pause",
        confirm: true
      }
    });
    expect(actionRequests(fixture)[0]!.idempotencyKey).toBeTruthy();

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(robotTrigger).toBeFocused();

    await openPortfolioMenu(center);
    await center.getByRole("button", { name: "Create portfolio", exact: true }).click();
    const createDialog = page.getByRole("dialog", { name: "Create portfolio" });
    await createDialog.getByLabel("Name").fill("R4 Sandbox");
    await createDialog.getByLabel("Initial capital (USDT)").fill("12345.678901");
    await captureAudit(page, "04-desktop-create-portfolio.png");
    await createDialog.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(createDialog).toBeHidden();
    const selector = center.locator(".paper-portfolio-selector select");
    await expect.poll(() => selector.locator("option:checked").textContent()).toContain("R4 Sandbox");
    await expect(center.getByRole("heading", { name: "No robots in this portfolio" })).toBeVisible();

    await openPortfolioMenu(center);
    await center.getByRole("button", { name: "Rename", exact: true }).click();
    const renameDialog = page.getByRole("dialog", { name: "Rename" });
    await renameDialog.getByLabel("Name").fill("R4 Renamed");
    await renameDialog.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(renameDialog).toBeHidden();
    await expect.poll(() => selector.locator("option:checked").textContent()).toContain("R4 Renamed");

    await openPortfolioMenu(center);
    await center.getByRole("button", { name: "Make default", exact: true }).click();
    await expect.poll(() => selector.locator("option:checked").textContent()).toContain("Default");
    await closePortfolioMenu(center);

    await openPortfolioMenu(center);
    await center.getByRole("button", { name: "Reset ledger", exact: true }).click();
    const resetDialog = page.getByRole("dialog", { name: "Start a new ledger epoch?" });
    await resetDialog.getByLabel("Type the portfolio name to confirm").fill("R4 Renamed");
    await resetDialog.getByLabel("Initial capital (USDT)").fill("15000");
    await resetDialog.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(resetDialog).toBeHidden();
    await expect.poll(async () => fixture.portfolio(await selector.inputValue())?.currentEpoch).toBe(2);

    await selector.selectOption(R4_ARCHIVE_PORTFOLIO_ID);
    await expect(center.getByRole("region", { name: "Portfolio" })).toContainText("Archive Candidate");
    await openPortfolioMenu(center);
    await center.getByRole("button", { name: "Archive", exact: true }).click();
    const archiveDialog = page.getByRole("dialog", { name: "Archive portfolio?" });
    await archiveDialog.getByLabel("Type the portfolio name to confirm").fill("Archive Candidate");
    await archiveDialog.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(archiveDialog).toBeHidden();
    await expect(center.getByRole("region", { name: "Portfolio" })).toContainText("Archived");
    await expect.poll(() => fixture.portfolio(R4_ARCHIVE_PORTFOLIO_ID)?.status).toBe("archived");

    fixture.failNextDetailRefresh();
    await center.getByRole("button", { name: "Refresh paper portfolio" }).click();
    const staleAlert = center.locator(".paper-center-alert.stale");
    await expect(staleAlert).toContainText("Showing the last verified snapshot");
    await expect(center.getByRole("region", { name: "Portfolio" })).toContainText("Archive Candidate");
    await captureAudit(page, "05-desktop-stale-fallback.png");

    expect(fixture.violations).toEqual([]);
    expect(fixture.unexpectedApiRequests).toEqual([]);
    expect(fixture.requests.filter((request) => request.method !== "GET")).toHaveLength(6);
    for (const request of fixture.requests.filter((candidate) => candidate.method !== "GET")) {
      expect(request.ownerHeader).toBe(R4_OWNER_ID);
      expect(request.csrfHeader).toBe("csrf-r4-paper");
      expect(request.idempotencyKey).toBeTruthy();
    }
  });

  test("390x844 mobile keeps the collapsed summary and journal bottom sheet reachable", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const fixture = await openPaperPortfolioCenter(page);
    const center = page.locator(".paper-portfolio-center");
    const summary = center.getByRole("region", { name: "Portfolio" });
    await expect(summary.getByRole("button", { name: "Show summary" })).toHaveAttribute("aria-expanded", "false");
    await summary.getByRole("button", { name: "Show summary" }).click();
    await expect(summary).toContainText("Gross exposure");
    await expect(center.locator(".paper-robot-table-wrap")).toBeHidden();
    await expect(center.locator(".paper-robot-cards")).toBeVisible();
    await assertMinimumTouchTargets(page.locator(
      ".trade-sidebar-actions button:visible, .trade-bot-row:visible, .robots-center-actions .secondary-button:visible, .paper-portfolio-menu > summary:visible"
    ), 44);
    await assertNoHorizontalOverflow(page);

    const robotTrigger = center.locator(".paper-robot-card-open").filter({ hasText: "Momentum Guardian" });
    await robotTrigger.click();
    const drawer = page.getByRole("dialog", { name: "Momentum Guardian" });
    await expect(drawer.getByRole("button", { name: "Close robot details" })).toBeFocused();
    await assertContainedInViewport(drawer, 390, 844);
    const curve = drawer.getByRole("img", { name: /Realized cash curve/u });
    await curve.scrollIntoViewIfNeeded();
    await expect(curve).toBeVisible();
    await captureAudit(page, "06a-mobile-equity-curve.png");
    const scroll = drawer.locator(".paper-detail-scroll");
    await openDisclosure(drawer, "Performance and risk");
    await openDisclosure(drawer, "Recent fills");
    await openDisclosure(drawer, "Recent ledger events");
    await drawer.getByRole("list", { name: "Recent ledger events" }).scrollIntoViewIfNeeded();
    await expect(drawer.getByRole("list", { name: "Recent ledger events" })).toBeVisible();
    await expect(drawer).toContainText("No durable paper borrowing evidence exists.");
    const scrollGeometry = await scroll.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop
    }));
    expect(scrollGeometry.scrollHeight).toBeGreaterThan(scrollGeometry.clientHeight);
    expect(scrollGeometry.scrollTop).toBeGreaterThan(0);
    await assertMinimumTouchTargets(drawer.locator("button:visible"), 44);
    await captureAudit(page, "06-mobile-390-bottom-sheet-journal.png");

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(robotTrigger).toBeFocused();
    await assertNoHorizontalOverflow(page);
    expect(fixture.violations).toEqual([]);
    expect(fixture.unexpectedApiRequests).toEqual([]);
  });

  test("320x700 narrow mobile contains the menu, lifecycle dialog and full drawer scroll range", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    const fixture = await openPaperPortfolioCenter(page);
    const center = page.locator(".paper-portfolio-center");
    await expect(page.locator(".trade-bot-empty-note")).toBeHidden();
    await assertNoHorizontalOverflow(page);

    const menuTrigger = center.locator(".paper-portfolio-menu > summary");
    await menuTrigger.click();
    const menu = center.locator(".paper-portfolio-menu > div");
    await expect(menu).toBeVisible();
    await assertContainedInViewport(menu, 320, 700);
    await captureAudit(page, "07-narrow-320-portfolio-menu.png");
    await menu.getByRole("button", { name: "Create portfolio", exact: true }).click();
    const createDialog = page.getByRole("dialog", { name: "Create portfolio" });
    await assertContainedInViewport(createDialog, 320, 700);
    await expect(createDialog.getByLabel("Name")).toBeFocused();
    await createDialog.getByLabel("Name").fill("Escape check");
    await page.keyboard.press("Escape");
    await expect(createDialog).toBeHidden();
    await expect(menuTrigger).toBeFocused();

    const robotTrigger = center.locator(".paper-robot-card-open").filter({ hasText: "Momentum Guardian" });
    await robotTrigger.scrollIntoViewIfNeeded();
    await robotTrigger.click();
    const drawer = page.getByRole("dialog", { name: "Momentum Guardian" });
    await assertContainedInViewport(drawer, 320, 700);
    const lastActions = drawer.locator(".paper-robot-actions").last();
    await lastActions.scrollIntoViewIfNeeded();
    await expect(lastActions.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await expect(lastActions.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await assertMinimumTouchTargets(lastActions.getByRole("button"), 44);
    await assertNoHorizontalOverflow(page);
    await captureAudit(page, "08-narrow-320-drawer-actions.png");

    await drawer.getByRole("button", { name: "Close robot details" }).click();
    await expect(drawer).toBeHidden();
    await expect(robotTrigger).toBeFocused();
    expect(fixture.portfolio(R4_PRIMARY_PORTFOLIO_ID)?.currentEpoch).toBe(1);
    expect(fixture.violations).toEqual([]);
    expect(fixture.unexpectedApiRequests).toEqual([]);
  });
});

async function openPaperPortfolioCenter(page: Page): Promise<R4PaperPortfolioFixture> {
  const fixture = await installR4PaperPortfolioFixture(page);
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
  await expect(page.getByRole("region", { name: "Running robots" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Paper portfolios", exact: true })).toBeVisible({ timeout: 20_000 });
  return fixture;
}

async function openPortfolioMenu(center: Locator): Promise<void> {
  const details = center.locator(".paper-portfolio-menu");
  if ((await details.getAttribute("open")) === null) await details.locator(":scope > summary").click();
  await expect(details).toHaveAttribute("open", "");
}

async function closePortfolioMenu(center: Locator): Promise<void> {
  const details = center.locator(".paper-portfolio-menu");
  if ((await details.getAttribute("open")) !== null) await details.locator(":scope > summary").click();
  await expect(details).not.toHaveAttribute("open", "");
}

async function openDisclosure(drawer: Locator, label: string): Promise<void> {
  const details = drawer.locator(".paper-journal-disclosure").filter({ hasText: label });
  if ((await details.getAttribute("open")) === null) await details.locator(":scope > summary").click();
  await expect(details).toHaveAttribute("open", "");
}

function actionRequests(fixture: R4PaperPortfolioFixture) {
  return fixture.requests.filter((request) => request.path.endsWith("/actions"));
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentClient: document.documentElement.clientWidth,
    documentScroll: document.documentElement.scrollWidth,
    bodyScroll: document.body.scrollWidth
  }));
  expect(geometry.documentScroll).toBeLessThanOrEqual(geometry.documentClient + 1);
  expect(geometry.bodyScroll).toBeLessThanOrEqual(geometry.viewport + 1);
}

async function assertContainedInViewport(locator: Locator, width: number, height: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(height + 1);
}

async function assertMinimumTouchTargets(locator: Locator, minimum: number): Promise<void> {
  const boxes = await locator.evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { width: box.width, height: box.height };
  }));
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.width).toBeGreaterThanOrEqual(minimum);
    expect(box.height).toBeGreaterThanOrEqual(minimum);
  }
}

async function assertTimeframeControlContainsTrigger(page: Page): Promise<void> {
  const geometry = await page.locator(".timeframe-control").evaluate((control) => {
    const trigger = control.querySelector<HTMLElement>(".timeframe-more");
    if (!trigger) throw new Error("Timeframe overflow trigger is missing");
    const controlBox = control.getBoundingClientRect();
    const triggerBox = trigger.getBoundingClientRect();
    return {
      controlWidth: controlBox.width,
      triggerWidth: triggerBox.width,
      leftDelta: triggerBox.left - controlBox.left,
      rightDelta: controlBox.right - triggerBox.right
    };
  });
  expect(geometry.triggerWidth).toBeGreaterThanOrEqual(24);
  expect(geometry.controlWidth).toBeGreaterThan(0);
  expect(geometry.controlWidth).toBeGreaterThanOrEqual(geometry.triggerWidth);
  expect(geometry.leftDelta).toBeGreaterThanOrEqual(-1);
  expect(geometry.rightDelta).toBeGreaterThanOrEqual(-1);
}

async function captureAudit(page: Page, name: string): Promise<void> {
  const directory = process.env.R4_AUDIT_SCREENSHOT_DIR;
  if (!directory) return;
  await page.screenshot({ path: join(directory, name), animations: "disabled", caret: "hide" });
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    audit.violations,
    audit.violations.map((item) => `${item.id}: ${item.help} (${item.nodes.length})`).join("\n")
  ).toEqual([]);
}
