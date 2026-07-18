import { expect, test, type Page } from "@playwright/test";
import {
  installR9cGalleryFixture,
  R9C_CSRF,
  R9C_DATASET_FINGERPRINT,
  R9C_ENTRY_ID,
  R9C_ENTRY_TITLE,
  R9C_OWNER_ID
} from "./support/r9cGalleryFixture";

test.use({ colorScheme: "dark", locale: "en-US", timezoneId: "UTC" });

test.describe("R9.3 versioned strategy gallery", () => {
  test("publishes a library artifact after the sanitization preview and imports a feed card into a revalidation-gated copy", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await installR9cGalleryFixture(page);
    await page.addInitScript(() => {
      localStorage.setItem("sbv2:locale", "en");
      localStorage.setItem("mf:theme", "dark");
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await openStrategyWorkspace(page);
    await expect(page.locator(".strategy-lab")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Community", exact: true }).click();

    // The feed card renders provenance and the rating breakdown (never a bare
    // return number) before any interaction.
    const panel = page.locator(".gallery-server-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    const card = panel.locator(".gallery-server-card");
    await expect(card).toContainText(R9C_ENTRY_TITLE, { timeout: 20_000 });
    await expect(card).toContainText("Server-evaluated out-of-sample evidence");
    await expect(card).toContainText(R9C_DATASET_FINGERPRINT.slice(0, 16));
    await expect(card).toContainText("Rating: 62/100");
    await expect(card).toContainText("OOS stability");
    await expect(card).toContainText("never a net-profit-only ranking");

    // Publish from the library: the dialog shows the EXACT canonical document
    // that will be hashed and published; the action stays locked until the
    // explicit consent checkbox is ticked.
    await panel.getByRole("button", { name: "Publish…", exact: true }).click();
    const publishDialog = page.locator(".gallery-publish-dialog");
    await expect(publishDialog).toBeVisible({ timeout: 20_000 });
    const canonical = publishDialog.locator(".gallery-preview-canonical");
    await expect(canonical).toBeVisible({ timeout: 20_000 });
    await expect(canonical).toContainText('"schemaVersion":"gallery-artifact-v1"');
    await expect(canonical).toContainText('"source":"self-reported"');

    const publishAction = publishDialog.getByRole("button", { name: "Publish", exact: true });
    await expect(publishAction).toBeDisabled();
    await publishDialog.locator('input[name="gallery-consent"]').check();
    await expect(publishAction).toBeEnabled();
    await publishAction.click();
    await expect(publishDialog).toBeHidden({ timeout: 20_000 });
    await expect(panel).toContainText("Published", { timeout: 20_000 });

    // Exact publish POST body: only the whitelisted envelope, never an owner id.
    const publish = fixture.galleryRequests.find((request) => request.method === "POST" && request.path === "/api/gallery/publish");
    expect(publish).toMatchObject({ ownerHeader: R9C_OWNER_ID, csrfHeader: R9C_CSRF });
    expect(Object.keys(publish!.body!).sort()).toEqual(["source", "summary", "title", "visibility"]);
    expect(publish!.body).toMatchObject({ title: "Price Cross EMA", summary: "", visibility: "private" });
    const source = publish!.body!.source as { type: string; artifact: { ir: Record<string, unknown> } };
    expect(source.type).toBe("library");
    expect(Object.keys(source.artifact)).toEqual(["ir"]);
    expect(Object.keys(source.artifact.ir).sort()).toEqual(["body", "inputs", "name", "v"]);
    expect(source.artifact.ir.name).toBe("Price Cross EMA");
    expect(JSON.stringify(publish!.body)).not.toContain(R9C_OWNER_ID);

    // Import: the bundle's sha256 is re-verified in the browser, the review
    // dialog gates the copy and the library gains a revalidation-locked item.
    await card.getByRole("button", { name: `Import: ${R9C_ENTRY_TITLE}` }).click();
    const review = page.locator(".gallery-import-review-dialog");
    await expect(review).toBeVisible({ timeout: 20_000 });
    await expect(review).toContainText("Content hash verified on the server and in this browser.");
    await expect(review).toContainText(fixture.feedArtifactHash);
    await expect(review).toContainText("Paper start stays locked for the copy until a local validation and backtest complete.");
    await review.getByRole("button", { name: "Import as local copy", exact: true }).click();
    await expect(review).toBeHidden({ timeout: 20_000 });
    await expect(panel).toContainText("Copy added to the library", { timeout: 20_000 });

    const importRequest = fixture.galleryRequests.find((request) => request.path === `/api/gallery/${R9C_ENTRY_ID}/import`);
    expect(importRequest).toMatchObject({ method: "GET", ownerHeader: R9C_OWNER_ID, query: { version: "1" } });

    await panel.getByRole("button", { name: "Close strategy gallery" }).click();
    await expect(panel).toBeHidden({ timeout: 20_000 });
    const library = page.locator(".strategy-library");
    await expect(library).toContainText(R9C_ENTRY_TITLE, { timeout: 20_000 });
    await expect(library.locator(".library-item-revalidation")).toContainText("Revalidation required");

    expect(fixture.violations).toEqual([]);
    expect(fixture.base.violations).toEqual([]);
  });
});

async function openStrategyWorkspace(page: Page): Promise<void> {
  const navigation = page.locator(".workspace-navigation");
  await expect(navigation).toBeVisible({ timeout: 20_000 });
  const strategies = navigation.getByRole("button", { name: "Strategies", exact: true });
  if (await strategies.isVisible()) {
    await strategies.click();
    return;
  }
  await navigation.getByRole("button", { name: "Automation", exact: true }).click();
  await expect(strategies).toBeVisible({ timeout: 20_000 });
  await strategies.click();
}
