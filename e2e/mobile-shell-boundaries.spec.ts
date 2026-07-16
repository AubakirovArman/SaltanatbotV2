import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { MOBILE_SHELL_MEDIA_QUERY } from "../frontend/src/hooks/useMediaQuery";
import { installMarketSocketMock, mockCandleHistory, mockChartCandles } from "./support/marketMocks";

const SHORT_LANDSCAPE_VIEWPORTS = [
  { width: 844, height: 390 },
  { width: 932, height: 430 }
] as const;

const TABLET_VIEWPORTS = [
  { width: 768, height: 1024 },
  { width: 1024, height: 768 }
] as const;

for (const viewport of SHORT_LANDSCAPE_VIEWPORTS) {
  test(`keeps coarse ${viewport.width}x${viewport.height} short-landscape inside the mobile shell and secondary maximize controls reachable`, async ({ browser, browserName, baseURL }) => {
    test.skip(browserName !== "chromium", "Chromium touch contexts provide the deterministic coarse-pointer boundary.");
    test.setTimeout(60_000);

    const { context, page } = await openTouchChart(browser, baseURL, viewport);
    try {
      await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/);
      await expect.poll(() => page.evaluate((query) => matchMedia(query).matches, MOBILE_SHELL_MEDIA_QUERY)).toBe(true);
      const shell = await page.evaluate(() => {
        const topbar = document.querySelector<HTMLElement>(".topbar")!.getBoundingClientRect();
        const workspace = document.querySelector<HTMLElement>(".workspace")!.getBoundingClientRect();
        const chartPanel = document.querySelector<HTMLElement>(".chart-panel")!.getBoundingClientRect();
        const chartStage = document.querySelector<HTMLElement>(".chart-stage")!.getBoundingClientRect();
        const toolRail = document.querySelector<HTMLElement>(".tool-rail")!;
        return {
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          topbarBottom: topbar.bottom,
          workspace: workspace.toJSON(),
          chartPanel: chartPanel.toJSON(),
          chartStage: chartStage.toJSON(),
          workspaceColumns: getComputedStyle(document.querySelector<HTMLElement>(".workspace")!).gridTemplateColumns,
          toolRailDisplay: getComputedStyle(toolRail).display
        };
      });
      expect(shell.overflowX).toBeLessThanOrEqual(1);
      expect(shell.workspace.x).toBeGreaterThanOrEqual(-1);
      expect(shell.workspace.right).toBeLessThanOrEqual(viewport.width + 1);
      expect(shell.workspace.y).toBeGreaterThanOrEqual(shell.topbarBottom - 1);
      expect(shell.chartPanel.width).toBeGreaterThanOrEqual(viewport.width - 2);
      expect(shell.chartStage.height).toBeGreaterThan(140);
      expect(shell.workspaceColumns.trim().split(/\s+/)).toHaveLength(1);
      expect(shell.toolRailDisplay).toBe("none");

      await openMobileTools(page);
      const marketsTrigger = page.getByRole("button", { name: "Toggle markets panel" });
      await expect(marketsTrigger).toHaveAttribute("aria-haspopup", "dialog");
      await marketsTrigger.click();
      const markets = page.getByRole("dialog", { name: "Markets" });
      await expect(markets).toBeVisible();
      const marketsBox = await markets.boundingBox();
      expect(marketsBox).not.toBeNull();
      expect(marketsBox!.y).toBeGreaterThanOrEqual(0);
      expect(marketsBox!.y + marketsBox!.height).toBeLessThanOrEqual(viewport.height + 1);
      await page.keyboard.press("Escape");
      await expect(markets).toBeHidden();

      await openMobileTools(page);
      await page.getByRole("button", { name: "Chart layout" }).click();
      await page.getByRole("menuitemradio", { name: "Vertical split" }).click();
      await expect(page.locator(".multi-chart-pane")).toHaveCount(2);
      const moreTools = page.getByRole("button", { name: "More tools" });
      if ((await moreTools.getAttribute("aria-expanded")) === "true") await moreTools.click();
      await expect(moreTools).toHaveAttribute("aria-expanded", "false");

      const secondary = page.locator(".multi-chart-pane.secondary");
      const maximize = secondary.locator(".pane-maximize.floating");
      await secondary.scrollIntoViewIfNeeded();
      await expect(maximize).toBeVisible();
      const maximizeBox = await maximize.boundingBox();
      expect(maximizeBox).not.toBeNull();
      expect(maximizeBox!.width).toBeGreaterThanOrEqual(44);
      expect(maximizeBox!.height).toBeGreaterThanOrEqual(44);
      await maximize.click();
      await expect(secondary).toHaveClass(/maximized/);
      await expect(page.locator(".multi-chart-pane:visible")).toHaveCount(1);

      const maximized = await secondary.evaluate((pane) => {
        const paneBox = pane.getBoundingClientRect();
        const buttonBox = pane.querySelector<HTMLElement>(".pane-maximize.floating")!.getBoundingClientRect();
        const surface = pane.querySelector<HTMLElement>(".chart-surface")!;
        const rail = pane.querySelector<HTMLElement>(".tool-rail")!;
        const grid = pane.closest<HTMLElement>(".multi-chart-grid")!;
        return {
          pane: paneBox.toJSON(),
          button: buttonBox.toJSON(),
          surfaceColumns: getComputedStyle(surface).gridTemplateColumns,
          railDisplay: getComputedStyle(rail).display,
          gridRows: getComputedStyle(grid).gridTemplateRows,
          gridOverflowY: getComputedStyle(grid).overflowY
        };
      });
      expect(maximized.button.x).toBeGreaterThanOrEqual(maximized.pane.x);
      expect(maximized.button.right).toBeLessThanOrEqual(maximized.pane.right + 1);
      expect(maximized.button.y).toBeGreaterThanOrEqual(maximized.pane.y);
      expect(maximized.railDisplay).toBe("none");
      expect(maximized.surfaceColumns.trim().split(/\s+/)).toHaveLength(1);
      expect(maximized.surfaceColumns).not.toContain("42px");
      expect(maximized.gridRows.trim().split(/\s+/)).toHaveLength(1);
      expect(maximized.gridOverflowY).toBe("hidden");
    } finally {
      await context.close().catch(() => {});
    }
  });
}

