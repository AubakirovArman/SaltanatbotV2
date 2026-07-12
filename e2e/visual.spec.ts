import { expect, test, type Page } from "@playwright/test";
import { installMarketSocketMock, mockCandleHistory, mockChartCandles } from "./support/marketMocks";

const instruments = [
  instrument("BTCUSDT", "Bitcoin / Tether", 100, 2),
  instrument("ETHUSDT", "Ethereum / Tether", 80, 2),
  instrument("SOLUSDT", "Solana / Tether", 60, 2),
  instrument("BNBUSDT", "BNB / Tether", 40, 2),
  instrument("EURUSD", "Euro / US Dollar", 1.08, 5, "forex")
];

test.beforeEach(async ({ page }) => {
  const candles = mockChartCandles();
  await page.clock.setFixedTime(new Date("2024-03-09T16:00:30.000Z"));
  await page.route("**/api/catalog", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      instruments,
      timeframes: ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1M"],
      chartTypes: ["candles", "hollow", "heikin", "bars", "line", "step", "area", "baseline", "renko", "linebreak", "kagi", "pnf"]
    })
  }));
  await page.route("**/api/sparklines?**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      timeframe: "1m",
      series: Object.fromEntries(instruments.map(({ symbol, basePrice }, index) => [symbol, {
        last: basePrice + index,
        changePct: index % 2 === 0 ? 1.25 : -0.75,
        points: [basePrice - 1, basePrice - 0.4, basePrice + 0.2, basePrice + index]
      }]))
    })
  }));
  await mockCandleHistory(page, candles);
  await installMarketSocketMock(page, "stable", candles);
  await page.goto("/");
  await expect(page.locator(".chart-legend .vol")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".status-pill.connected")).toBeVisible();
});

test("desktop trading terminal", async ({ page }) => {
  await waitForCanvasPaint(page, 1);
  await capture(page, "terminal-desktop-dark.png");
});

test("mobile market bottom sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Toggle markets panel" })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Toggle markets panel" }).click();
  await expect(page.getByRole("dialog", { name: "Markets" })).toBeVisible();
  await waitForCanvasPaint(page, 1);
  await capture(page, "terminal-mobile-markets-dark.png");
});

test("four independent markets layout", async ({ page }) => {
  await page.getByRole("button", { name: "Chart layout" }).click();
  await page.getByRole("menuitem", { name: "Four different markets" }).click();
  await expect(page.locator(".multi-chart-pane")).toHaveCount(4);
  await expect(page.getByRole("combobox", { name: "Symbol · 2" })).toHaveValue("ETHUSDT");
  await expect(page.getByRole("combobox", { name: "Symbol · 3" })).toHaveValue("SOLUSDT");
  await expect(page.getByRole("combobox", { name: "Symbol · 4" })).toHaveValue("BNBUSDT");
  await expect(page.locator(".chart-legend .vol")).toHaveCount(4);
  await waitForCanvasPaint(page, 4);
  await page.evaluate(async () => { await document.fonts.ready; });
  await expect(page.locator(".multi-chart-grid")).toHaveScreenshot("terminal-four-markets-dark.png", {
    animations: "disabled",
    caret: "hide",
    scale: "css",
    maxDiffPixelRatio: 0.002,
    maskColor: "#314151",
    mask: [page.locator(".pane-feed"), page.locator(".current-price-pill span")]
  });
});

test("strategy studio workspace", async ({ page }) => {
  await page.getByLabel("Workspace mode").getByRole("button", { name: "Strategy", exact: true }).click();
  await expect(page.locator(".strategy-lab")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("navigation", { name: "Studio stages" })).toBeVisible();
  await expect(page.locator(".blocklySvg")).toBeVisible({ timeout: 20_000 });
  await capture(page, "strategy-studio-dark.png");
});

async function capture(page: Page, name: string) {
  await page.evaluate(async () => { await document.fonts.ready; });
  await expect(page).toHaveScreenshot(name, {
    animations: "disabled",
    caret: "hide",
    scale: "css",
    maxDiffPixelRatio: 0.002,
    maskColor: "#314151",
    mask: [
      page.locator(".status-pill"),
      page.locator(".pane-feed"),
      page.locator(".current-price-pill span"),
      page.locator(".artifact-version-panel > summary"),
      page.locator(".ir-note")
    ]
  });
}

async function waitForCanvasPaint(page: Page, expectedCount: number) {
  const canvases = page.locator(".chart-canvas-primary");
  await expect(canvases).toHaveCount(expectedCount);
  await expect.poll(() => canvases.evaluateAll((items: HTMLCanvasElement[]) => items.every((canvas) => {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context || canvas.width === 0 || canvas.height === 0) return false;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let alpha = 3; alpha < pixels.length; alpha += 64) {
      if (pixels[alpha] > 0 && ++painted >= 32) return true;
    }
    return false;
  })), { timeout: 20_000 }).toBe(true);
}

function instrument(symbol: string, displayName: string, basePrice: number, decimals: number, assetClass = "crypto") {
  return {
    symbol,
    displayName,
    assetClass,
    exchange: assetClass === "crypto" ? "Binance / Bybit" : "Synthetic feed",
    currency: assetClass === "crypto" ? "USDT" : "USD",
    provider: assetClass === "crypto" ? "binance" : "synthetic",
    basePrice,
    decimals
  };
}
