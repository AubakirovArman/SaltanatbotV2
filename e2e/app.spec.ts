import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("loads the terminal and exposes the chart semantically", async ({ page }) => {
  await expect(page.locator(".brand")).toContainText("SaltanatbotV2");
  await expect(page.getByRole("img", { name: /BTCUSDT candles chart on 1m/i })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("status")).toBeVisible();
  await expect(page.getByRole("button", { name: "Toggle markets panel" })).toHaveAttribute("aria-pressed", "true");
});

test("toggles the visible-range volume profile accessibly", async ({ page }) => {
  await expect(page.getByRole("img", { name: /BTCUSDT candles chart on 1m/i })).toBeVisible({ timeout: 20_000 });
  const toggle = page.getByRole("button", { name: "Toggle visible-range volume profile" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".volume-profile-badge")).toContainText("POC", { timeout: 20_000 });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".volume-profile-badge")).toBeHidden();
  await toggle.click();
  await expect(page.locator(".volume-profile-badge")).toBeVisible();
});

test("shows and toggles the semantic UTC session liquidity map", async ({ page }) => {
  await selectChartSymbol(page, "EURUSD");
  const toggle = page.getByRole("button", { name: "Toggle UTC map" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".session-liquidity-values")).toContainText("VWAP", { timeout: 20_000 });
  await expect(page.locator(".session-liquidity-badge")).toHaveAttribute("aria-label", /UTC session map: VWAP/);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".session-liquidity-values")).toBeHidden();
});

test("toggles DST-aware regional session boxes accessibly", async ({ page }) => {
  await selectChartSymbol(page, "EURUSD");
  await expect(page.locator(".chart-legend .vol")).toBeVisible({ timeout: 20_000 });
  const asia = page.getByRole("button", { name: "Asia session" });
  const london = page.getByRole("button", { name: "London session" });
  const newYork = page.getByRole("button", { name: "New York session" });
  await expect(asia).toHaveAttribute("aria-pressed", "true");
  await expect(london).toHaveAttribute("aria-pressed", "true");
  await expect(newYork).toHaveAttribute("aria-pressed", "true");
  await asia.click();
  await expect(asia).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".session-liquidity-badge .sr-only li").filter({ hasText: "Asia session" })).toHaveCount(0);
  await expectNoAxeViolations(page);
  await page.getByRole("button", { name: "4h", exact: true }).click();
  await expect(page.getByRole("button", { name: /Asia session.*Available on 1-minute through 1-hour charts/ })).toBeDisabled();
});

test("controls confirmed market structure independently on every timeframe", async ({ page }) => {
  await selectChartSymbol(page, "EURUSD");
  await expect(page.locator(".chart-legend .vol")).toBeVisible({ timeout: 20_000 });
  const structure = page.getByRole("button", { name: "Toggle confirmed swings and BOS / CHOCH" });
  const fvg = page.getByRole("button", { name: "Toggle closed-candle fair value gaps" });
  await expect(structure).toHaveAttribute("aria-pressed", "true");
  await expect(fvg).toHaveAttribute("aria-pressed", "false");
  await fvg.click();
  await expect(fvg).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Swing confirmation strength: 3" }).click();
  await expect(page.getByRole("button", { name: "Swing confirmation strength: 4" })).toBeVisible();
  await expect(page.locator(".session-liquidity-badge .sr-only")).toContainText(/Trend: .*confirmed swings.*structure breaks.*open fair value gaps/);
  await expectNoAxeViolations(page);

  await page.getByRole("button", { name: "1d", exact: true }).click();
  await expect(page.getByRole("button", { name: /Toggle UTC map.*available on 1-minute through 4-hour charts/i })).toBeDisabled();
  await expect(structure).toBeEnabled();
  await expect(fvg).toBeEnabled();
});

