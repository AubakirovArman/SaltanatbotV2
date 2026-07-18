import { expect, test, type Page } from "@playwright/test";
import { R4_OWNER_ID, R4_PRIMARY_PORTFOLIO_ID } from "./support/r4PaperPortfolioFixture";
import {
  installR8MultiLegFixture,
  r8HandoffRecord,
  r8OpportunityEnvelope,
  R8_HANDOFF_STORAGE_KEY,
  type R8MultiLegFixture
} from "./support/r8MultiLegFixture";

test.use({ colorScheme: "dark", locale: "en-US", timezoneId: "UTC" });

test.describe("R8 multi-leg paper intent journey", () => {
  test("runs a researched opportunity as a durable paper multi-leg intent with the exact POST body", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await openOpportunityResearchView(page);
    const panel = page.locator(".opportunity-research");

    // Research-only boundaries stay explicit; live execution stays blocked.
    await expect(panel.getByText("Research only", { exact: true })).toBeVisible();
    await expect(panel.getByText("Live execution blocked", { exact: true })).toBeVisible();
    await expect(panel).toContainText("n-leg-v1 · n-leg-opportunity:fixture");

    // The confirm dialog previews the exact server worst-case reservation.
    await panel.getByRole("button", { name: "Run paper multi-leg", exact: true }).click();
    const dialog = page.locator('.paper-dialog[role="dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Worst-case capital reserve");
    await expect(dialog).toContainText("1,020 USDT");
    await expect(dialog).toContainText("0.408 USDT");
    await expect(dialog).toContainText("1,020.408 USDT");
    const portfolioSelect = dialog.locator("select");
    await expect(portfolioSelect).toHaveValue(R4_PRIMARY_PORTFOLIO_ID);
    expect(fixture.submitRequests()).toHaveLength(0);

    await dialog.getByRole("button", { name: "Run paper multi-leg", exact: true }).click();
    await expect.poll(() => fixture.submitRequests().length).toBe(1);

    // Exact fenced POST body: the payload kind plus the untouched research
    // source echo — no credential fields, no live-execution flags.
    const submit = fixture.submitRequests()[0]!;
    expect(submit).toMatchObject({ ownerHeader: R4_OWNER_ID, csrfHeader: "csrf-r4-paper" });
    expect(submit.idempotencyKey).toBeTruthy();
    expect(submit.body).toEqual({
      kind: "paper-multi-leg.submit",
      source: { type: "n-leg", opportunity: r8OpportunityEnvelope() }
    });
    expect(JSON.stringify(submit.body)).not.toMatch(/apiKey|apiSecret|password|credential|"live":\s*"available"/i);

    // The durable intent lands in the portfolio center with the combined
    // both-legs-all-costs PnL and the explicit all-costs note.
    const center = page.locator(".paper-portfolio-center");
    await expect(center).toBeVisible({ timeout: 20_000 });
    const intents = center.locator(".paper-multi-leg-section");
    await expect(intents).toBeVisible();
    await expect(intents).toContainText("Multi-leg paper intents");
    await expect(intents).toContainText("Combined net PnL includes both legs and all modeled fees.");
    await expect(intents.locator(".paper-multi-leg-badge.completed")).toHaveText("Completed");
    await expect(intents).toContainText("+207.796 USDT");
    await expect(intents).toContainText("1,020.408 USDT");
    await expect(intents).toContainText("0.204 USDT");
    await expect(intents).toContainText("n-leg-opportunity:fixture");

    // Per-leg fills, fees and compensation stay one disclosure away.
    await intents.locator("details.paper-multi-leg-legs summary").first().click();
    const legRows = intents.locator(".paper-multi-leg-table tbody tr");
    await expect(legRows).toHaveCount(4);
    await expect(legRows.first()).toContainText("fixture:spot:M0");

    expect(fixture.multiLegViolations).toEqual([]);
    expect(fixture.base.violations).toEqual([]);
    expect(fixture.base.unexpectedApiRequests).toEqual([]);
  });
});

async function openOpportunityResearchView(page: Page): Promise<R8MultiLegFixture> {
  const fixture = await installR8MultiLegFixture(page);
  await page.clock.setFixedTime(new Date("2026-07-17T03:30:00.000Z"));
  const handoff = JSON.stringify(r8HandoffRecord());
  await page.addInitScript(({ key, record }) => {
    localStorage.setItem("sbv2:locale", "en");
    localStorage.setItem("mf:theme", "dark");
    sessionStorage.setItem(key, record);
  }, { key: R8_HANDOFF_STORAGE_KEY, record: handoff });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const navigation = page.getByRole("navigation", { name: "Primary workspaces" });
  await expect(navigation).toBeVisible({ timeout: 20_000 });
  const robots = navigation.getByRole("button", { name: "Robots", exact: true });
  if (!(await robots.isVisible())) {
    await navigation.getByRole("button", { name: "Automation", exact: true }).click();
    await expect(robots).toBeVisible();
  }
  await robots.click();
  // The pending research handoff replaces the portfolio center with the
  // opportunity view as soon as the trading shell authenticates.
  await expect(page.locator(".opportunity-research")).toBeVisible({ timeout: 20_000 });
  return fixture;
}
