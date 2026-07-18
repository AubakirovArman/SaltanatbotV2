import { expect, test, type Page } from "@playwright/test";
import {
  installR9bGaEvolutionFixture,
  R9B_CLEAN_FINGERPRINT,
  R9B_CSRF,
  R9B_DATASET_FINGERPRINT,
  R9B_OVERFIT_FINGERPRINT,
  R9B_OWNER_ID,
  R9B_PROMOTED_NAME,
  R9B_RUN_ID
} from "./support/r9bGaEvolutionFixture";

test.use({ colorScheme: "dark", locale: "en-US", timezoneId: "UTC" });

test.describe("R9.2 server GA evolution", () => {
  test("starts a run, inspects the Pareto frontier and promotes the clean candidate into the library", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await installR9bGaEvolutionFixture(page);
    await page.addInitScript(() => {
      localStorage.setItem("sbv2:locale", "en");
      localStorage.setItem("mf:theme", "dark");
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await openStrategyWorkspace(page);
    await expect(page.locator(".strategy-lab")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Generator", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Algorithmic strategy generator" });
    await expect(dialog).toBeVisible({ timeout: 20_000 });

    // The server evolution section ships with bounded defaults; no run has
    // been fetched or started yet.
    const evolution = dialog.locator(".strategy-generator-server-evolution");
    await expect(evolution).toContainText("Server evolution (GA)");
    await expect(evolution.getByRole("checkbox", { name: "BTCUSDT" })).toBeChecked();
    await expect(evolution.getByRole("checkbox", { name: "ETHUSDT" })).toBeChecked();
    await expect(evolution.getByRole("checkbox", { name: "SOLUSDT" })).not.toBeChecked();

    await evolution.getByRole("button", { name: "Start server evolution", exact: true }).click();
    await expect(evolution.getByRole("list", { name: "Evolution runs" })).toBeVisible({ timeout: 20_000 });
    const runRow = evolution.locator(`[data-run-status="completed"]`);
    await expect(runRow).toBeVisible({ timeout: 20_000 });
    await expect(runRow).toContainText("Completed");
    await expect(runRow).toContainText(R9B_DATASET_FINGERPRINT.slice(0, 16));

    // Exact enqueue POST body: the spec payload and nothing else.
    const enqueue = fixture.gaRequests.find((request) => request.method === "POST" && request.path === "/api/jobs");
    expect(enqueue).toMatchObject({ ownerHeader: R9B_OWNER_ID, csrfHeader: R9B_CSRF });
    expect(enqueue!.body).toEqual({
      kind: "ga-evolution",
      mode: "start",
      config: {
        markets: ["BTCUSDT", "ETHUSDT"],
        timeframe: "1h",
        lookbackBars: 3_000,
        split: { trainFraction: 0.7, embargoBars: 8 },
        seed: 42,
        population: 16,
        generations: 4
      }
    });

    // The frontier lists both candidates: the overfit one is explicit and its
    // promotion is disabled with a visible reason; the clean one promotes.
    await runRow.getByRole("button", { name: `Pareto frontier: ${R9B_RUN_ID}` }).click();
    const frontier = evolution.locator(".strategy-generator-evolution-frontier");
    await expect(frontier).toBeVisible({ timeout: 20_000 });
    const cleanRow = frontier.locator(`[data-candidate-fingerprint="${R9B_CLEAN_FINGERPRINT}"]`);
    const overfitRow = frontier.locator(`[data-candidate-fingerprint="${R9B_OVERFIT_FINGERPRINT}"]`);
    await expect(cleanRow).toContainText("Clean OOS");
    await expect(overfitRow).toContainText("Overfit");
    await expect(overfitRow).toContainText("Unstable");
    const overfitPromote = overfitRow.getByRole("button", { name: /^Promote to library: Promotion blocked/u });
    await expect(overfitPromote).toBeDisabled();
    const cleanPromote = cleanRow.getByRole("button", { name: `Promote to library: ${R9B_CLEAN_FINGERPRINT}` });
    await expect(cleanPromote).toBeEnabled();
    await cleanPromote.click();

    // Promotion returns the provenance bundle, the generator dialog closes and
    // the strategy library gains the promoted artifact.
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    await expect(page.locator(".strategy-library")).toContainText(R9B_PROMOTED_NAME, { timeout: 20_000 });

    const promote = fixture.gaRequests.find((request) => request.method === "POST" && request.path === "/api/ga/promote");
    expect(promote).toMatchObject({ ownerHeader: R9B_OWNER_ID, csrfHeader: R9B_CSRF });
    expect(promote!.body).toEqual({ runId: R9B_RUN_ID, fingerprint: R9B_CLEAN_FINGERPRINT });

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
