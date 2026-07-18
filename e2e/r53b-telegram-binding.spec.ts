import { expect, test, type Page } from "@playwright/test";
import { R52_CSRF, R52_OWNER_ID } from "./support/r52ScreenerFixture";
import {
  installR53bTelegramBindingFixture,
  R53B_BINDING_CODE,
  R53B_BINDING_HANDLE,
  R53B_BINDING_ID,
  R53B_BINDING_REVISION,
  R53B_CODE_EXPIRES_AT,
  type R53bTelegramBindingFixture
} from "./support/r53bTelegramBindingFixture";

test.use({ colorScheme: "dark", locale: "en-US", timezoneId: "UTC" });

test.describe("R5.3b Telegram binding lifecycle", () => {
  test("desktop issues a one-time binding code, arms telegram delivery and revokes the binding", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await openAlertsPanel(page);

    const alerts = page.getByRole("region", { name: "Price alerts" });
    await expect(alerts.locator(".alert-sync-summary")).toContainText("Server alerts synced", { timeout: 20_000 });

    const telegramSection = alerts.locator("details.telegram-bindings");
    await expect(telegramSection.locator("summary")).toContainText("Telegram delivery · linked", { timeout: 20_000 });
    await telegramSection.locator("summary").click();
    const bindingRow = telegramSection.locator(".telegram-binding-item");
    await expect(bindingRow).toContainText("active");
    await expect(bindingRow).toContainText(R53B_BINDING_HANDLE);

    // One-time code: the raw code renders exactly once, with its expiry.
    await telegramSection.getByRole("button", { name: "Create binding code" }).click();
    const codePanel = telegramSection.locator(".telegram-code");
    await expect(codePanel).toContainText("This code is shown only once.");
    await expect(codePanel.locator("code")).toHaveText(R53B_BINDING_CODE);
    await expect(codePanel.locator("time")).toHaveAttribute("datetime", R53B_CODE_EXPIRES_AT);
    const codeOccurrences = await page.evaluate((code) => document.body.innerText.split(code).length - 1, R53B_BINDING_CODE);
    expect(codeOccurrences).toBe(1);

    const codeCreate = fixture.bindingRequests.find((request) => request.path === "/api/alerts/bindings/codes");
    expect(codeCreate).toMatchObject({
      method: "POST",
      ownerHeader: R52_OWNER_ID,
      csrfHeader: R52_CSRF,
      body: {}
    });

    // The outstanding-code quota answers the second create and the stale raw
    // code disappears instead of lingering next to the error.
    await telegramSection.getByRole("button", { name: "Create binding code" }).click();
    await expect(telegramSection.getByRole("alert")).toContainText("Too many unused codes.");
    await expect(codePanel).toHaveCount(0);

    // While the binding is active the telegram channel arms a new price alert.
    const toggle = alerts.getByLabel("Also deliver this alert to Telegram");
    await expect(toggle).toBeEnabled();
    await toggle.check();
    await alerts.getByLabel("Alert price for BTCUSDT").fill("70000");
    await alerts.getByRole("button", { name: "Add", exact: true }).click();
    const priceAlertList = alerts.locator(".alert-list:not(.telegram-binding-list)");
    await expect(priceAlertList.locator(".alert-price")).toHaveText("70000.00", { timeout: 20_000 });
    // The reconciler round trip (create disabled -> fenced enable) must finish
    // before the revoke so no telegram-armed mutation trails a dead binding.
    await expect(priceAlertList.locator(".alert-source-badge")).toHaveText("Server", { timeout: 20_000 });

    expect(fixture.alertCreates).toHaveLength(1);
    const create = fixture.alertCreates[0]!;
    expect(create).toMatchObject({
      method: "POST",
      path: "/api/alerts",
      ownerHeader: R52_OWNER_ID,
      csrfHeader: R52_CSRF
    });
    const definition = (create.body as { definition: Record<string, unknown> }).definition;
    expect(definition).toMatchObject({
      schemaVersion: "alert-rule-v1",
      kind: "price-threshold",
      symbol: "BTCUSDT",
      direction: "above",
      threshold: "70000",
      enabled: false,
      deliveryChannels: ["in-app", "telegram"],
      researchOnly: true,
      executionPermission: false
    });
    expect(fixture.alertUpdates).toHaveLength(1);
    expect(fixture.alertUpdates[0]).toMatchObject({
      method: "PUT",
      ownerHeader: R52_OWNER_ID,
      csrfHeader: R52_CSRF,
      body: { expectedRevision: 1 }
    });
    const enabledDefinition = (fixture.alertUpdates[0]!.body as { definition: Record<string, unknown> }).definition;
    expect(enabledDefinition).toMatchObject({
      enabled: true,
      deliveryChannels: ["in-app", "telegram"]
    });

    // Two-step revoke; the fixture fences on the exact current revision.
    await telegramSection.getByRole("button", { name: `Revoke Telegram binding ${R53B_BINDING_HANDLE}` }).click();
    await telegramSection.getByRole("button", { name: "Confirm revoke" }).click();
    await expect(bindingRow).toContainText("revoked");
    await expect(telegramSection.locator("summary")).toContainText("not linked");

    const revoke = fixture.bindingRequests.find((request) => request.path === `/api/alerts/bindings/${R53B_BINDING_ID}/revoke`);
    expect(revoke).toMatchObject({
      method: "POST",
      ownerHeader: R52_OWNER_ID,
      csrfHeader: R52_CSRF,
      body: { expectedRevision: R53B_BINDING_REVISION }
    });

    // A revoked owner loses the channel choice and gets the binding hint back.
    await expect(toggle).toBeDisabled();
    await expect(toggle).not.toBeChecked();
    await expect(alerts.getByText("Link a Telegram chat in the Telegram delivery section")).toBeVisible();

    expect(fixture.violations).toEqual([]);
    expect(fixture.unexpectedApiRequests).toEqual([]);
  });
});

async function openAlertsPanel(page: Page): Promise<R53bTelegramBindingFixture> {
  const fixture = await installR53bTelegramBindingFixture(page);
  await page.addInitScript(() => {
    localStorage.setItem("sbv2:locale", "en");
    localStorage.setItem("mf:theme", "dark");
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("region", { name: "Price alerts" })).toBeVisible({ timeout: 20_000 });
  return fixture;
}