test("renders a localized non-repainting Three Line Break chart", async ({ page }) => {
  await selectChartSymbol(page, "EURUSD");
  await page.getByTitle("Chart type").click();
  const lineBreak = page.getByRole("menuitemradio", { name: "Three Line Break" });
  await expect(lineBreak).toBeVisible();
  await lineBreak.click();
  await expect(page.getByRole("img", { name: /EURUSD Three Line Break chart on 1m.*confirmed close-only lines with a three-line reversal/i })).toBeVisible({ timeout: 20_000 });
  await expectNoAxeViolations(page);

  await page.getByRole("button", { name: "Switch interface language to Russian" }).click();
  await page.getByTitle("Тип графика").click();
  await expect(page.getByRole("menuitemradio", { name: "Трёхлинейный прорыв" })).toHaveAttribute("aria-checked", "true");
});

test("creates, exposes and persists an anchored VWAP drawing", async ({ page }) => {
  await selectChartSymbol(page, "EURUSD");
  await expect(page.locator(".chart-legend .vol")).toBeVisible({ timeout: 20_000 });
  const tool = page.getByRole("button", { name: "Anchored VWAP", exact: true });
  await tool.click();
  await expect(tool).toHaveAttribute("aria-pressed", "true");
  await page.locator(".chart-canvas-interaction").click({ position: { x: 420, y: 260 } });
  const legend = page.getByRole("complementary", { name: "Anchored VWAP" });
  await expect(legend).toContainText(/AVWAP.*σ/);
  await page.getByRole("button", { name: "Drawing object tree" }).click();
  await expect(page.locator(".drawing-object-list")).toContainText("Anchored VWAP");
  await expectNoAxeViolations(page);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("mf:drawings:EURUSD") ?? "[]").some((drawing: { tool?: string }) => drawing.tool === "anchored-vwap"))).toBe(true);
  await page.reload();
  await selectChartSymbol(page, "EURUSD");
  await expect(page.getByRole("complementary", { name: "Anchored VWAP" })).toBeVisible({ timeout: 20_000 });
});

test("renders and pauses a mocked live order book heatmap", async ({ page }) => {
  await installOrderBookSocketMock(page);
  const toggle = page.getByRole("button", { name: "Toggle live order book heatmap" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".orderbook-heatmap-badge")).toContainText(/live.*4 levels/i);
  await toggle.click();
  await expect(page.locator(".orderbook-heatmap-badge")).toBeHidden();
});

test("renders a mocked live footprint and trade delta accessibly", async ({ page }) => {
  await installTradeFlowSocketMock(page);
  const toggle = page.getByRole("button", { name: "Toggle live trade footprint and delta" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const badge = page.locator(".trade-footprint-badge");
  await expect(badge).toContainText(/live.*Δ \+33\.3%/i);
  await expect(badge).toContainText("2 prints");
  await expect(badge).toContainText(/0 imbalances.*0 stacks.*0 ABS\?/i);
  await expect(badge).toHaveAttribute("role", "status");
  const alertCenter = page.getByRole("region", { name: "Microstructure alerts" });
  await expect(alertCenter).toContainText("FLOW ALERTS");
  await alertCenter.getByText("Alert settings", { exact: true }).click();
  await expect(alertCenter.getByLabel("Enable in-chart alerts")).toBeChecked();
  await alertCenter.getByLabel("Large-print threshold").fill("100");
  const dismissAlert = alertCenter.getByRole("button", { name: "Dismiss microstructure alert" }).first();
  await expect(dismissAlert).toBeVisible({ timeout: 5_000 });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("sbv2:microstructure-alerts:v1") ?? "null")?.largePrintNotional)).toBe(100);
  await dismissAlert.click();
  await expectNoAxeViolations(page);
  await toggle.click();
  await expect(badge).toBeHidden();
});

