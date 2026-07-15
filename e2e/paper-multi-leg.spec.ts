import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mockCandleHistory, mockChartCandles } from "./support/marketMocks";

test("journals and recovers a deterministic multi-leg paper run", { tag: "@smoke" }, async ({ page }) => {
  await mockCandleHistory(page, mockChartCandles());
  await page.goto("/");
  await openRobotsWorkspace(page);
  await page.getByLabel("Access token").fill("e2e-local-admin-token");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();

  const navigation = page.getByRole("button", { name: /Multi-leg paper journal/ });
  await expect(navigation).toBeVisible({ timeout: 15_000 });
  await navigation.click();
  await expect(page.getByRole("heading", { name: "Multi-leg paper journal", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("Restart recovery")).toContainText("Ready");
  await expect(page.locator(".paper-multi-leg-safety")).toContainText("Paper only · no live orders");

  const runId = `paper-e2e-${Date.now()}`;
  const plan = paperPlan(runId);
  await page.getByLabel("Validated paper plan JSON").fill(JSON.stringify(plan, null, 2));
  await page.getByLabel("Idempotency key").fill(`idem-${runId}`);
  await page.getByRole("button", { name: "Run paper scenario", exact: true }).click();

  await expect(page.locator(".paper-multi-leg > .sr-only[role='status']")).toContainText("Paper run created and journaled", { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: new RegExp(`Event journal · ${runId}`) })).toBeVisible();
  const journal = page.getByRole("table", { name: "Append-only events for the selected paper run" });
  await expect(journal).toContainText("Compensation decision");
  await expect(journal).toContainText("Compensation fill");
  await expect(journal).toContainText("Compensated");
  await expect(page.getByRole("table", { name: "Recent deterministic multi-leg paper runs" })).toContainText(runId);

  const accessibility = await new AxeBuilder({ page }).include(".paper-multi-leg").analyze();
  expect(accessibility.violations).toEqual([]);

  await page.reload();
  await openRobotsWorkspace(page);
  await page.getByRole("button", { name: /Multi-leg paper journal/ }).click();
  const history = page.getByRole("table", { name: "Recent deterministic multi-leg paper runs" });
  await expect(history).toContainText(runId, { timeout: 15_000 });
  await history.getByRole("button", { name: `View journal: ${runId}` }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`Event journal · ${runId}`) })).toBeVisible();

  await page.getByRole("button", { name: "Switch interface language to Russian" }).click();
  await expect(page.getByRole("heading", { name: "Журнал multi-leg paper", exact: true })).toBeVisible();
  await expect(page.getByLabel("Восстановление после перезапуска")).toContainText("Готово");
  await page.getByRole("button", { name: "Переключить язык интерфейса на казахский" }).click();
  await expect(page.getByRole("heading", { name: "Multi-leg paper журналы", exact: true })).toBeVisible();
  await expect(page.getByLabel("Қайта іске қосқаннан кейін қалпына келтіру")).toContainText("Дайын");
});

async function openRobotsWorkspace(page: Page) {
  const navigation = page.getByRole("navigation", { name: "Primary workspaces" });
  const robots = navigation.getByRole("button", { name: "Robots", exact: true });
  await expect(navigation).toBeVisible({ timeout: 20_000 });
  if (!(await robots.isVisible())) {
    await navigation.getByRole("button", { name: "Automation", exact: true }).click();
    await expect(robots).toBeVisible({ timeout: 20_000 });
  }
  await robots.click();
}

function paperPlan(runId: string) {
  const now = Date.now();
  return {
    schemaVersion: "paper-multi-leg-plan-v1",
    runId,
    source: { kind: "n-leg", engine: "n-leg-v1", opportunityId: `opportunity:${runId}`, evaluatedAt: now - 10, provenanceHash: "a".repeat(64) },
    createdAt: now,
    expiresAt: now + 60_000,
    executionMode: "paper-sequential-legs",
    simulationPolicy: "explicit-deterministic-fill-ratios-v1",
    legs: [10_000, 4_000, 10_000, 10_000].map((paperFillRatioBps, index) => ({
      legId: `leg-${index}`,
      venue: "e2e",
      instrumentId: `e2e:spot:ASSET${index}`,
      side: index % 2 === 0 ? "buy" : "sell",
      quantityUnit: "base",
      plannedQuantity: index + 1,
      referencePrice: 100 + index,
      feeBps: 2,
      paperFillRatioBps,
      paperCompensationFillRatioBps: 10_000,
      paperCompensationPrice: 100.5 + index,
      paperCompensationFeeBps: 3,
      evidenceId: `e2e:book:${index}`
    }))
  };
}
