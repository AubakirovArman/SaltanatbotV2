import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("loads the terminal and exposes the chart semantically", async ({ page }) => {
  await expect(page.locator(".brand")).toContainText("SaltanatbotV2");
  await expect(page.getByRole("img", { name: /BTCUSDT candles chart on 1m/i })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("status")).toBeVisible();
  await expect(page.getByRole("button", { name: "Toggle markets panel" })).toHaveAttribute("aria-pressed", "true");
});

test("command palette is keyboard-operable and switches symbols", async ({ page }) => {
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();

  const search = palette.getByPlaceholder("Search symbols, timeframes, chart types, actions...");
  await expect(search).toBeFocused();
  await search.fill("EURUSD");
  await search.press("Enter");

  await expect(page.getByRole("button", { name: /Current instrument EURUSD/i })).toBeVisible();
  await expect(page.getByRole("img", { name: /EURUSD candles chart on 1m/i })).toBeVisible();
});

test("opens the lazy Strategy workspace without losing the shell", async ({ page }) => {
  const workspaceModes = page.getByLabel("Workspace mode");
  await workspaceModes.getByRole("button", { name: "Strategy", exact: true }).click();

  await expect(page.locator(".strategy-lab")).toBeVisible({ timeout: 20_000 });
  await expect(workspaceModes.getByRole("button", { name: "Chart", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(workspaceModes.getByRole("button", { name: "Strategy", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("persists the selected theme across reload", async ({ page }) => {
  const root = page.locator("html");
  const before = await root.getAttribute("data-theme");
  await page.getByRole("button", { name: "Toggle light or dark theme" }).click();
  const after = before === "light" ? "dark" : "light";
  await expect(root).toHaveAttribute("data-theme", after);

  await page.reload();
  await expect(root).toHaveAttribute("data-theme", after);
});

test("imports a Pine indicator as an editable artifact", async ({ page }) => {
  const workspaceModes = page.getByLabel("Workspace mode");
  await workspaceModes.getByRole("button", { name: "Strategy", exact: true }).click();
  await expect(page.locator(".strategy-lab")).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Pine", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import Pine Script" });
  await expect(dialog).toBeVisible();
  await dialog.locator("textarea").fill([
    "//@version=6",
    'indicator("E2E SMA", overlay=true)',
    'plot(ta.sma(close, 3), "SMA")'
  ].join("\n"));
  await dialog.getByRole("button", { name: "Convert", exact: true }).click();

  await expect(dialog.getByText(/indicator · “E2E SMA”/i)).toBeVisible();
  await dialog.getByRole("button", { name: "Add 1 artifact", exact: true }).click();

  await expect(dialog).toBeHidden();
  await expect(page.locator(".strategy-library")).toContainText("E2E SMA");
});

test("switches and persists the interface locale", async ({ page }) => {
  await page.getByRole("button", { name: "Switch interface language to Russian" }).click();

  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  const workspaceModes = page.getByLabel("Workspace mode");
  await expect(workspaceModes.getByRole("button", { name: "График", exact: true })).toBeVisible();
  await expect(workspaceModes.getByRole("button", { name: "Стратегия", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Переключить язык интерфейса на английский" })).toBeVisible();

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  await expect(workspaceModes.getByRole("button", { name: "График", exact: true })).toBeVisible();
});

test("saves and restores a named chart workspace", async ({ page }) => {
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  const search = palette.getByPlaceholder("Search symbols, timeframes, chart types, actions...");
  await search.fill("EURUSD");
  await search.press("Enter");
  await expect(page.getByRole("button", { name: /Current instrument EURUSD/i })).toBeVisible();

  page.once("dialog", async (dialog) => dialog.accept("EUR research"));
  await page.getByRole("button", { name: "Saved workspaces" }).click();
  await page.getByRole("button", { name: "Save current as…" }).click();

  await page.reload();
  await page.getByRole("button", { name: "Saved workspaces" }).click();
  await expect(page.locator(".workspace-apply").filter({ hasText: "EUR research" })).toContainText("EURUSD");
});

test("runs a backtest and exposes assumptions and metrics", async ({ page }) => {
  const workspaceModes = page.getByLabel("Workspace mode");
  await workspaceModes.getByRole("button", { name: "Strategy", exact: true }).click();
  await expect(page.locator(".strategy-lab")).toBeVisible({ timeout: 20_000 });
  await page.locator(".config-row label").filter({ hasText: /^Market/ }).locator("select").selectOption("EURUSD");
  await page.getByRole("button", { name: "Run backtest" }).click();

  const report = page.locator(".backtest-report");
  await expect(report).toBeVisible({ timeout: 30_000 });
  await expect(report).toContainText("Net profit");
  await expect(report).toContainText(/next-open fills/i);
  await expect(report).toContainText("Trades");
});

test("keeps trading locked for a bad token and opens an authenticated session", async ({ page }) => {
  const workspaceModes = page.getByLabel("Workspace mode");
  await workspaceModes.getByRole("button", { name: "Trade", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Trading is locked" })).toBeVisible();

  const token = page.getByLabel("Access token");
  await token.fill("invalid-token");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("alert")).toContainText("Invalid access token");

  await token.fill("e2e-local-admin-token");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Live & paper trading", { exact: true })).toBeVisible({ timeout: 15_000 });
});