test("passes automated WCAG A/AA audits on chart, strategy and trading surfaces", async ({ page }) => {
  await expect(page.getByRole("img", { name: /BTCUSDT candles chart on 1m/i })).toBeVisible({ timeout: 20_000 });
  await expectNoAxeViolations(page);
  const modes = page.getByLabel("Workspace mode");
  await modes.getByRole("button", { name: "Strategy", exact: true }).click();
  await expect(page.locator(".strategy-lab")).toBeVisible({ timeout: 20_000 });
  await expectNoAxeViolations(page);
  await modes.getByRole("button", { name: "Trade", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Trading is locked" })).toBeVisible();
  await expectNoAxeViolations(page);
});

test("honours reduced motion and remains operable at 200 percent text size", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const transition = await page.getByRole("button", { name: "Toggle markets panel" }).evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(Number.parseFloat(transition)).toBeLessThanOrEqual(0.00001);
  await page.locator("html").evaluate((element) => { element.style.fontSize = "200%"; });
  await expect(page.getByLabel("Workspace mode")).toBeVisible();
  await page.getByRole("button", { name: "Chart data", exact: true }).click();
  await expect(page.getByRole("table", { name: "Latest candle" })).toBeVisible({ timeout: 20_000 });
});

test("offers a keyboard-operable tabular alternative to the canvas chart", async ({ page }) => {
  const toggle = page.getByRole("button", { name: "Chart data", exact: true });
  await expect(toggle).toBeVisible({ timeout: 20_000 });
  await toggle.focus();
  await page.keyboard.press("Enter");

  await expect(page.locator(".chart-data-toggle")).toHaveAttribute("aria-expanded", "true");
  const chartData = page.getByRole("complementary", { name: "Chart data" });
  await expect(chartData.getByRole("table", { name: "Latest candle" })).toBeVisible({ timeout: 20_000 });
  await expect(chartData.getByRole("columnheader", { name: "Open", exact: true }).first()).toBeVisible();
  await expect(chartData.getByRole("table", { name: /Strategy signals/ })).toBeVisible();
  await expect(chartData.getByRole("table", { name: /Executed trades/ })).toBeVisible();
});

test("command palette is keyboard-operable and switches symbols", async ({ page }) => {
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();

  const search = palette.getByPlaceholder("Search symbols, timeframes, chart types, actions...");
  await expect(search).toBeFocused();
  await search.fill("EURUSD");
  await expect(palette.getByRole("button").filter({ hasText: "EURUSD" }).first()).toBeVisible({ timeout: 20_000 });
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
  const stages = page.getByRole("navigation", { name: "Studio stages" });
  await expect(stages.getByRole("button", { name: "Build", exact: true })).toHaveAttribute("aria-pressed", "true");
  await stages.getByRole("button", { name: "Learn", exact: true }).click();
  await expect(page.getByText("Select a block in the workspace to inspect its contract, example and pitfalls.")).toBeVisible();
});

test("creates an ordinary editable strategy with the guided wizard", async ({ page }) => {
  const workspaceModes = page.getByLabel("Workspace mode");
  await workspaceModes.getByRole("button", { name: "Strategy", exact: true }).click();
  await expect(page.locator(".strategy-lab")).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Wizard", exact: true }).click();
  const wizard = page.getByRole("dialog", { name: "Guided strategy wizard" });
  await expect(wizard.getByLabel("Strategy name")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(wizard.getByRole("button", { name: "Close strategy wizard" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(wizard).toBeHidden();
  await expect(page.getByRole("button", { name: "Wizard", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Wizard", exact: true }).click();
  await wizard.getByLabel("Strategy name").fill("E2E guided breakout");
  await wizard.getByRole("button", { name: "Next", exact: true }).click();
  await wizard.getByLabel("Entry signal").selectOption("price-breakout");
  await wizard.getByLabel("Lookback").fill("12");
  await wizard.getByRole("button", { name: "Next", exact: true }).click();
  await wizard.getByRole("button", { name: "Create editable strategy", exact: true }).click();

  await expect(wizard).toBeHidden();
  await expect(page.locator(".strategy-library")).toContainText("E2E guided breakout");
  const stages = page.getByRole("navigation", { name: "Studio stages" });
  await stages.getByRole("button", { name: "Validate", exact: true }).click();
  await expect(page.getByText("Validation passed. No compile diagnostics.")).toBeVisible();
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
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page).toHaveTitle("График · SaltanatbotV2");
  const workspaceModes = page.locator(".mode-tabs");
  await expect(workspaceModes.getByRole("button", { name: "График", exact: true })).toBeVisible();
  await expect(workspaceModes.getByRole("button", { name: "Стратегия", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Переключить язык интерфейса на английский" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Данные графика", exact: true })).toBeVisible();
  await expect(page.getByText("Рынки", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Статистика свечи")).toBeVisible();
  await expect(page.getByRole("button", { name: "Линия тренда", exact: true })).toBeVisible();
  await expect(page.locator(".indicator-add")).toHaveText("Добавить");
  await expect(page.getByRole("button", { name: "Сохранённые рабочие пространства", exact: true })).toBeVisible();
  await expect(page.locator(".compare-add")).toContainText("Сравнить");
  await page.keyboard.press("Control+k");
  const localizedPalette = page.getByRole("dialog", { name: "Палитра команд" });
  await expect(localizedPalette.getByPlaceholder("Поиск символов, интервалов, типов графика и действий…")).toBeFocused();
  await page.keyboard.press("Escape");

  await workspaceModes.getByRole("button", { name: "Стратегия", exact: true }).click();
  await expect(page).toHaveTitle("Стратегия · SaltanatbotV2");
  await page.getByRole("navigation", { name: "Этапы Студии" }).getByRole("button", { name: "Бэктест", exact: true }).click();
  await expect(page.getByRole("button", { name: "Запустить бэктест", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Галерея", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pine", exact: true }).click();
  const pineDialog = page.getByRole("dialog", { name: "Импорт Pine Script" });
  await expect(pineDialog.getByRole("button", { name: "Преобразовать", exact: true })).toBeDisabled();
  await pineDialog.getByRole("button", { name: "Закрыть", exact: true }).click();

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  await expect(workspaceModes.getByRole("button", { name: "График", exact: true })).toBeVisible();
  await workspaceModes.getByRole("button", { name: "Торговля", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Торговля заблокирована" })).toBeVisible();
  await page.getByLabel("Токен доступа").fill("e2e-local-admin-token");
  await page.getByRole("button", { name: "Разблокировать" }).click();
  await page.getByRole("button", { name: "Настройки" }).click();
  await expect(page.getByText("Включён демонстрационный режим — доступна только paper-торговля.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Сохранить ключи binance" })).toBeVisible();
  await expect(page.getByLabel("Токен бота")).toBeVisible();
});

test("saves and restores a named chart workspace", async ({ page }) => {
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  const search = palette.getByPlaceholder("Search symbols, timeframes, chart types, actions...");
  await search.fill("EURUSD");
  await expect(palette.getByRole("button").filter({ hasText: "EURUSD" }).first()).toBeVisible({ timeout: 20_000 });
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
  await page.getByRole("navigation", { name: "Studio stages" }).getByRole("button", { name: "Backtest", exact: true }).click();
  await page.locator(".config-row label").filter({ hasText: /^Market/ }).locator("select").selectOption("EURUSD");
  await page.getByRole("button", { name: "Run backtest" }).click();

  const report = page.locator(".backtest-report");
  await expect(report).toBeVisible({ timeout: 30_000 });
  await expect(report).toContainText("Net profit");
  await expect(report).toContainText(/next-open fills/i);
  await expect(report).toContainText(/Data fallback/i);
  await expect(report.getByRole("alert")).toContainText(/Performance claims are not valid/i);
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

test("configures and persists a built-in indicator", async ({ page }) => {
  await page.getByRole("button", { name: "ADD", exact: true }).click();
  await page.getByRole("menuitem", { name: "EMA 50", exact: true }).click();

  const editor = page.getByRole("dialog", { name: "EMA settings" });
  await expect(editor).toBeVisible();
  await editor.getByLabel("Period").fill("34");
  await editor.getByRole("button", { name: "Close indicator editor" }).click();

  await expect(page.locator(".indicator-chip").filter({ hasText: "EMA" })).toContainText("34");
  await page.reload();
  await expect(page.locator(".indicator-chip").filter({ hasText: "EMA" })).toContainText("34");
});

test("adds an imported custom indicator to the chart", async ({ page }) => {
  const workspaceModes = page.getByLabel("Workspace mode");
  await workspaceModes.getByRole("button", { name: "Strategy", exact: true }).click();
  await expect(page.locator(".strategy-lab")).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Pine", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import Pine Script" });
  await dialog.locator("textarea").fill([
    "//@version=6",
    'indicator("Chart E2E SMA", overlay=true)',
    'plot(ta.sma(close, 3), "SMA")'
  ].join("\n"));
  await dialog.getByRole("button", { name: "Convert", exact: true }).click();
  await dialog.getByRole("button", { name: "Add 1 artifact", exact: true }).click();

  await workspaceModes.getByRole("button", { name: "Chart", exact: true }).click();
  await page.getByRole("button", { name: "ADD", exact: true }).click();
  await page.getByRole("menuitem").filter({ hasText: "Chart E2E SMA" }).click();

  await expect(page.locator(".strategy-chip")).toContainText("Chart E2E SMA", { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Remove artifact from chart" })).toBeVisible();
});

test("creates, starts, journals and stops a paper bot", async ({ page }) => {
  const workspaceModes = page.getByLabel("Workspace mode");
  await workspaceModes.getByRole("button", { name: "Trade", exact: true }).click();
  await page.getByLabel("Access token").fill("e2e-local-admin-token");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Live & paper trading", { exact: true })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: /Create paper bot|New bot/ }).first().click();
  const botName = `Paper E2E ${Date.now()}`;
  await page.getByLabel("Bot name").fill(botName);
  // Keep lifecycle E2E deterministic: EURUSD is backed by the local synthetic
  // provider, while BTCUSDT startup depends on public exchange latency.
  await page.locator('.trade-form select[name="symbol"]').selectOption("EURUSD");
  await page.getByLabel("Exchange").selectOption("paper");
  await page.getByRole("button", { name: "Create bot", exact: true }).click();

  const detail = page.locator(".trade-detail");
  await expect(detail.locator(".trade-detail-head strong")).toHaveText(botName, { timeout: 15_000 });
  await detail.getByRole("button", { name: "Start", exact: true }).click();
  await expect(detail.getByRole("button", { name: "Stop", exact: true })).toBeVisible({ timeout: 15_000 });

  const command = detail.getByPlaceholder("action=openposition;side=buy;openpro=25;lev=5");
  await command.fill("action=openposition;symbol=EURUSD;side=buy;qty=0.001;lev=1");
  await command.press("Enter");
  await expect(detail.locator("#order-journal-title")).toBeVisible({ timeout: 15_000 });
  const orderTable = detail.locator(".trade-order-journal table");
  await orderTable.scrollIntoViewIfNeeded();
  await expect(orderTable).toBeVisible();
  await expect(orderTable.getByRole("columnheader", { name: "Reason" })).toBeVisible();
  await expect(orderTable.getByRole("row").filter({ hasText: /open|filled/i }).first()).toBeVisible();

  await detail.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(detail.getByRole("button", { name: "Start", exact: true })).toBeVisible({ timeout: 15_000 });
  await detail.getByRole("button", { name: "Delete bot" }).click();
});

test("exposes safe demo trading settings and labeled secret forms", async ({ page }) => {
  const workspaceModes = page.getByLabel("Workspace mode");
  await workspaceModes.getByRole("button", { name: "Trade", exact: true }).click();
  await page.getByLabel("Access token").fill("e2e-local-admin-token");
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.getByRole("button", { name: "Settings" }).click();

  await expect(page.getByText("Running in demo mode — only paper trading is available.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save binance keys" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save bybit keys" })).toBeVisible();
  await expect(page.getByLabel("Bot token")).toHaveAttribute("autocomplete", "new-password");
  await expect(page.getByLabel("Chat ID")).toHaveAttribute("inputmode", "numeric");
});

test("traps command-palette focus and restores it on Escape", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "Open command palette" });
  await trigger.click();

  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toHaveAttribute("aria-modal", "true");
  const search = palette.getByPlaceholder("Search symbols, timeframes, chart types, actions...");
  await expect(search).toBeFocused();

  await search.press("Shift+Tab");
  await expect(palette.getByRole("button").last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("keeps the chart usable at a narrow mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("img", { name: /BTCUSDT candles chart on 1m/i })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Toggle markets panel" })).toBeVisible();
  await expect(page.locator(".stats-panel")).toBeHidden();

  await page.getByRole("button", { name: "Toggle markets panel" }).click();
  await expect(page.locator(".watchlist")).toBeHidden();
  await expect(page.getByRole("img", { name: /BTCUSDT candles chart on 1m/i })).toBeVisible();
});

test("reconnects the market stream without duplicating candles", async ({ page }) => {
  const candles = mockCandles();
  await mockCandleHistory(page, candles);
  await installMarketSocketMock(page, "reconnect", candles);
  await page.reload();

  await expect(page.getByRole("status")).toHaveAttribute("title", "Feed: connected", { timeout: 20_000 });
  await expect(page.locator(".feed-row").filter({ hasText: "Candles" }).locator("strong")).toHaveText("2");
  await expect(page.locator(".feed-row").filter({ hasText: "Provider" }).locator("strong")).toHaveText("mock");
  await expect.poll(() => page.evaluate(() => (window as Window & { __marketSocketAttempts?: number }).__marketSocketAttempts)).toBe(2);
});

test("shows an explicit market-data unavailable state", async ({ page }) => {
  await page.route("**/api/candles?**", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "Market data unavailable for BTCUSDT", unavailable: true })
  }));
  await installMarketSocketMock(page, "unavailable", []);
  await page.reload();

  await expect(page.getByRole("status")).toHaveAttribute("title", "Feed: error", { timeout: 20_000 });
  await expect(page.locator(".feed-row").filter({ hasText: "Status" })).toContainText("Market data unavailable for BTCUSDT");
  await expect(page.locator(".feed-row").filter({ hasText: "Candles" }).locator("strong")).toHaveText("0");
});

function mockCandles() {
  return [
    { time: 1_710_000_000_000, open: 100, high: 102, low: 99, close: 101, volume: 10, source: "mock" },
    { time: 1_710_000_060_000, open: 101, high: 103, low: 100, close: 101.5, volume: 12, source: "mock" }
  ];
}

async function mockCandleHistory(page: Page, candles: ReturnType<typeof mockCandles>) {
  await page.route("**/api/candles?**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ candles, provider: "mock", hasMore: false })
  }));
}

async function installMarketSocketMock(
  page: Page,
  mode: "reconnect" | "unavailable",
  candles: ReturnType<typeof mockCandles>
) {
  await page.addInitScript(({ socketMode, rows }) => {
    const target = window as Window & { __marketSocketAttempts?: number };
    target.__marketSocketAttempts = 0;

    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(url: string | URL) {
        this.url = String(url);
        if (this.url.includes("/quotes?")) {
          window.setTimeout(() => {
            this.readyState = MockWebSocket.OPEN;
            this.onopen?.(new Event("open"));
            this.emit({
              type: "quotes_snapshot",
              timeframe: "1m",
              provider: "mock",
              series: { BTCUSDT: { last: 101, changePct: 1, points: [100, 101] } },
              ts: Date.now()
            });
          }, 0);
          return;
        }
        const attempt = (target.__marketSocketAttempts ?? 0) + 1;
        target.__marketSocketAttempts = attempt;
        window.setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event("open"));
          if (socketMode === "unavailable") {
            this.emit({ type: "error", message: "Market data unavailable for BTCUSDT", ts: Date.now() });
            return;
          }
          this.emit({ type: "snapshot", symbol: "BTCUSDT", timeframe: "1m", candles: rows, provider: "mock", ts: Date.now() });
          if (attempt === 1) {
            window.setTimeout(() => {
              this.readyState = MockWebSocket.CLOSED;
              this.onclose?.(new CloseEvent("close"));
            }, 50);
          } else {
            window.setTimeout(() => this.emit({
              type: "candle",
              symbol: "BTCUSDT",
              timeframe: "1m",
              candle: { ...rows.at(-1), close: 102 },
              provider: "mock",
              ts: Date.now()
            }), 50);
          }
        }, 0);
      }

      close() {
        this.readyState = MockWebSocket.CLOSED;
      }

      send() {}

      private emit(message: unknown) {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
      }
    }

    window.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  }, { socketMode: mode, rows: candles });
}

async function installOrderBookSocketMock(page: Page) {
  await page.evaluate(() => {
    const NativeWebSocket = window.WebSocket;
    class MockOrderBookSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = MockOrderBookSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(url: string) {
        this.url = url;
        window.setTimeout(() => {
          this.readyState = MockOrderBookSocket.OPEN;
          this.onopen?.(new Event("open"));
          this.emit({ type: "orderbook_status", symbol: "BTCUSDT", exchange: "binance", status: "connected", message: "mock depth connected", ts: Date.now() });
          this.emit({
            type: "orderbook", symbol: "BTCUSDT", exchange: "binance",
            bids: [[100, 2], [99.9, 4]], asks: [[100.1, 3], [100.2, 5]],
            sequence: 1, exchangeTs: Date.now(), ts: Date.now()
          });
        }, 0);
      }

      close() { this.readyState = MockOrderBookSocket.CLOSED; }
      send() {}
      private emit(message: unknown) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) })); }
    }
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(Target, args) {
        const url = String(args[0]);
        return url.includes("/orderbook?") ? new MockOrderBookSocket(url) : Reflect.construct(Target, args);
      }
    });
  });
}

