import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";
import {
  installR52ScreenerFixture,
  R52_CSRF,
  R52_OWNER_ID,
  R52_SCREEN_TIMEFRAME,
  type R52ScreenerFixture
} from "./support/r52ScreenerFixture";

test.use({ colorScheme: "dark", locale: "en-US", timezoneId: "UTC" });

test.describe("R5.2.1 technical screener", () => {
  test("desktop runs a technical screen and opens a row on the chart with screen context", { tag: "@smoke" }, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await openTechnicalScreener(page);

    const screener = page.getByRole("region", { name: "Technical screener" });
    await expect(screener.getByText("Binance · spot · closed candles")).toBeVisible();
    await expect(screener.getByText("Research-only screen")).toBeVisible();
    await expect(screener.getByRole("group", { name: "Filter 1 · 24h turnover" })).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await captureAudit(page, "01-desktop-technical-form.png");

    await expect(screener.getByLabel("New filter type")).toHaveValue("rsi");
    await screener.getByRole("button", { name: "Add filter", exact: true }).click();
    await expect(screener.getByRole("group", { name: "Filter 2 · RSI" })).toBeVisible();
    await screener.getByLabel("New filter type").selectOption("atr-percent");
    await screener.getByRole("button", { name: "Add filter", exact: true }).click();
    await expect(screener.getByRole("group", { name: "Filter 3 · ATR %" })).toBeVisible();

    await screener.getByRole("button", { name: "Run screen", exact: true }).click();
    const results = screener.getByRole("table", { name: "Screen results" });
    await expect(results).toBeVisible({ timeout: 20_000 });
    await expect(results).toContainText("BTCUSDT");
    await expect(results).toContainText("ETHUSDT");
    await expect(results).toContainText("27.42");
    const summary = screener.locator(".arb-summary");
    await expect(summary).toContainText("Matched");
    await expect(summary.locator(".arb-summary-card").filter({ hasText: "Matched" })).toContainText("2");
    await expect(summary.locator(".arb-summary-card").filter({ hasText: "Unavailable" })).toContainText("2");
    await expect(screener.locator(".arb-notice.warning")).toContainText("Unavailable symbols (2): indicator-warm-up × 2");
    await assertNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);
    await captureAudit(page, "02-desktop-technical-results.png");

    expect(fixture.jobPolls()).toBeGreaterThanOrEqual(1);
    const enqueue = fixture.requests.find((request) => request.method === "POST" && request.path === "/api/jobs");
    expect(enqueue).toMatchObject({ ownerHeader: R52_OWNER_ID, csrfHeader: R52_CSRF });
    const body = enqueue!.body as {
      kind: string;
      clientRequestId: string;
      request: { schemaVersion: string; researchOnly: boolean; executionPermission: boolean; definition: { timeframe: string; filters: unknown } };
    };
    expect(body.kind).toBe("screener");
    expect(body.clientRequestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u);
    expect(body.request).toMatchObject({
      schemaVersion: "screener-run-request-v1",
      researchOnly: true,
      executionPermission: false
    });
    expect(body.request.definition.timeframe).toBe(R52_SCREEN_TIMEFRAME);
    expect(body.request.definition.filters).toEqual([
      { kind: "quote-volume-24h", min: "1000000" },
      { kind: "rsi", period: 14, condition: "below", value: "30" },
      { kind: "atr-percent", period: 14, condition: "above", value: "2" }
    ]);
    const presetList = fixture.requests.find((request) => request.method === "GET" && request.path === "/api/screener/presets");
    expect(presetList).toMatchObject({ ownerHeader: R52_OWNER_ID });

    // ETHUSDT is not the default chart instrument, so the handoff itself must
    // carry the symbol; the screen timeframe (1h) differs from the chart
    // default for the same reason.
    await results.getByRole("button", { name: "Open ETHUSDT chart with the screen timeframe and indicators" }).click();
    await expect(page.locator(".symbol-chip")).toContainText("ETHUSDT");
    // The active-chart region advertises symbol and timeframe together; the
    // inline timeframe segment can be collapsed behind "More timeframes" here.
    await expect(page.getByRole("region", { name: new RegExp(`Primary chart · ETHUSDT ${R52_SCREEN_TIMEFRAME}`, "u") })).toBeVisible();
    // RSI arrives with the screen context; ATR is disabled by default, so its
    // chip proves the definition's indicators were merged into the chart.
    await expect(page.locator(".indicator-chip").filter({ hasText: "RSI" })).toBeVisible();
    await expect(page.locator(".indicator-chip").filter({ hasText: "ATR" })).toBeVisible();
    await expect.poll(() => fixture.candleRequests.some((request) => request.symbol === "ETHUSDT" && request.timeframe === R52_SCREEN_TIMEFRAME)).toBe(true);
    await assertNoHorizontalOverflow(page);
    await captureAudit(page, "03-desktop-chart-handoff.png");

    expect(fixture.violations).toEqual([]);
    expect(fixture.unexpectedApiRequests).toEqual([]);
  });

  test("390x844 mobile keeps the technical screen form and result cards contained", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const fixture = await openTechnicalScreener(page);

    const screener = page.getByRole("region", { name: "Technical screener" });
    await expect(screener.getByRole("group", { name: "Filter 1 · 24h turnover" })).toBeVisible();
    await assertNoHorizontalOverflow(page);

    await screener.getByRole("button", { name: "Add filter", exact: true }).click();
    await expect(screener.getByRole("group", { name: "Filter 2 · RSI" })).toBeVisible();
    await screener.getByRole("button", { name: "Run screen", exact: true }).click();

    const viewSwitch = screener.getByRole("group", { name: "Switch results view" });
    await expect(viewSwitch).toBeVisible({ timeout: 20_000 });
    const cards = screener.getByRole("list", { name: "Screen results" });
    await expect(cards.getByRole("listitem")).toHaveCount(2);
    await expect(cards).toContainText("BTCUSDT");
    await expect(screener.locator(".arb-notice.warning")).toContainText("Unavailable symbols (2)");
    await assertNoHorizontalOverflow(page);
    await expectNoAxeViolations(page);
    await captureAudit(page, "04-mobile-390-technical-cards.png");

    await viewSwitch.getByRole("button", { name: "Table", exact: true }).click();
    await expect(screener.getByRole("table", { name: "Screen results" })).toBeVisible();
    await assertNoHorizontalOverflow(page);

    expect(fixture.violations).toEqual([]);
    expect(fixture.unexpectedApiRequests).toEqual([]);
  });
});

