import { expect, test, type Page } from "@playwright/test";

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
  await page.getByLabel("Exchange").selectOption("paper");
  await page.getByRole("button", { name: "Create bot", exact: true }).click();

  const detail = page.locator(".trade-detail");
  await expect(detail.locator(".trade-detail-head strong")).toHaveText(botName, { timeout: 15_000 });
  await detail.getByRole("button", { name: "Start", exact: true }).click();
  await expect(detail.getByRole("button", { name: "Stop", exact: true })).toBeVisible({ timeout: 15_000 });

  const command = detail.getByPlaceholder("action=openposition;side=buy;openpro=25;lev=5");
  await command.fill("action=openposition;symbol=BTCUSDT;side=buy;qty=0.001;lev=1");
  await command.press("Enter");
  await expect(detail.getByText("Order journal", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(detail.locator(".trade-journal-row").filter({ hasText: /open|accepted/i }).first()).toBeVisible();

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