test("keeps Strategy Studio contained in a coarse short-landscape viewport", async ({ browser, browserName, baseURL }) => {
  test.skip(browserName !== "chromium", "Chromium touch contexts provide the deterministic coarse-pointer boundary.");
  test.setTimeout(60_000);

  const { context, page } = await openTouchChart(browser, baseURL, SHORT_LANDSCAPE_VIEWPORTS[0]);
  try {
    const navigation = page.getByRole("navigation", { name: "Primary workspaces" });
    await navigation.getByRole("button", { name: "Strategies", exact: true }).click();
    const strategyLab = page.locator(".strategy-lab");
    await expect(strategyLab).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("navigation", { name: "Strategy Studio panels" })).toBeVisible();
    await expect(page.locator(".blocklySvg")).toBeVisible({ timeout: 20_000 });
    const strategyGeometry = await page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>(".strategy-grid")!;
      const visiblePanes = [...grid.children].filter((element) => (element as HTMLElement).offsetParent !== null);
      return {
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        gridOverflowX: grid.scrollWidth - grid.clientWidth,
        columns: getComputedStyle(grid).gridTemplateColumns,
        visiblePanes: visiblePanes.length
      };
    });
    expect(strategyGeometry.overflowX).toBeLessThanOrEqual(1);
    expect(strategyGeometry.gridOverflowX).toBeLessThanOrEqual(1);
    expect(strategyGeometry.columns.trim().split(/\s+/)).toHaveLength(1);
    expect(strategyGeometry.visiblePanes).toBe(1);
  } finally {
    await context.close();
  }
});