async function openTechnicalScreener(page: Page): Promise<R52ScreenerFixture> {
  const fixture = await installR52ScreenerFixture(page);
  await page.addInitScript(() => {
    localStorage.setItem("sbv2:locale", "en");
    localStorage.setItem("mf:theme", "dark");
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const navigation = page.getByRole("navigation", { name: "Primary workspaces" });
  await expect(navigation).toBeVisible({ timeout: 20_000 });
  await navigation.getByRole("button", { name: "Screener", exact: true }).click();
  await selectTechnicalMode(page);
  await expect(page.getByRole("heading", { name: "Technical screener", exact: true })).toBeVisible({ timeout: 20_000 });
  return fixture;
}

async function selectTechnicalMode(page: Page): Promise<void> {
  const trigger = page.locator(".arb-mode-trigger");
  await expect(trigger).toBeAttached({ timeout: 20_000 });
  if (await trigger.isVisible()) await trigger.click();
  await page.getByRole("group", { name: "Arbitrage scanner mode" }).getByRole("button", { name: "Technical screener", exact: true }).click();
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

async function expectNoAxeViolations(page: Page): Promise<void> {
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    audit.violations,
    audit.violations.map((item) => `${item.id}: ${item.help} (${item.nodes.length})`).join("\n")
  ).toEqual([]);
}

async function captureAudit(page: Page, name: string): Promise<void> {
  const directory = process.env.R52_AUDIT_SCREENSHOT_DIR;
  if (!directory) return;
  await page.screenshot({ path: join(directory, name), animations: "disabled", caret: "hide" });
}
