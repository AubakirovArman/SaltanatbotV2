import { expect, test, type Page } from "@playwright/test";
import { R52_CSRF, R52_OWNER_ID, R52_SCREEN_TIMEFRAME } from "./support/r52ScreenerFixture";
import { installR53aScreenerAlertFixture, type R53aScreenerAlertFixture } from "./support/r53aScreenerAlertFixture";

test.use({ colorScheme: "dark", locale: "en-US", timezoneId: "UTC" });

test.describe("R5.3a screener alert promotion", () => {
  test("desktop promotes the current screen to a server alert with the exact rule envelope", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await openTechnicalScreener(page);

    const screener = page.getByRole("region", { name: "Technical screener" });
    await expect(screener.getByLabel("New filter type")).toHaveValue("rsi");
    await screener.getByRole("button", { name: "Add filter", exact: true }).click();
    await expect(screener.getByRole("group", { name: "Filter 2 · RSI" })).toBeVisible();

    // Run first so the promotion demonstrably covers the screen that was just
    // inspected, then promote the same definition to a server alert.
    await screener.getByRole("button", { name: "Run screen", exact: true }).click();
    await expect(screener.getByRole("table", { name: "Screen results" })).toBeVisible({ timeout: 20_000 });

    await screener.getByRole("button", { name: "Create alert from this screen" }).click();
    await expect(screener.locator(".tech-screener-alert-created")).toContainText("Server alert “Momentum screen” created", { timeout: 20_000 });

    expect(fixture.alertCreates).toHaveLength(1);
    const create = fixture.alertCreates[0]!;
    expect(create).toMatchObject({
      method: "POST",
      path: "/api/alerts",
      ownerHeader: R52_OWNER_ID,
      csrfHeader: R52_CSRF
    });
    const body = create.body as { clientId: string; definition: Record<string, unknown> };
    expect(Object.keys(body).sort()).toEqual(["clientId", "definition"]);
    expect(body.clientId).toMatch(/^screen-alert-[A-Za-z0-9][A-Za-z0-9._:-]{1,150}$/u);
    expect(body.definition).toEqual({
      schemaVersion: "alert-rule-v1",
      kind: "screener",
      name: "Momentum screen",
      enabled: true,
      cooldownSeconds: 3600,
      deliveryChannels: ["in-app"],
      screen: {
        schemaVersion: "screener-definition-v1",
        kind: "technical",
        name: "Momentum screen",
        exchange: "binance",
        marketType: "spot",
        priceType: "last",
        timeframe: R52_SCREEN_TIMEFRAME,
        universeLimit: 100,
        sort: { key: "quoteVolume24h", direction: "desc" },
        filters: [
          { kind: "quote-volume-24h", min: "1000000" },
          { kind: "rsi", period: 14, condition: "below", value: "30" }
        ],
        researchOnly: true,
        executionPermission: false
      },
      repeat: "on-change",
      researchOnly: true,
      executionPermission: false
    });

    // A second promotion answers the per-owner quota; the UI must surface the
    // 429 as an actionable error instead of pretending a rule was created.
    await screener.getByRole("button", { name: "Create alert from this screen" }).click();
    await expect(screener.getByRole("alert")).toContainText("Screen alert limit reached. Disable or archive one first.");
    expect(fixture.alertCreates).toHaveLength(2);
    const retryBody = fixture.alertCreates[1]!.body as { clientId: string } | undefined;
    expect(retryBody?.clientId).toMatch(/^screen-alert-/);
    expect(retryBody?.clientId).not.toBe(body.clientId);

    expect(fixture.violations).toEqual([]);
    expect(fixture.unexpectedApiRequests).toEqual([]);
  });
});

async function openTechnicalScreener(page: Page): Promise<R53aScreenerAlertFixture> {
  const fixture = await installR53aScreenerAlertFixture(page);
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
