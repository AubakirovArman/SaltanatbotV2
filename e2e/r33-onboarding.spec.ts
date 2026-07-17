import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { mockCandleHistory, mockChartCandles } from "./support/marketMocks";
import {
  installR33RouteFixture,
  installR33SocketFixture,
  R33_OWNER_ID,
  type R33Goal,
  type R33Milestone,
  type R33RouteFixture
} from "./support/r33OnboardingFixture";

const goalLabels: Record<R33Goal, RegExp> = {
  monitoring: /Open a chart/u,
  "price-alert": /Create a price alert/u,
  backtest: /Run a backtest/u,
  "paper-robot": /Create a paper robot/u
};

test("fresh user completes monitoring onboarding on a contained 390px mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await openFreshUser(page);
  const dialog = page.getByRole("dialog", { name: "Start with one useful result" });
  await expect(dialog).toBeVisible();
  await assertMobileDialogContained(page, dialog);

  await chooseGoal(page, "monitoring");
  await expect(page.getByRole("navigation", { name: "Primary workspaces" }).getByRole("button", { name: "Monitoring", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("img", { name: /BTCUSDT candles chart on 1m/i })).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => fixture.state().status).toBe("completed");
  expectCompleted(fixture, "monitoring", "chart-ready", "chartReadyAt");
  await expectWorkspace(page, "Monitoring");
  expectOwnerFence(fixture);
});