async function installTradeFlowSocketMock(page: Page) {
  await page.evaluate(() => {
    const NativeWebSocket = window.WebSocket;
    class MockTradeFlowSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = MockTradeFlowSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(url: string) {
        this.url = url;
        window.setTimeout(() => {
          this.readyState = MockTradeFlowSocket.OPEN;
          this.onopen?.(new Event("open"));
          this.emit({ type: "trade_flow_status", symbol: "BTCUSDT", exchange: "binance", status: "connected", message: "mock trades connected", ts: Date.now() });
          this.emit({
            type: "trade_flow", symbol: "BTCUSDT", exchange: "binance", ts: Date.now(),
            trades: [
              { id: "buy-1", price: 100, size: 2, side: "buy", exchangeTs: Date.now() },
              { id: "sell-1", price: 100, size: 1, side: "sell", exchangeTs: Date.now() }
            ]
          });
        }, 0);
      }

      close() { this.readyState = MockTradeFlowSocket.CLOSED; }
      send() {}
      private emit(message: unknown) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) })); }
    }
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(Target, args) {
        const url = String(args[0]);
        return url.includes("/trade-flow?") ? new MockTradeFlowSocket(url) : Reflect.construct(Target, args);
      }
    });
  });
}

async function expectNoAxeViolations(page: Page) {
  const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(audit.violations, audit.violations.map((item) => `${item.id}: ${item.help} (${item.nodes.length})`).join("\n")).toEqual([]);
}

async function selectChartSymbol(page: Page, symbol: string) {
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  const search = palette.getByPlaceholder("Search symbols, timeframes, chart types, actions...");
  await search.fill(symbol);
  await expect(palette.getByRole("button").filter({ hasText: symbol }).first()).toBeVisible({ timeout: 20_000 });
  await search.press("Enter");
  await expect(page.getByRole("button", { name: new RegExp(`Current instrument ${symbol}`, "i") })).toBeVisible();
}
