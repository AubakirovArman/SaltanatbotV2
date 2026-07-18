import { expect, test, type Page } from "@playwright/test";
import {
  installR9GeneratorEvalFixture,
  R9_CSRF,
  R9_DATASET_FINGERPRINT,
  R9_ENGINE_VERSION,
  R9_OWNER_ID
} from "./support/r9GeneratorEvalFixture";

test.use({ colorScheme: "dark", locale: "en-US", timezoneId: "UTC" });

test.describe("R9.1 generator server evaluation", () => {
  test("evaluates a generated candidate on the server and ranks it with dataset provenance", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await installR9GeneratorEvalFixture(page);
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

    // A small deterministic run keeps the journey fast; seed stays at 42. The
    // limits group disambiguates from the server evolution section's controls.
    const limits = dialog.getByRole("group", { name: "Generation limits" });
    await limits.getByLabel("Population").fill("4");
    await limits.getByLabel("Generations").fill("0");
    await dialog.getByRole("button", { name: "Generate candidates", exact: true }).click();
    await expect(dialog.locator("tbody tr").first()).toBeVisible({ timeout: 30_000 });

    // Honest boundary before any server evaluation ran.
    const ranking = dialog.locator(".strategy-generator-ranking");
    await expect(ranking).toHaveAttribute("data-ranking-state", "unavailable");
    const evalSection = dialog.locator(".strategy-generator-server-eval");
    await expect(evalSection).toContainText("Server evaluation (multi-market)");
    await expect(evalSection.getByRole("checkbox", { name: "BTCUSDT" })).toBeChecked();
    await expect(evalSection.getByRole("checkbox", { name: "ETHUSDT" })).toBeChecked();
    await expect(evalSection.getByRole("checkbox", { name: "SOLUSDT" })).toBeChecked();

    await evalSection.getByRole("button", { name: "Evaluate selected candidate on server", exact: true }).click();
    await expect(evalSection.getByRole("list", { name: "Server evaluation jobs" })).toBeVisible({ timeout: 20_000 });

    // The fixture completes the job on the first poll; ranking flips to ranked
    // and displays the evaluation provenance line.
    await expect(ranking).toHaveAttribute("data-ranking-state", "ranked", { timeout: 30_000 });
    await expect(ranking).toContainText("#1");
    await expect(ranking).toContainText("Dataset fingerprint");
    await expect(ranking.locator(".strategy-generator-dataset-fingerprint").first()).toHaveText(R9_DATASET_FINGERPRINT);
    await expect(ranking).toContainText(R9_ENGINE_VERSION);
    expect(fixture.jobPolls()).toBeGreaterThanOrEqual(1);

    // Exact enqueue POST body: the spec payload and nothing else.
    const enqueue = fixture.evalRequests.find((request) => request.method === "POST" && request.path === "/api/jobs");
    expect(enqueue).toMatchObject({ ownerHeader: R9_OWNER_ID, csrfHeader: R9_CSRF });
    const body = enqueue!.body as {
      kind: string;
      ir: { name?: unknown; body?: unknown; inputs?: unknown };
      markets: unknown;
      lookbackBars: number;
      split: unknown;
      seed: number;
    };
    expect(Object.keys(body).sort()).toEqual(["ir", "kind", "lookbackBars", "markets", "seed", "split"]);
    expect(body.kind).toBe("multi-market-eval");
    expect(body.markets).toEqual([
      { symbol: "BTCUSDT", timeframe: "1h" },
      { symbol: "ETHUSDT", timeframe: "1h" },
      { symbol: "SOLUSDT", timeframe: "1h" }
    ]);
    expect(body.lookbackBars).toBe(3_000);
    expect(body.split).toEqual({ trainFraction: 0.7, embargoBars: 8 });
    expect(body.seed).toBe(42);
    // The selected candidate's IR travels to the server verbatim.
    expect(typeof body.ir.name).toBe("string");
    expect(Array.isArray(body.ir.inputs)).toBe(true);
    expect(Array.isArray(body.ir.body)).toBe(true);

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