test("price-alert onboarding survives reload and resumes before the real alert action", async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await openFreshUser(page);
  await chooseGoal(page, "price-alert");
  await expect.poll(() => fixture.state().status).toBe("in_progress");
  expect(fixture.state()).toMatchObject({ goal: "price-alert", revision: 1 });
  await expectWorkspace(page, "Monitoring");

  await openStrategyWorkspace(page);
  await expect(page).toHaveURL(/\?view=strategy(?:&|$)/u);
  const getCountBeforeReload = fixture.onboardingRequests.filter((request) => request.method === "GET").length;
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("navigation", { name: "Primary workspaces" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("dialog", { name: "Start with one useful result" })).toHaveCount(0);
  await expect.poll(() => fixture.onboardingRequests.filter((request) => request.method === "GET").length).toBeGreaterThan(getCountBeforeReload);
  expect(fixture.state()).toMatchObject({ status: "in_progress", goal: "price-alert", revision: 1 });

  await page.getByRole("button", { name: "Getting started" }).click();
  await expect(page.getByRole("navigation", { name: "Primary workspaces" }).getByRole("button", { name: "Monitoring", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page).not.toHaveURL(/[?&]view=/u);
  const alerts = page.getByRole("region", { name: "Price alerts" });
  await expect(alerts).toBeVisible({ timeout: 20_000 });
  const alertPrice = alerts.getByLabel("Alert price for BTCUSDT");
  await expect(alertPrice).toHaveAttribute("type", "number");
  await alertPrice.fill("120");
  await alerts.getByRole("button", { name: "Add", exact: true }).click();
  await expect(alerts.locator(".alert-item")).toHaveCount(1);

  await expect.poll(() => fixture.state().status).toBe("completed");
  expectCompleted(fixture, "price-alert", "price-alert-created", "priceAlertCreatedAt");
  expectOwnerFence(fixture);
});

test("backtest onboarding opens the Backtest workspace and completes only after a report exists", async ({ page }) => {
  const fixture = await openFreshUser(page);
  await chooseGoal(page, "backtest");
  await expect(page).toHaveURL(/\?view=strategy(?:&|$)/u);
  await expect(page.getByRole("navigation", { name: "Primary workspaces" }).getByRole("button", { name: "Strategies", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".strategy-lab")).toBeVisible({ timeout: 20_000 });
  await expectWorkspace(page, "Backtest");
  expect(fixture.state()).toMatchObject({ status: "in_progress", goal: "backtest", revision: 1 });

  await page.getByRole("navigation", { name: "Studio stages" }).getByRole("button", { name: "Backtest", exact: true }).click();
  await page.getByRole("button", { name: "Run backtest", exact: true }).click();
  const report = page.locator(".backtest-report");
  await expect(report).toBeVisible({ timeout: 30_000 });
  await expect(report).toContainText("Net profit");

  await expect.poll(() => fixture.state().status).toBe("completed");
  expectCompleted(fixture, "backtest", "backtest-completed", "backtestCompletedAt");
  expectOwnerFence(fixture);
});

test("paper-robot onboarding opens the paper workspace and completes after creating a paper bot", async ({ page }) => {
  const fixture = await openFreshUser(page);
  await chooseGoal(page, "paper-robot");
  await expect(page).toHaveURL(/\?view=trade(?:&|$)/u);
  await expect(page.getByRole("navigation", { name: "Primary workspaces" }).getByRole("button", { name: "Robots", exact: true })).toHaveAttribute("aria-pressed", "true");
  const form = page.locator("form.trade-form");
  await expect(form).toBeVisible({ timeout: 20_000 });
  await expectWorkspace(page, "Paper robot");
  expect(fixture.state()).toMatchObject({ status: "in_progress", goal: "paper-robot", revision: 1 });

  await form.getByRole("textbox", { name: "Bot name" }).fill("R3.3 first paper robot");
  await expect(form.locator('select[name="exchange"]')).toHaveValue("paper");
  await form.getByRole("button", { name: "Create bot", exact: true }).click();
  await expect.poll(() => fixture.bots.length).toBe(1);
  expect(fixture.bots[0]).toMatchObject({
    name: "R3.3 first paper robot",
    exchange: "paper",
    status: "stopped"
  });
  await expect(page.locator(".trade-detail-head strong")).toHaveText("R3.3 first paper robot", { timeout: 20_000 });

  await expect.poll(() => fixture.state().status).toBe("completed");
  expectCompleted(fixture, "paper-robot", "paper-bot-created", "paperBotCreatedAt");
  expectOwnerFence(fixture);
});

test("actual non-localhost insecure origin never registers PWA shell and keeps verified workspace export", async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    const target = window as Window & { __r33ServiceWorkerRegisterCalls?: number };
    target.__r33ServiceWorkerRegisterCalls = 0;
    const serviceWorker = {
      controller: undefined,
      register: async () => {
        target.__r33ServiceWorkerRegisterCalls = (target.__r33ServiceWorkerRegisterCalls ?? 0) + 1;
        return {
          waiting: undefined,
          installing: null,
          addEventListener() {},
          update: async () => undefined
        };
      },
      ready: new Promise(() => undefined)
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: serviceWorker
    });
  });
  const fixture = await installR33RouteFixture(page);
  const candles = mockChartCandles();
  await page.addInitScript(() => localStorage.setItem("sbv2:locale", "en"));
  await mockCandleHistory(page, candles);
  await installR33SocketFixture(page, candles);

  await page.goto("http://saltanat-r33.test:4193/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("navigation", { name: "Primary workspaces" })).toBeVisible({ timeout: 20_000 });
  expect(
    await page.evaluate(() => ({
      secure: globalThis.isSecureContext,
      hostname: location.hostname
    }))
  ).toEqual({ secure: false, hostname: "saltanat-r33.test" });
  await expect(page.getByRole("button", { name: "Offline research" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Install application" })).toHaveCount(0);

  await chooseGoal(page, "monitoring");
  await expect.poll(() => fixture.state().status).toBe("completed");
  const menu = await openWorkspaceMenu(page);
  const exportDownload = page.waitForEvent("download");
  await menu.getByRole("button", { name: "Export verified workspace Monitoring" }).click();
  const download = await exportDownload;
  expect(download.suggestedFilename()).toMatch(/monitoring.*\.saltanat-workspace\.json$/iu);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const exported = JSON.parse(await readFile(downloadPath!, "utf8")) as Record<string, unknown>;
  expect(exported).toMatchObject({
    format: "saltanatbotv2.workspace",
    algorithm: "SHA-256",
    workspace: { name: "Monitoring" }
  });

  await page.waitForTimeout(5_500);
  expect(await page.evaluate(() => (window as Window & { __r33ServiceWorkerRegisterCalls?: number }).__r33ServiceWorkerRegisterCalls ?? -1)).toBe(0);
  expectOwnerFence(fixture);
});

async function openFreshUser(page: Page): Promise<R33RouteFixture> {
  const fixture = await installR33RouteFixture(page);
  const candles = mockChartCandles();
  await page.addInitScript(() => localStorage.setItem("sbv2:locale", "en"));
  await mockCandleHistory(page, candles);
  await installR33SocketFixture(page, candles);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("navigation", { name: "Primary workspaces" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("dialog", { name: "Start with one useful result" })).toBeVisible({ timeout: 20_000 });
  return fixture;
}

async function chooseGoal(page: Page, goal: R33Goal): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Start with one useful result" });
  const choice = dialog.getByRole("button", { name: goalLabels[goal] });
  await choice.scrollIntoViewIfNeeded();
  await choice.click();
  await expect(dialog).toBeHidden();
}

async function openStrategyWorkspace(page: Page): Promise<void> {
  const navigation = page.getByRole("navigation", { name: "Primary workspaces" });
  const strategies = navigation.getByRole("button", { name: "Strategies", exact: true });
  if (await strategies.isVisible()) {
    await strategies.click();
    return;
  }
  await navigation.getByRole("button", { name: "Automation", exact: true }).click();
  await expect(strategies).toBeVisible();
  await strategies.click();
}

async function expectWorkspace(page: Page, name: string): Promise<void> {
  const menu = await openWorkspaceMenu(page);
  await expect(menu.locator(".workspace-apply").filter({ hasText: name })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
}

async function openWorkspaceMenu(page: Page): Promise<Locator> {
  const moreTools = page.getByRole("button", { name: "More tools" });
  if (await moreTools.isVisible()) {
    if ((await moreTools.getAttribute("aria-expanded")) !== "true") await moreTools.click();
    await expect(moreTools).toHaveAttribute("aria-expanded", "true");
  }
  const trigger = page.getByRole("button", { name: /^Saved workspaces:/u });
  await expect(trigger).toBeVisible();
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  const menu = page.getByRole("region", { name: "Saved workspaces" });
  await expect(menu).toBeVisible();
  return menu;
}

async function assertMobileDialogContained(page: Page, dialog: Locator): Promise<void> {
  const geometry = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const choices = [...element.querySelectorAll<HTMLElement>(".onboarding-goal")].map((choice) => {
      const box = choice.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width, height: box.height };
    });
    return {
      dialog: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      choices
    };
  });
  expect(geometry.dialog.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.dialog.top).toBeGreaterThanOrEqual(-1);
  expect(geometry.dialog.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.dialog.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.choices).toHaveLength(4);
  for (const choice of geometry.choices) {
    expect(choice.left).toBeGreaterThanOrEqual(-1);
    expect(choice.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(choice.width).toBeGreaterThanOrEqual(320);
    expect(choice.height).toBeGreaterThanOrEqual(44);
  }
  const later = dialog.getByRole("button", { name: "Do this later" }).last();
  await later.scrollIntoViewIfNeeded();
  await expect(later).toBeVisible();
  const laterBox = await later.boundingBox();
  expect(laterBox).not.toBeNull();
  expect(laterBox!.x).toBeGreaterThanOrEqual(-1);
  expect(laterBox!.x + laterBox!.width).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(laterBox!.height).toBeGreaterThanOrEqual(44);
}

function expectCompleted(
  fixture: R33RouteFixture,
  goal: R33Goal,
  milestone: R33Milestone,
  field: "chartReadyAt" | "priceAlertCreatedAt" | "backtestCompletedAt" | "paperBotCreatedAt"
): void {
  const state = fixture.state();
  expect(state).toMatchObject({
    revision: 2,
    status: "completed",
    goal
  });
  expect(state.goalSelectedAt).not.toBeNull();
  expect(state.milestones[field]).not.toBeNull();
  expect(state.completedAt).not.toBeNull();
  const mutations = fixture.onboardingRequests.filter((request) => request.method !== "GET");
  expect(mutations).toHaveLength(2);
  expect(mutations[0]).toMatchObject({
    method: "PUT",
    path: "/api/onboarding/goal",
    ownerHeader: R33_OWNER_ID,
    csrfHeader: "csrf-r33",
    body: { revision: 0, goal }
  });
  expect(mutations[1]).toMatchObject({
    method: "POST",
    path: "/api/onboarding/milestones",
    ownerHeader: R33_OWNER_ID,
    csrfHeader: "csrf-r33",
    body: { revision: 1, milestone }
  });
}

function expectOwnerFence(fixture: R33RouteFixture): void {
  expect(fixture.ownerViolations).toEqual([]);
  expect(fixture.onboardingRequests.length).toBeGreaterThanOrEqual(3);
  expect(new Set(fixture.onboardingRequests.map((request) => request.ownerHeader))).toEqual(new Set([R33_OWNER_ID]));
}