test("keeps 768 and 1024 CSS-pixel coarse tablets contained without collapsing the desktop workspace", async ({ browser, browserName, baseURL }) => {
  test.skip(browserName !== "chromium", "Chromium touch contexts provide the deterministic coarse-pointer boundary.");
  test.setTimeout(90_000);

  for (const viewport of TABLET_VIEWPORTS) {
    const { context, page } = await openTouchChart(browser, baseURL, viewport);
    try {
      await expect.poll(() => page.evaluate((query) => matchMedia(query).matches, MOBILE_SHELL_MEDIA_QUERY)).toBe(false);
      const geometry = await page.evaluate(() => {
        const workspace = document.querySelector<HTMLElement>(".workspace")!;
        const chartPanel = document.querySelector<HTMLElement>(".chart-panel")!;
        const chartStage = document.querySelector<HTMLElement>(".chart-stage")!;
        const watchlist = document.querySelector<HTMLElement>(".workspace > .watchlist")!;
        const stats = document.querySelector<HTMLElement>(".workspace > .stats-panel")!;
        const toolRail = document.querySelector<HTMLElement>(".tool-rail")!;
        const visibleToolButtons = [...toolRail.querySelectorAll<HTMLElement>("button")].filter((button) => button.offsetParent !== null).map((button) => button.getBoundingClientRect());
        const axis = document.querySelector<HTMLElement>('[role="slider"][aria-label*="Price axis"]')!.getBoundingClientRect();
        return {
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          workspace: workspace.getBoundingClientRect().toJSON(),
          workspaceColumns: getComputedStyle(workspace).gridTemplateColumns,
          chartPanel: chartPanel.getBoundingClientRect().toJSON(),
          chartStage: chartStage.getBoundingClientRect().toJSON(),
          watchlist: watchlist.getBoundingClientRect().toJSON(),
          stats: stats.getBoundingClientRect().toJSON(),
          toolRailDisplay: getComputedStyle(toolRail).display,
          toolButtonMinimum: {
            width: Math.min(...visibleToolButtons.map((button) => button.width)),
            height: Math.min(...visibleToolButtons.map((button) => button.height))
          },
          axis: axis.toJSON()
        };
      });
      expect(geometry.overflowX).toBeLessThanOrEqual(1);
      expect(geometry.workspaceColumns.trim().split(/\s+/)).toHaveLength(3);
      expect(geometry.workspace.right).toBeLessThanOrEqual(viewport.width + 1);
      expect(geometry.chartPanel.width).toBeGreaterThanOrEqual(288);
      expect(geometry.chartStage.width).toBeGreaterThan(220);
      expect(geometry.watchlist.right).toBeLessThanOrEqual(geometry.chartPanel.x + 1);
      expect(geometry.stats.x).toBeGreaterThanOrEqual(geometry.chartPanel.right - 1);
      expect(geometry.stats.right).toBeLessThanOrEqual(viewport.width + 1);
      expect(geometry.toolRailDisplay).toBe("flex");
      expect(geometry.toolButtonMinimum.width).toBeGreaterThanOrEqual(44);
      expect(geometry.toolButtonMinimum.height).toBeGreaterThanOrEqual(44);
      expect(geometry.axis.x).toBeGreaterThanOrEqual(geometry.chartStage.x);
      expect(geometry.axis.right).toBeLessThanOrEqual(geometry.chartStage.right + 1);
    } finally {
      await context.close();
    }
  }
});

async function openTouchChart(browser: Browser, baseURL: string | undefined, viewport: { width: number; height: number }) {
  const context = await browser.newContext({
    baseURL,
    viewport,
    screen: viewport,
    colorScheme: "dark",
    locale: "en-US",
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
    reducedMotion: "reduce"
  });
  const page = await context.newPage();
  const candles = mockChartCandles();
  await page.addInitScript(() => {
    localStorage.setItem("sbv2:locale", "en");
    localStorage.setItem("mf:panel:left", "1");
    localStorage.setItem("mf:panel:right", "1");
  });
  await mockCandleHistory(page, candles);
  await installMarketSocketMock(page, "stable", candles);
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Primary workspaces" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("img", { name: /BTCUSDT candles chart on 1m/i })).toBeVisible({ timeout: 20_000 });
  return { context, page };
}

async function openMobileTools(page: Page) {
  const trigger = page.getByRole("button", { name: "More tools" });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
}
