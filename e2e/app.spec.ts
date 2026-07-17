import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createPluginSigningKeyPair, encodeSignedPluginFile, parsePluginFile, rotatePluginSigningKeyPair, type PluginManifest } from "@saltanatbotv2/plugin-core";
import { readFile } from "node:fs/promises";
import { installMarketSocketMock, mockCandleHistory, mockCandles, mockChartCandles } from "./support/marketMocks";
import { encodeStrategyFile } from "../frontend/src/strategy/strategyFile";
import type { StrategyArtifact } from "../frontend/src/strategy/library";
import type { EmergencyStopStatus } from "../frontend/src/trading/tradeClient";

test.beforeEach(async ({ page }) => {
  // Keep ordinary chart journeys independent from public exchange availability.
  // Scenarios that exercise provider errors/reconnects install a more specific
  // route and reload the document explicitly.
  await mockCandleHistory(page, mockChartCandles());
  await page.goto("/");
});

test("loads the terminal and exposes the chart semantically", { tag: "@smoke" }, async ({ page }) => {
  await expect(page.locator(".brand")).toContainText("SaltanatbotV2");
  await expect(page.getByRole("img", { name: /BTCUSDT candles chart on 1m/i })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("status", { name: /Feed:/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Toggle markets panel" })).toHaveAttribute("aria-pressed", "true");
});

test("shows localized recovery controls when the application module cannot load", { tag: "@smoke" }, async ({ page }) => {
  const applicationScript = await page.locator('script[type="module"][src*="/assets/"]').getAttribute("src");
  expect(applicationScript).toBeTruthy();
  await page.evaluate(() => localStorage.setItem("sbv2:locale", "ru"));
  await page.route(new URL(applicationScript!, page.url()).href, (route) => route.abort());

  await page.reload({ waitUntil: "domcontentloaded" });

  const recovery = page.locator("#startup-recovery");
  await expect(recovery).toBeVisible();
  await expect(recovery).toHaveAttribute("role", "alert", { timeout: 5_000 });
  await expect(recovery.getByRole("heading", { level: 1 })).toHaveText("Запуск занимает больше времени, чем ожидалось");
  await expect(recovery).toContainText("Сохранённые данные приложения не удалены");
  await expect(recovery.getByRole("button", { name: "Перезагрузить страницу" })).toBeVisible();
  await expect(recovery.getByRole("button", { name: "Обновить файлы приложения" })).toBeVisible();
  await expectNoAxeViolations(page);
});

test("installs a static offline shell without caching runtime market or trading data", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "The required push gate verifies service-worker behavior in Chromium.");
  test.setTimeout(90_000);

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifestHref).toBe("/manifest.webmanifest");
  const manifestResponse = await page.request.get(manifestHref!);
  expect(manifestResponse.ok()).toBe(true);
  expect(manifestResponse.headers()["cache-control"]).toContain("no-cache");
  expect(await manifestResponse.json()).toMatchObject({
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    launch_handler: { client_mode: "navigate-existing" },
    file_handlers: [
      { action: "/?view=strategy", accept: { "text/plain": [".pine"] }, launch_type: "single-client" },
      { action: "/?view=strategy", accept: { "application/vnd.saltanatbotv2.strategy+json": [".strategy"] }, launch_type: "single-client" },
      { action: "/?view=strategy", accept: { "application/vnd.saltanatbotv2.plugin+json": [".saltanat-plugin"] }, launch_type: "single-client" }
    ],
    share_target: {
      action: "/share-target",
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        files: [
          {
            name: "research_files",
            accept: [".pine", ".strategy", ".saltanat-plugin", "application/vnd.saltanatbotv2.strategy+json", "application/vnd.saltanatbotv2.plugin+json"]
          }
        ]
      }
    },
    shortcuts: [
      { short_name: "Chart", url: "/?view=chart" },
      { short_name: "Strategy", url: "/?view=strategy" }
    ]
  });

  const workerResponse = await page.request.get("/service-worker.js");
  expect(workerResponse.ok()).toBe(true);
  expect(workerResponse.headers()["cache-control"]).toContain("no-cache");
  expect(workerResponse.headers()["service-worker-allowed"]).toBe("/");

  const scriptUrl = await page.locator('script[type="module"][src*="/assets/"]').getAttribute("src");
  expect(scriptUrl).toBeTruthy();
  const scriptResponse = await page.request.get(scriptUrl!);
  expect(scriptResponse.headers()["cache-control"]).toContain("immutable");

  await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).active)), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 20_000 }).toBe(true);

  const cachedUrls = await page.evaluate(async () => {
    const names = (await caches.keys()).filter((name) => name.startsWith("saltanat-shell-"));
    return (await Promise.all(names.map(async (name) => (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname)))).flat();
  });
  expect(cachedUrls).toContain("/");
  expect(cachedUrls.some((url) => url.startsWith("/assets/") && url.endsWith(".js"))).toBe(true);
  expect(cachedUrls.some((url) => ["/api/", "/stream", "/quotes", "/orderbook", "/trade-flow", "/trade-stream"].some((prefix) => url.startsWith(prefix)))).toBe(false);

  await page.getByRole("button", { name: "Offline research" }).click();
  const researchDialog = page.getByRole("dialog", { name: "Offline research" });
  await expect(researchDialog).toBeVisible();
  await researchDialog.getByRole("button", { name: "Make available offline" }).click();
  await expect(researchDialog.getByRole("status")).toContainText("Ready offline", { timeout: 30_000 });
  await researchDialog.getByRole("button", { name: "Close offline research settings" }).click();
  const researchCachedUrls = await page.evaluate(async () => {
    const name = (await caches.keys()).find((candidate) => candidate.startsWith("saltanat-shell-") && candidate.endsWith("-research"));
    return name ? (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname) : [];
  });
  expect(researchCachedUrls.some((url) => url.includes("StrategyLab"))).toBe(true);
  expect(researchCachedUrls.some((url) => url.includes("blockly-runtime"))).toBe(true);
  expect(researchCachedUrls.some((url) => url.includes("TradingView"))).toBe(false);

  await page.route("**/api/pwa-offline-probe", (route) => route.abort());
  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".brand")).toContainText("SaltanatbotV2");
    const runtimeRequest = await page.evaluate(async () => {
      try {
        await fetch("/api/pwa-offline-probe");
        return "resolved";
      } catch {
        return "rejected";
      }
    });
    expect(runtimeRequest).toBe("rejected");

    await page.evaluate(() => history.replaceState(null, "", "/?view=strategy"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".strategy-lab")).toBeVisible({ timeout: 20_000 });

    const sharedDestination = await shareResearchFiles(page, [
      {
        name: "offline-share.pine",
        type: "text/plain",
        content: ["//@version=6", 'indicator("Offline Share", overlay=false)', 'plot(close, "Close")'].join("\n")
      }
    ]);
    const sharedToken = new URL(sharedDestination).searchParams.get("share");
    expect(sharedToken).toMatch(/^[0-9a-f-]{36}$/);
    const sharedReview = page.getByRole("dialog", { name: "Review files shared with SaltanatbotV2" });
    await expect(sharedReview).toContainText("offline-share.pine", { timeout: 20_000 });
    await expect(page.locator(".strategy-lab")).toHaveCount(0);
    await sharedReview.getByRole("button", { name: "Cancel" }).click();
    await expect(sharedReview).toBeHidden();
    await expect.poll(() => hasPendingSharedFiles(page, sharedToken!)).toBe(false);
  } finally {
    await context.setOffline(false);
  }
  await page.getByRole("button", { name: "Offline research" }).click();
  const removalDialog = page.getByRole("dialog", { name: "Offline research" });
  await removalDialog.getByRole("button", { name: "Remove offline files" }).click();
  await expect(removalDialog.getByRole("status")).toContainText("Not stored for offline use");
  expect(await page.evaluate(async () => (await caches.keys()).some((name) => name.startsWith("saltanat-shell-") && name.endsWith("-research")))).toBe(false);
  await page.evaluate(() => history.replaceState(null, "", "/?view=chart"));
  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".brand")).toContainText("SaltanatbotV2");
  } finally {
    await context.setOffline(false);
  }
});

test("adds, configures and removes the visible-range volume profile accessibly", async ({ page }) => {
  await expect(page.getByRole("img", { name: /BTCUSDT candles chart on 1m/i })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".volume-profile-badge")).toHaveCount(0);

  await page.locator(".indicator-add").click();
  await page.getByRole("menuitem", { name: /Volume Profile/i }).click();

  const settings = page.getByRole("dialog", { name: "Volume Profile settings" });
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Close indicator editor" }).click();
  await expect(settings).toBeHidden();
  await expect(page.locator(".volume-profile-badge")).toContainText("POC", { timeout: 20_000 });

  await page.getByRole("button", { name: "Hide Volume Profile" }).click();
  await expect(page.locator(".volume-profile-badge")).toBeHidden();
  await page.getByRole("button", { name: "Show Volume Profile" }).click();
  await expect(page.locator(".volume-profile-badge")).toBeVisible();

  await page.getByRole("button", { name: "Remove Volume Profile" }).click();
  await expect(page.getByRole("button", { name: "Remove Volume Profile" })).toHaveCount(0);
  await expect(page.locator(".volume-profile-badge")).toHaveCount(0);
});

test("keeps mobile touch indicator controls clear of the price axis in single and split layouts", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "CDP touch emulation is Chromium-specific.");
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await expect.poll(() => page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  await expect(page.locator(".chart-legend .vol")).toBeVisible({ timeout: 20_000 });

  const expectTouchTarget = async (target: Locator) => {
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  };

  const expectOverlayClearOfAxis = async (scope = page.locator(".multi-chart-pane.primary")) => {
    const overlayBox = await scope.locator(".chart-indicator-overlay").boundingBox();
    const axisBox = await scope.getByRole("slider", { name: /Price axis scale/i }).boundingBox();
    expect(overlayBox).not.toBeNull();
    expect(axisBox).not.toBeNull();
    expect(overlayBox!.x + overlayBox!.width).toBeLessThanOrEqual(axisBox!.x + 1);
  };

  const expectChartDataClearOfAxis = async (scope: Locator) => {
    const toggle = scope.locator(".chart-data-toggle");
    const toggleBox = await toggle.boundingBox();
    const axisBox = await scope.getByRole("slider", { name: /Price axis scale/i }).boundingBox();
    expect(toggleBox).not.toBeNull();
    expect(axisBox).not.toBeNull();
    expect(toggleBox!.x + toggleBox!.width).toBeLessThanOrEqual(axisBox!.x + 1);
    await expectTouchTarget(toggle);
  };

  const primary = page.locator(".multi-chart-pane.primary");
  await expectOverlayClearOfAxis(primary);
  await expectTouchTarget(primary.locator(".indicator-add"));
  await expectTouchTarget(primary.locator(".compare-add"));

  await primary.locator(".indicator-add").click();
  await page.getByRole("menuitem", { name: /Volume Profile/i }).click();
  const settings = page.getByRole("dialog", { name: "Volume Profile settings" });
  await expect(settings).toBeVisible();
  const settingsBox = await settings.boundingBox();
  const priceAxisBox = await primary.getByRole("slider", { name: /Price axis scale/i }).boundingBox();
  expect(settingsBox).not.toBeNull();
  expect(priceAxisBox).not.toBeNull();
  expect(settingsBox!.x + settingsBox!.width).toBeLessThanOrEqual(priceAxisBox!.x + 1);
  const closeSettings = settings.getByRole("button", { name: "Close indicator editor" });
  await expectTouchTarget(closeSettings);
  await closeSettings.click();
  await expect(settings).toBeHidden();

  const indicatorStrip = primary.locator(".indicator-strip");
  await indicatorStrip.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  const removeProfile = primary.getByRole("button", { name: "Remove Volume Profile" });
  await expect(removeProfile).toBeVisible();
  const removeBox = await removeProfile.boundingBox();
  const currentAxisBox = await primary.getByRole("slider", { name: /Price axis scale/i }).boundingBox();
  expect(removeBox).not.toBeNull();
  expect(currentAxisBox).not.toBeNull();
  expect(removeBox!.x + removeBox!.width).toBeLessThanOrEqual(currentAxisBox!.x + 1);
  expect(removeBox!.width).toBeGreaterThanOrEqual(44);
  await removeProfile.click();

  const axisBox = await primary.getByRole("slider", { name: /Price axis scale/i }).boundingBox();
  const scaleBox = await primary.locator(".scale-toggle").boundingBox();
  expect(axisBox).not.toBeNull();
  expect(scaleBox).not.toBeNull();
  expect(axisBox!.y + axisBox!.height).toBeLessThanOrEqual(scaleBox!.y + 1);
  await expectChartDataClearOfAxis(primary);

  await primary.locator(".compare-add").click();
  const compareMenu = primary.locator(".compare-menu");
  await expect(compareMenu).toBeVisible();
  await expectTouchTarget(compareMenu.locator(".compare-search"));
  const firstCompareOption = compareMenu.getByRole("option").first();
  await expect(firstCompareOption).toBeVisible();
  await expectTouchTarget(firstCompareOption);
  await firstCompareOption.click();
  const compareChip = primary.locator(".compare-chip").first();
  await expect(compareChip).toBeVisible();
  for (const button of await compareChip.locator("button").all()) await expectTouchTarget(button);
  const compareSettings = primary.locator(".compare-settings");
  await expect(compareSettings).toBeVisible();
  await expectTouchTarget(compareSettings.locator("header button"));
  await compareSettings.locator("header button").click();
  await expect(compareSettings).toBeHidden();
  await compareChip.locator("button").last().click();
  await expect(compareChip).toHaveCount(0);

  await openMobileTools(page);
  await page.getByRole("button", { name: "Chart layout" }).click();
  await page.getByRole("menuitemradio", { name: "Vertical split" }).click();
  const mobileTools = page.getByRole("button", { name: "More tools" });
  if ((await mobileTools.getAttribute("aria-expanded")) === "true") await mobileTools.click();
  await expect(page.locator(".multi-chart-pane")).toHaveCount(2);
  await expect(primary.locator(".compact-chart")).toBeVisible();
  await expectOverlayClearOfAxis(primary);
  await expectChartDataClearOfAxis(primary);

  await primary.locator(".indicator-add").click();
  const indicatorMenu = primary.locator('.indicator-menu[role="menu"]');
  await expect(indicatorMenu).toBeVisible();
  const menuItems = indicatorMenu.getByRole("menuitem");
  expect(await menuItems.count()).toBeGreaterThan(8);
  const indicatorMenuBox = await indicatorMenu.boundingBox();
  const primaryPaneBox = await primary.boundingBox();
  const viewport = page.viewportSize();
  expect(indicatorMenuBox).not.toBeNull();
  expect(primaryPaneBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(indicatorMenuBox!.x).toBeGreaterThanOrEqual(8);
  expect(indicatorMenuBox!.y).toBeGreaterThanOrEqual(96);
  expect(indicatorMenuBox!.x + indicatorMenuBox!.width).toBeLessThanOrEqual(viewport!.width - 8);
  expect(indicatorMenuBox!.y + indicatorMenuBox!.height).toBeLessThanOrEqual(viewport!.height - 8);
  expect(indicatorMenuBox!.y + indicatorMenuBox!.height).toBeGreaterThan(primaryPaneBox!.y + primaryPaneBox!.height + 44);
  const crossingPoint = {
    x: indicatorMenuBox!.x + indicatorMenuBox!.width / 2,
    y: Math.min(indicatorMenuBox!.y + indicatorMenuBox!.height - 8, primaryPaneBox!.y + primaryPaneBox!.height + 16)
  };
  expect(crossingPoint.y).toBeGreaterThan(primaryPaneBox!.y + primaryPaneBox!.height);
  expect(
    await indicatorMenu.evaluate((element, point) => {
      const hit = document.elementFromPoint(point.x, point.y);
      return Boolean(hit && element.contains(hit));
    }, crossingPoint)
  ).toBe(true);
  const lastMenuItem = menuItems.last();
  await lastMenuItem.scrollIntoViewIfNeeded();
  await expectTouchTarget(lastMenuItem);
  const lastMenuItemBox = await lastMenuItem.boundingBox();
  expect(lastMenuItemBox).not.toBeNull();
  expect(lastMenuItemBox!.y).toBeGreaterThanOrEqual(indicatorMenuBox!.y);
  expect(lastMenuItemBox!.y + lastMenuItemBox!.height).toBeLessThanOrEqual(indicatorMenuBox!.y + indicatorMenuBox!.height);
  expect(
    await lastMenuItem.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return Boolean(hit && element.contains(hit));
    })
  ).toBe(true);
  await page.getByRole("menuitem", { name: /Volume Profile/i }).click();
  await expect(settings).toBeVisible();
  const compactSettingsBox = await settings.boundingBox();
  expect(compactSettingsBox).not.toBeNull();
  expect(compactSettingsBox!.x).toBeGreaterThanOrEqual(8);
  expect(compactSettingsBox!.x + compactSettingsBox!.width).toBeLessThanOrEqual(382);
  expect(compactSettingsBox!.y).toBeGreaterThanOrEqual(96);
  expect(compactSettingsBox!.y + compactSettingsBox!.height).toBeLessThanOrEqual(836);
  await settings.getByRole("button", { name: "Close indicator editor" }).click();
  await expect(settings).toBeHidden();

  await page.setViewportSize({ width: 761, height: 844 });
  await expect.poll(() => page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  await expect.poll(() => page.evaluate(() => matchMedia("(max-width: 760px)").matches)).toBe(false);
  await expectTouchTarget(primary.locator(".indicator-add"));
  await expectTouchTarget(primary.locator(".compare-add"));
  await expectChartDataClearOfAxis(primary);
});

test("shows and toggles the semantic UTC session liquidity map", async ({ page }) => {
  await selectChartSymbol(page, "EURUSD");
  await openChartAnalysis(page);
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
  await openChartAnalysis(page);
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
  await page.getByRole("button", { name: "More timeframes" }).click();
  await page.getByRole("menuitemradio", { name: "4h", exact: true }).click();
  await expect(page.getByRole("button", { name: /Asia session.*Available on 1-minute through 1-hour charts/ })).toBeDisabled();
});

test("controls confirmed market structure independently on every timeframe", async ({ page }) => {
  await selectChartSymbol(page, "EURUSD");
  await openChartAnalysis(page);
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

  await page.getByRole("button", { name: "More timeframes" }).click();
  await page.getByRole("menuitemradio", { name: "1d", exact: true }).click();
  await expect(page.getByRole("button", { name: /Toggle UTC map.*available on 1-minute through 4-hour charts/i })).toBeDisabled();
  await expect(structure).toBeEnabled();
  await expect(fvg).toBeEnabled();
});

test("renders a localized non-repainting Three Line Break chart", async ({ page }) => {
  await selectChartSymbol(page, "EURUSD");
  await page.getByRole("button", { name: "Chart type", exact: true }).click();
  const lineBreak = page.getByRole("menuitemradio", { name: "Three Line Break" });
  await expect(lineBreak).toBeVisible();
  await lineBreak.click();
  await expect(page.getByRole("img", { name: /EURUSD Three Line Break chart on 1m.*confirmed close-only lines with a 3-line reversal/i })).toBeVisible({ timeout: 20_000 });
  await expectNoAxeViolations(page);

  await page.getByRole("button", { name: "Switch interface language to Russian" }).click();
  await page.getByTitle("Тип графика").click();
  await expect(page.getByRole("menuitemradio", { name: "Трёхлинейный прорыв" })).toHaveAttribute("aria-checked", "true");
});

test("renders stable confirmed Renko with a semantic candle table", async ({ page }) => {
  await selectChartSymbol(page, "EURUSD");
  await page.getByTitle("Chart type").click();
  await page.getByRole("menuitemradio", { name: "Renko" }).click();
  await expect(page.getByRole("img", { name: /EURUSD Renko chart on 1m.*confirmed close-only fixed 0.05% bricks with a two-brick reversal/i })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".legend-symbol")).toContainText("RENKO 0.05%");
  await page.getByRole("button", { name: "Chart data", exact: true }).click();
  await expect(page.getByRole("table", { name: "Latest candle" })).toBeVisible();
  await expectNoAxeViolations(page);
});

test("renders accessible confirmed Kagi shoulders and waists", async ({ page }) => {
  await selectChartSymbol(page, "EURUSD");
  await page.getByTitle("Chart type").click();
  await page.getByRole("menuitemradio", { name: "Kagi" }).click();
  await expect(page.getByRole("img", { name: /EURUSD Kagi chart on 1m.*confirmed close-only lines with a fixed 0.10% reversal, shoulders and waists/i })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".legend-symbol")).toContainText("KAGI 0.10%");
  await page.getByRole("button", { name: "Chart data", exact: true }).click();
  await expect(page.getByRole("table", { name: "Latest candle" })).toBeVisible();
  await expectNoAxeViolations(page);
});

test("configures and persists confirmed price-chart construction", async ({ page }) => {
  await selectChartSymbol(page, "EURUSD");

  await page.getByTitle("Chart type").click();
  await page.getByRole("menuitemradio", { name: "Kagi" }).click();
  await page.locator('summary[aria-label="KAGI 0.10% settings"]').click();
  await page.getByLabel("Reversal percentage").fill("0.25");
  await expect(page.getByRole("img", { name: /fixed 0.25% reversal/ })).toBeVisible();
  await expect(page.locator(".legend-symbol")).toContainText("KAGI 0.25%");
  await page.getByRole("button", { name: "Reset default" }).click();
  await expect(page.locator(".legend-symbol")).toContainText("KAGI 0.10%");
  await page.getByLabel("Reversal percentage").fill("0.25");

  await page.getByTitle("Chart type").click();
  await page.getByRole("menuitemradio", { name: "Renko" }).click();
  await page.locator('summary[aria-label="RENKO 0.05% settings"]').click();
  await page.getByLabel("Brick percentage").fill("0.20");
  await expect(page.getByRole("img", { name: /fixed 0.20% bricks/ })).toBeVisible();

  await page.getByTitle("Chart type").click();
  await page.getByRole("menuitemradio", { name: "Three Line Break" }).click();
  const lineBreakSettings = page.locator(".price-representation-control summary");
  await lineBreakSettings.click();
  await page.getByLabel("Reversal depth").fill("5");
  await expect(page.getByRole("img", { name: /5-line reversal/ })).toBeVisible();

  await page.getByTitle("Chart type").click();
  await page.getByRole("menuitemradio", { name: "Point & Figure" }).click();
  const pointAndFigureSettings = page.locator(".price-representation-control summary");
  await pointAndFigureSettings.click();
  await page.getByLabel("Box percentage").fill("0.50");
  await page.getByLabel("Reversal boxes").fill("4");
  await expect(page.getByRole("img", { name: /Point & Figure.*0.50% boxes and a 4-box reversal/ })).toBeVisible();
  await expect(page.locator(".legend-symbol")).toContainText("P&F 0.50% ×4");
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("sbv2:price-representation-settings:v2:chart-1:EURUSD") ?? "null")))
    .toMatchObject({
      renkoBrickPercent: 0.2,
      lineBreakDepth: 5,
      kagiReversalPercent: 0.25,
      pnfBoxPercent: 0.5,
      pnfReversalBoxes: 4
    });
  await expectNoAxeViolations(page);
  await page.keyboard.press("Escape");
  await expect(page.locator(".price-representation-control")).not.toHaveAttribute("open", "");
  await expect(pointAndFigureSettings).toBeFocused();
});

test("isolates price-chart construction settings by pane and symbol", async ({ page }) => {
  await page.getByRole("button", { name: "Chart layout" }).click();
  await page.getByRole("menuitemradio", { name: "Vertical split" }).click();
  await page.getByRole("button", { name: "Chart type", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Renko" }).click();

  const primary = page.locator(".multi-chart-pane.primary");
  const secondary = page.locator(".multi-chart-pane.secondary");
  await expect(primary.getByRole("img", { name: /BTCUSDT Renko chart/ })).toBeVisible({ timeout: 20_000 });
  await expect(secondary.getByRole("img", { name: /BTCUSDT Renko chart/ })).toBeVisible({ timeout: 20_000 });
  await expect(secondary.locator('[data-link-field="linkChartType"]')).toHaveAttribute("aria-pressed", "true");

  await primary.locator('summary[aria-label="RENKO 0.05% settings"]').click();
  await primary.getByLabel("Brick percentage").fill("0.20");
  await expect(primary.locator('summary[aria-label="RENKO 0.20% settings"]')).toBeVisible();
  await expect(secondary.locator('summary[aria-label="RENKO 0.05% settings"]')).toBeVisible();

  await secondary.locator('summary[aria-label="RENKO 0.05% settings"]').click();
  await secondary.getByLabel("Brick percentage").fill("0.30");
  await expect(secondary.locator('summary[aria-label="RENKO 0.30% settings"]')).toBeVisible();
  await expect(primary.locator('summary[aria-label="RENKO 0.20% settings"]')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        primary: JSON.parse(localStorage.getItem("sbv2:price-representation-settings:v2:chart-1:BTCUSDT") ?? "null")?.renkoBrickPercent,
        secondary: JSON.parse(localStorage.getItem("sbv2:price-representation-settings:v2:chart-2:BTCUSDT") ?? "null")?.renkoBrickPercent
      }))
    )
    .toEqual({ primary: 0.2, secondary: 0.3 });

  await page.reload();
  const restoredPrimary = page.locator(".multi-chart-pane.primary");
  const restoredSecondary = page.locator(".multi-chart-pane.secondary");
  await expect(restoredPrimary.locator('summary[aria-label="RENKO 0.20% settings"]')).toBeVisible({ timeout: 20_000 });
  await expect(restoredSecondary.locator('summary[aria-label="RENKO 0.30% settings"]')).toBeVisible({ timeout: 20_000 });
  await expectNoAxeViolations(page);
});

test("keeps mouse and trackpad chart zoom controlled and resettable", { tag: "@smoke" }, async ({ page }) => {
  test.slow();
  const candles = mockChartCandles();
  await mockCandleHistory(page, candles);
  await installMarketSocketMock(page, "stable", candles);
  await navigateToCurrentAppAndWaitForWorkspace(page);
  const canvas = page.locator(".chart-canvas-interaction");
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".chart-legend .vol")).toBeVisible({ timeout: 20_000 });
  const reset = page.getByRole("button", { name: "Reset chart zoom (100%)" });
  await expect(reset).toBeVisible();
  await canvas.hover();
  const cancelled = await canvas.evaluate((element) => {
    const event = new WheelEvent("wheel", { deltaY: -1, clientX: 500, clientY: 250, bubbles: true, cancelable: true });
    return !element.dispatchEvent(event);
  });
  expect(cancelled).toBe(true);
  await page.mouse.wheel(0, -60);
  await expect(page.getByRole("button", { name: /Reset chart zoom \(1(0[1-9]|[1-9][0-9])%\)/ })).toBeVisible();
  await page.getByRole("button", { name: /Reset chart zoom/ }).click();
  await expect(reset).toBeVisible();
});

test("keeps a two-finger touch gesture inside the chart and zooms around its midpoint", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "CDP multi-touch injection is Chromium-specific; pure gesture math is engine-independent.");
  test.slow();
  const canvas = page.locator(".chart-canvas-interaction");
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".chart-legend .vol")).toBeVisible({ timeout: 20_000 });
  await expect(canvas).toHaveCSS("touch-action", "none");
  await expect(canvas).toHaveCSS("overscroll-behavior", "contain");

  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
  const scrollBefore = await page.evaluate(() => window.scrollY);
  const reset = page.getByRole("button", { name: /Reset chart zoom/ });
  await expect(async () => {
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const y = box!.y + box!.height * 0.52;
    const center = box!.x + box!.width * 0.5;
    const point = (x: number, id: number) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 });
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(center - 60, 1)] });
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(center - 60, 1), point(center + 60, 2)] });
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(center - 120, 1), point(center + 120, 2)] });
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    expect(await reset.getAttribute("aria-label")).toMatch(/\((1[1-9][0-9]|[2-4][0-9]{2})%\)/);
  }).toPass({ timeout: 10_000 });
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
});

test("uses movement slop before long-press inspect and exposes the touch mode", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "CDP touch injection is Chromium-specific.");
  const candles = mockChartCandles();
  await mockCandleHistory(page, candles);
  await installMarketSocketMock(page, "stable", candles);
  await navigateToCurrentAppAndWaitForWorkspace(page);
  const canvas = page.locator(".chart-canvas-interaction");
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".chart-legend .vol")).toBeVisible({ timeout: 20_000 });
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
  const start = { x: box!.x + box!.width * 0.45, y: box!.y + box!.height * 0.45, id: 1, radiusX: 4, radiusY: 4, force: 1 };

  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
  await expect(canvas).toHaveAttribute("data-touch-mode", "pending-pan");
  await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...start, x: start.x + 6, y: start.y + 8 }] });
  await expect(canvas).toHaveAttribute("data-touch-mode", "pending-pan");
  await expect(canvas).toHaveAttribute("data-touch-mode", "inspect", { timeout: 2_000 });
  await expect(page.locator(".crosshair-hud")).toBeVisible();

  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(canvas).toHaveAttribute("data-touch-mode", "idle");
  await expect(page.locator(".crosshair-hud")).toBeHidden();
});

test("does not commit a drawing anchor when a second finger promotes draw to pinch", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "CDP multi-touch injection is Chromium-specific.");
  const candles = mockChartCandles();
  await mockCandleHistory(page, candles);
  await installMarketSocketMock(page, "stable", candles);
  await navigateToCurrentAppAndWaitForWorkspace(page);
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.includes("drawings:v2")) localStorage.removeItem(key);
    }
  });
  const canvas = page.locator(".chart-canvas-interaction");
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  const horizontalLine = page.getByRole("button", { name: "Horizontal line" });
  await horizontalLine.click();
  await expect(horizontalLine).toHaveAttribute("aria-pressed", "true");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
  const y = box!.y + box!.height * 0.48;
  const center = box!.x + box!.width * 0.48;
  const point = (x: number, id: number) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 });

  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(center - 50, 1)] });
  await expect(canvas).toHaveAttribute("data-touch-mode", "pending-draw");
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(center - 50, 1), point(center + 50, 2)] });
  await expect(canvas).toHaveAttribute("data-touch-mode", "pinch");
  await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(center - 90, 1), point(center + 90, 2)] });
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(canvas).toHaveAttribute("data-touch-mode", "idle");
  await expect(horizontalLine).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.entries(localStorage)
          .filter(([key]) => key.includes("drawings:v2"))
          .map(([, value]) => JSON.parse(value))
      )
    )
    .toEqual([]);
});

test("resumes one-finger pan after pinch without re-entering an active drawing tool", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Synthetic multi-pointer sequencing is Chromium-specific.");
  const candles = mockChartCandles();
  await mockCandleHistory(page, candles);
  await installMarketSocketMock(page, "stable", candles);
  await navigateToCurrentAppAndWaitForWorkspace(page);
  const canvas = page.locator(".chart-canvas-interaction");
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const y = box!.y + box!.height * 0.5;
  const center = box!.x + box!.width * 0.5;
  await canvas.evaluate((element) => {
    const target = element as HTMLCanvasElement;
    target.setPointerCapture = () => undefined;
    target.hasPointerCapture = () => true;
    target.releasePointerCapture = () => undefined;
  });
  const fire = async (type: string, pointerId: number, x: number, isPrimary: boolean) => {
    await canvas.evaluate(
      (element, input) => {
        element.dispatchEvent(
          new PointerEvent(input.type, {
            bubbles: true,
            cancelable: true,
            pointerType: "touch",
            pointerId: input.pointerId,
            isPrimary: input.isPrimary,
            button: 0,
            buttons: input.type === "pointerup" ? 0 : 1,
            clientX: input.x,
            clientY: input.y
          })
        );
      },
      { type, pointerId, x, isPrimary, y }
    );
  };

  await fire("pointerdown", 101, center - 60, true);
  await expect(canvas).toHaveAttribute("data-touch-mode", "pending-pan");
  await fire("pointerdown", 102, center + 60, false);
  await expect(canvas).toHaveAttribute("data-touch-mode", "pinch");
  await fire("pointermove", 101, center - 90, true);
  await fire("pointermove", 102, center + 90, false);
  await fire("pointerup", 102, center + 90, false);
  await expect(canvas).toHaveAttribute("data-touch-mode", "pan");
  await fire("pointermove", 101, center - 120, true);
  await expect(canvas).toHaveAttribute("data-touch-mode", "pan");
  await fire("pointerup", 101, center - 120, true);
  await expect(canvas).toHaveAttribute("data-touch-mode", "idle");
});

test("clears draft gestures on pointercancel, lost capture and viewport rotation without deleting completed drawings", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "CDP touch cancellation is Chromium-specific.");
  const candles = mockChartCandles();
  await mockCandleHistory(page, candles);
  await installMarketSocketMock(page, "stable", candles);
  await navigateToCurrentAppAndWaitForWorkspace(page);
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.includes("drawings:v2")) localStorage.removeItem(key);
    }
  });
  const canvas = page.locator(".chart-canvas-interaction");
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Horizontal line" }).click();
  await canvas.click({ position: { x: 430, y: 260 } });
  const storedTools = () =>
    page.evaluate(() =>
      Object.entries(localStorage)
        .filter(([key]) => key.includes("drawings:v2"))
        .flatMap(([, value]) => (JSON.parse(value) as Array<{ tool: string }>).map((drawing) => drawing.tool))
    );
  await expect.poll(storedTools).toEqual(["hline"]);

  const trendLine = page.getByRole("button", { name: "Trend line" });
  await trendLine.click();
  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
  const touchAt = async (id: number, end = true) => {
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const point = { x: box!.x + box!.width * 0.42, y: box!.y + box!.height * 0.44, id, radiusX: 4, radiusY: 4, force: 1 };
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    if (end) await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };

  await touchAt(1);
  await expect(canvas).toHaveAttribute("data-touch-mode", "idle");
  await touchAt(2, false);
  await expect(canvas).toHaveAttribute("data-touch-mode", "pending-draw");
  await client.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await expect(canvas).toHaveAttribute("data-touch-mode", "idle");
  await touchAt(3);
  await expect.poll(storedTools).toEqual(["hline"]);

  await touchAt(4, false);
  await expect(canvas).toHaveAttribute("data-touch-mode", "pending-draw");
  await page.setViewportSize({ width: 600, height: 1000 });
  await page.evaluate(() => window.dispatchEvent(new Event("orientationchange")));
  await expect(canvas).toHaveAttribute("data-touch-mode", "idle");
  await client.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }).catch(() => undefined);
  await touchAt(5);
  await expect.poll(storedTools).toEqual(["hline"]);

  await canvas.evaluate((element) => {
    const target = element as HTMLCanvasElement;
    target.setPointerCapture = () => undefined;
    target.hasPointerCapture = () => true;
    target.releasePointerCapture = () => undefined;
    const rect = target.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      pointerType: "touch",
      pointerId: 77,
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: rect.left + rect.width * 0.46,
      clientY: rect.top + rect.height * 0.46
    };
    target.dispatchEvent(new PointerEvent("pointerdown", init));
    target.dispatchEvent(new PointerEvent("lostpointercapture", { ...init, buttons: 0 }));
  });
  await expect(canvas).toHaveAttribute("data-touch-mode", "idle");
  await touchAt(6);
  await expect.poll(storedTools).toEqual(["hline"]);
});

test("keeps repeated mobile pinch-out stable at the minimum chart zoom", async ({ browser, browserName, baseURL }) => {
  test.skip(browserName !== "chromium", "CDP multi-touch injection is Chromium-specific; pure gesture math is engine-independent.");
  test.slow();
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  let mainFrameNavigations = 0;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) mainFrameNavigations += 1;
  });

  try {
    const candles = mockChartCandles();
    await mockCandleHistory(page, candles);
    await installMarketSocketMock(page, "stable", candles);
    await page.goto("/");
    const canvas = page.locator(".chart-canvas-interaction");
    await expect(canvas).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".chart-legend .vol")).toBeVisible({ timeout: 20_000 });
    const navigationsAfterStartup = mainFrameNavigations;
    const client = await page.context().newCDPSession(page);
    await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();
      const y = box!.y + box!.height * 0.52;
      const center = box!.x + box!.width * 0.5;
      const point = (x: number, id: number) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 });
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(center - 90, 1)] });
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(center - 90, 1), point(center + 90, 2)] });
      for (const distance of [140, 100, 70, 40, 20, 8, 2, 1]) {
        await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(center - distance / 2, 1), point(center + distance / 2, 2)] });
      }
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }

    await canvas.evaluate(async (element) => {
      const canvas = element as HTMLCanvasElement;
      const prototype = HTMLCanvasElement.prototype;
      const originalSet = prototype.setPointerCapture;
      const originalHas = prototype.hasPointerCapture;
      const originalRelease = prototype.releasePointerCapture;

      // Synthetic PointerEvents are absent from Chromium's active-pointer
      // table. Stub capture only so move/up frames can be delivered in one JS
      // task, reproducing coalesced mobile hardware input deterministically.
      prototype.setPointerCapture = () => {};
      prototype.hasPointerCapture = () => true;
      prototype.releasePointerCapture = () => {};

      try {
        const rect = canvas.getBoundingClientRect();
        const center = rect.left + rect.width / 2;
        const y = rect.top + rect.height * 0.52;
        const fire = (type: string, pointerId: number, x: number, isPrimary: boolean) => {
          canvas.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerType: "touch",
              pointerId,
              isPrimary,
              button: 0,
              buttons: type === "pointerup" ? 0 : 1,
              clientX: x,
              clientY: y
            })
          );
        };

        fire("pointerdown", 101, center - 90, true);
        fire("pointerdown", 102, center + 90, false);
        for (const distance of [140, 80, 40, 8, 2, 1]) {
          fire("pointermove", 101, center - distance / 2, true);
          fire("pointermove", 102, center + distance / 2, false);
        }
        // Both ups remain in this task so React cannot flush every queued move
        // before the touch controller clears the mutable live gesture.
        fire("pointerup", 101, center, true);
        fire("pointerup", 102, center, false);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      } finally {
        prototype.setPointerCapture = originalSet;
        prototype.hasPointerCapture = originalHas;
        prototype.releasePointerCapture = originalRelease;
      }
    });

    await expect(page.getByRole("button", { name: "Reset chart zoom (40%)" })).toBeVisible();
    await expect(page.locator(".startup-recovery")).toHaveCount(0);
    expect(mainFrameNavigations).toBe(navigationsAfterStartup);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors.filter((message) => !message.includes("favicon"))).toEqual([]);
  } finally {
    await context.close();
  }
});

test("keeps Retina canvas, pointer HUD and price axis in CSS-pixel alignment", async ({ browser, browserName, baseURL }) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2
  });
  const page = await context.newPage();
  try {
    const candles = mockChartCandles();
    await mockCandleHistory(page, candles);
    await installMarketSocketMock(page, "stable", candles);
    await page.goto("/");
    await expect(page.locator(".chart-legend .vol")).toBeVisible({ timeout: 20_000 });

    const canvas = page.locator(".chart-canvas-interaction");
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => Math.max(Math.abs(element.width - element.clientWidth * window.devicePixelRatio), Math.abs(element.height - element.clientHeight * window.devicePixelRatio)))).toBeLessThanOrEqual(1);
    const density = await canvas.evaluate((element: HTMLCanvasElement) => ({
      width: element.width,
      height: element.height,
      cssWidth: element.clientWidth,
      cssHeight: element.clientHeight,
      dpr: window.devicePixelRatio
    }));
    // Firefox currently ignores Playwright's deviceScaleFactor override on Linux;
    // every engine must still size its backing store from the DPR it actually reports.
    if (browserName === "chromium") expect(density.dpr).toBe(2);
    else expect(density.dpr).toBeGreaterThanOrEqual(1);
    expect(Math.abs(density.width - density.cssWidth * density.dpr)).toBeLessThanOrEqual(1);
    expect(Math.abs(density.height - density.cssHeight * density.dpr)).toBeLessThanOrEqual(1);

    const canvasBox = await canvas.boundingBox();
    expect(canvasBox).not.toBeNull();
    await page.mouse.move(canvasBox!.x + canvasBox!.width * 0.42, canvasBox!.y + canvasBox!.height * 0.45);
    const hud = page.locator(".crosshair-hud");
    await expect(hud).toBeVisible();
    const hudBox = await hud.boundingBox();
    expect(hudBox).not.toBeNull();
    expect(hudBox!.x).toBeGreaterThanOrEqual(canvasBox!.x);
    expect(hudBox!.x + hudBox!.width).toBeLessThanOrEqual(canvasBox!.x + canvasBox!.width);

    const axisBox = await page.getByRole("slider", { name: "Price axis scale" }).boundingBox();
    expect(axisBox).not.toBeNull();
    expect(axisBox!.width).toBeCloseTo(74, 0);
  } finally {
    await context.close();
  }
});

test("scales the price axis independently with wheel, drag and keyboard", async ({ page }) => {
  const candles = mockChartCandles();
  await mockCandleHistory(page, candles);
  await installMarketSocketMock(page, "stable", candles);
  await navigateToCurrentAppAndWaitForWorkspace(page);
  await expect(page.locator(".chart-legend .vol")).toBeVisible({ timeout: 20_000 });
  const axis = page.getByRole("slider", { name: "Price axis scale" });
  const timeZoom = page.getByRole("button", { name: "Reset chart zoom (100%)" });
  await expect(axis).toHaveAttribute("aria-valuenow", "100");
  const cancelled = await axis.evaluate((element) => {
    const event = new WheelEvent("wheel", { deltaY: -90, bubbles: true, cancelable: true });
    return !element.dispatchEvent(event);
  });
  expect(cancelled).toBe(true);
  await expect.poll(async () => Number(await axis.getAttribute("aria-valuenow"))).toBeGreaterThan(100);
  await expect(timeZoom).toBeVisible();
  const wheelZoom = Number(await axis.getAttribute("aria-valuenow"));

  await expect(async () => {
    const box = await axis.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 - 60, { steps: 6 });
    await page.mouse.up();
    expect(Number(await axis.getAttribute("aria-valuenow"))).toBeGreaterThan(wheelZoom);
  }).toPass({ timeout: 5_000 });
  await axis.focus();
  await page.keyboard.press("Home");
  await expect(axis).toHaveAttribute("aria-valuenow", "100");
  await page.keyboard.press("ArrowUp");
  await expect(axis).toHaveAttribute("aria-valuenow", "110");
  await axis.dblclick();
  await expect(axis).toHaveAttribute("aria-valuenow", "100");
  await expectNoAxeViolations(page);
});

test("measures price, percent, bars and time with Shift-drag", async ({ page }) => {
  await expect(page.locator(".chart-legend .vol")).toBeVisible({ timeout: 20_000 });
  const canvas = page.locator(".chart-canvas-interaction");
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.keyboard.down("Shift");
  await page.mouse.move(box!.x + 320, box!.y + 330);
  await page.mouse.down();
  await page.mouse.move(box!.x + 520, box!.y + 220, { steps: 4 });
  const summary = page.locator(".quick-measure-summary");
  await expect(summary).toContainText("Measuring");
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(summary).toContainText("Measurement result");
  await expect(summary).toContainText(/[-+]\d+\.\d+%/);
  await expect(summary).toContainText(/\d+ bars · \d+[smhd]/);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("sbv2:drawings:v2:chart-1:BTCUSDT") ?? "[]").some((drawing: { tool?: string }) => drawing.tool === "measure"))).toBe(false);
  await expectNoAxeViolations(page);
  await page.keyboard.press("Escape");
  await expect(summary).toBeHidden();
});

test("links and unlinks the visible time range across chart panes", async ({ page }) => {
  const candles = mockChartCandles();
  await mockCandleHistory(page, candles);
  await installMarketSocketMock(page, "stable", candles);
  await page.reload();
  await page.getByRole("button", { name: "Chart layout" }).click();
  await page.getByRole("menuitemradio", { name: "Vertical split" }).click();
  const primary = page.locator(".multi-chart-pane.primary");
  const secondary = page.locator(".multi-chart-pane.secondary");
  await expect(primary.locator(".chart-legend .vol")).toBeVisible({ timeout: 20_000 });
  await expect(secondary.locator(".chart-legend .vol")).toBeVisible({ timeout: 20_000 });
  const rangeLink = secondary.locator('[data-link-field="linkTimeRange"]');
  await expect(rangeLink).toHaveAttribute("aria-pressed", "true");

  await primary.locator(".chart-canvas-interaction").hover();
  await page.mouse.wheel(0, -90);
  const primaryZoom = primary.locator(".zoom-reset");
  const secondaryZoom = secondary.locator(".zoom-reset");
  await expect(primaryZoom).not.toHaveText("100%");
  await expect(secondaryZoom).not.toHaveText("100%");
  const linkedSecondaryZoom = await secondaryZoom.innerText();

  await rangeLink.click();
  await expect(rangeLink).toHaveAttribute("aria-pressed", "false");
  await primaryZoom.click();
  await expect(primaryZoom).toHaveText("100%");
  await expect(secondaryZoom).toHaveText(linkedSecondaryZoom);
  await rangeLink.click();
  await expect(secondaryZoom).not.toHaveText(linkedSecondaryZoom);
  await expectNoAxeViolations(page);
});

test("chooses an independent symbol directly in every secondary chart", async ({ page }) => {
  await page.getByRole("button", { name: "Chart layout" }).click();
  await page.getByRole("menuitemradio", { name: "Four-chart grid" }).click();
  const panes = page.locator(".multi-chart-pane");
  await expect(panes).toHaveCount(4);

  const secondSymbol = page.getByRole("combobox", { name: "Symbol · 2" });
  const thirdSymbol = page.getByRole("combobox", { name: "Symbol · 3" });
  await expect(secondSymbol).toHaveValue("BTCUSDT");
  await expect(thirdSymbol).toHaveValue("BTCUSDT");
  await secondSymbol.focus();
  await secondSymbol.selectOption("ETHUSDT");

  await expect(secondSymbol).toHaveValue("ETHUSDT");
  await expect(thirdSymbol).toHaveValue("BTCUSDT");
  await expect(page.getByRole("button", { name: /Current instrument ETHUSDT/i })).toBeVisible();
  await expect(page.locator(".stats-panel .quote-meta")).toContainText("ETHUSDT");
  const secondPane = page.locator(".multi-chart-pane.secondary").first();
  await expect(secondPane).toHaveAttribute("aria-label", /ETHUSDT/);
  await expect(secondPane.getByRole("button", { name: "Link symbol to primary chart" })).toHaveAttribute("aria-pressed", "false");

  await page.getByRole("button", { name: "More timeframes" }).click();
  await page.getByRole("menuitemradio", { name: "5m", exact: true }).click();
  await expect(secondPane.getByRole("combobox", { name: "Timeframe · 2" })).toHaveValue("5m");
  await expect(secondPane.getByRole("button", { name: "Link timeframe to primary chart" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".multi-chart-pane.primary").getByRole("img", { name: /BTCUSDT candles chart on 1m/i })).toBeVisible();

  await page.getByRole("button", { name: "Chart type", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Line", exact: true }).click();
  await expect(secondPane.getByRole("combobox", { name: "Chart type · 2" })).toHaveValue("line");
  await expect(secondPane.getByRole("img", { name: /ETHUSDT Line chart on 5m/i })).toBeVisible();
  const chartTypeLink = secondPane.locator('[data-link-field="linkChartType"]');
  await expect(chartTypeLink).toHaveAttribute("aria-pressed", "false");
  await expect(chartTypeLink).toHaveAccessibleName("Link chart type to primary chart");
  await chartTypeLink.click();
  await expect(chartTypeLink).toHaveAttribute("aria-pressed", "true");
  await expect(secondPane.getByRole("combobox", { name: "Chart type · 2" })).toHaveValue("candles");
  await expect(secondPane.getByRole("img", { name: /ETHUSDT candles chart on 5m/i })).toBeVisible();

  await selectChartSymbol(page, "SOLUSDT");
  await expect(secondSymbol).toHaveValue("SOLUSDT");
  await expect(page.locator(".stats-panel .quote-meta")).toContainText("SOLUSDT");
  await expect(page.locator(".multi-chart-pane.primary").getByRole("img", { name: /BTCUSDT candles chart on 1m/i })).toBeVisible();

  const marketSearch = page.getByRole("textbox", { name: "Search instruments" });
  await marketSearch.fill("ADAUSDT");
  await page.locator(".symbol-select").filter({ hasText: "ADAUSDT" }).click();
  await expect(secondSymbol).toHaveValue("ADAUSDT");
  await expect(page.locator(".stats-panel .quote-meta")).toContainText("ADAUSDT");
  await page.locator(".multi-chart-pane.primary").getByRole("button", { name: "Cursor (Esc)" }).click();
  await expect(page.getByRole("button", { name: /Current instrument BTCUSDT/i })).toBeVisible();
  await expect(page.locator(".stats-panel .quote-meta")).toContainText("BTCUSDT");
  await expectNoAxeViolations(page);
});

test("opens and restores four distinct markets from the keyboard layout menu", { tag: "@smoke" }, async ({ page }) => {
  await page.getByRole("button", { name: "Chart layout" }).click();
  const currentLayout = page.getByRole("menuitemradio", { name: "Single chart" });
  await expect(currentLayout).toBeFocused();
  const distinct = page.getByRole("menuitem", { name: "Four different markets" });
  await expect(distinct).toBeEnabled();
  await page.keyboard.press("End");
  await expect(distinct).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Chart layout" })).toBeFocused();

  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
  await expect(page.locator(".multi-chart-pane")).toHaveCount(4);
  await expect(page.getByRole("button", { name: /Current instrument BTCUSDT/i })).toBeVisible();
  for (let index = 1; index < symbols.length; index += 1) {
    const select = page.getByRole("combobox", { name: `Symbol · ${index + 1}` });
    await expect(select).toHaveValue(symbols[index]);
    await expect(
      page
        .locator(".multi-chart-pane.secondary")
        .nth(index - 1)
        .locator('[data-link-field="linkSymbol"]')
    ).toHaveAttribute("aria-pressed", "false");
  }
  await expect
    .poll(() =>
      page.evaluate(() => {
        const session = JSON.parse(localStorage.getItem("sbv2:last-chart-session:v1") ?? "null");
        return session?.charts?.map((chart: { symbol?: string }) => chart.symbol);
      })
    )
    .toEqual(symbols);

  await page.reload();
  await expect(page.locator(".multi-chart-pane")).toHaveCount(4);
  await expect(page.getByRole("combobox", { name: "Symbol · 2" })).toHaveValue("ETHUSDT");
  await expect(page.getByRole("combobox", { name: "Symbol · 3" })).toHaveValue("SOLUSDT");
  await expect(page.getByRole("combobox", { name: "Symbol · 4" })).toHaveValue("BNBUSDT");
  await expectNoAxeViolations(page);
});

test("keeps embedded chart analysis compact and keyboard-expandable", async ({ page }) => {
  const candles = mockChartCandles();
  await mockCandleHistory(page, candles);
  await installMarketSocketMock(page, "stable", candles);
  await page.reload();
  await page.getByRole("button", { name: "Chart layout" }).click();
  await page.getByRole("menuitemradio", { name: "Four-chart grid" }).click();

  const primary = page.locator(".multi-chart-pane.primary");
  const secondary = page.locator(".multi-chart-pane.secondary");
  await expect(primary.locator(".compact-chart")).toHaveCount(1);
  await expect(primary.locator(".chart-indicator-overlay")).toHaveCount(1);
  await expect(secondary.locator(".chart-indicator-overlay")).toHaveCount(0);
  await expect(secondary.locator(".compact-chart")).toHaveCount(3);

  const indicatorBox = await primary.locator(".chart-indicator-overlay").boundingBox();
  const compareBox = await primary.locator(".compare-control").boundingBox();
  const primaryAnalysisBox = await primary.locator(".session-liquidity-badge").boundingBox();
  expect(indicatorBox).not.toBeNull();
  expect(compareBox).not.toBeNull();
  expect(primaryAnalysisBox).not.toBeNull();
  expect(indicatorBox!.y + indicatorBox!.height).toBeLessThanOrEqual(compareBox!.y);
  expect(compareBox!.y + compareBox!.height).toBeLessThanOrEqual(primaryAnalysisBox!.y);

  const analysis = secondary.first().locator("details.session-liquidity-badge.compact");
  await expect(analysis).not.toHaveAttribute("open", "");
  const collapsedBox = await analysis.boundingBox();
  expect(collapsedBox).not.toBeNull();
  expect(collapsedBox!.height).toBeLessThanOrEqual(26);
  const summary = analysis.locator("summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(analysis).toHaveAttribute("open", "");
  await expect(analysis.getByRole("button", { name: "Toggle UTC map" })).toBeVisible();
  await expectNoAxeViolations(page);
});

test("focuses and maximizes any chart pane without resetting its view", async ({ page }) => {
  const candles = mockChartCandles();
  await mockCandleHistory(page, candles);
  await installMarketSocketMock(page, "stable", candles);
  await page.reload();
  await page.getByRole("button", { name: "Chart layout" }).click();
  await page.getByRole("menuitemradio", { name: "Four-chart grid" }).click();

  const grid = page.locator(".multi-chart-grid");
  const panes = page.locator(".multi-chart-pane");
  await expect.poll(() => page.evaluate(() => (window as Window & { __marketSocketAttempts?: number }).__marketSocketAttempts)).toBe(1);
  const primary = panes.filter({ has: page.locator(".with-indicator-controls") });
  const second = page.locator(".multi-chart-pane.secondary").first();
  const secondSymbol = second.getByRole("combobox", { name: "Symbol · 2" });
  await secondSymbol.focus();
  await secondSymbol.selectOption("ETHUSDT");
  await expect(primary).toHaveAttribute("data-active", "false");
  await expect(second).toHaveAttribute("data-active", "true");
  await expect(second).toHaveAttribute("aria-label", /Active chart/);
  await expect(second.locator(".pane-active-indicator")).toContainText("Active chart · 2");

  const third = page.locator(".multi-chart-pane.secondary").nth(1);
  await second.locator(".chart-canvas-interaction").click({ position: { x: 150, y: 220 } });
  await page.keyboard.press("Alt+J");
  await expect(third).toHaveAttribute("data-active", "true");
  await expect(third.locator(".pane-active-indicator")).toContainText("Active chart · 3");
  await expect.poll(() => third.evaluate((element) => element === document.activeElement)).toBe(true);
  await page.keyboard.press("Alt+K");
  await expect(second).toHaveAttribute("data-active", "true");
  await expect.poll(() => second.evaluate((element) => element === document.activeElement)).toBe(true);

  await second.locator(".chart-canvas-interaction").hover();
  await page.mouse.wheel(0, -90);
  const zoom = second.locator(".zoom-reset");
  await expect(zoom).not.toHaveText("100%");
  const zoomBefore = await zoom.innerText();

  const maximize = second.locator(".pane-maximize");
  await expect(maximize).toHaveAttribute("aria-pressed", "false");
  await maximize.click();
  await expect(maximize).toHaveAttribute("aria-pressed", "true");
  await expect(grid).toHaveClass(/has-maximized/);
  await expect(page.locator(".multi-chart-pane:visible")).toHaveCount(1);
  await expect(second.locator(".tool-rail")).toBeVisible();
  await expect(second.locator(".chart-indicator-overlay")).toBeVisible();
  await expect(secondSymbol).toHaveValue("ETHUSDT");
  await expect(zoom).toHaveText(zoomBefore);

  await page.keyboard.press("Escape");
  await expect(page.locator(".multi-chart-pane:visible")).toHaveCount(4);
  await expect(second.locator(".tool-rail")).toBeHidden();
  await expect(second.locator(".chart-indicator-overlay")).toHaveCount(0);
  await expect(secondSymbol).toHaveValue("ETHUSDT");
  await expect(zoom).toHaveText(zoomBefore);

  await third.getByRole("combobox", { name: "Symbol · 3" }).focus();
  await expect(third).toHaveAttribute("data-active", "true");
  await page.keyboard.press("Alt+Enter");
  await expect(page.locator(".multi-chart-pane:visible")).toHaveCount(1);
  await expect(third).toHaveClass(/maximized/);
  const fourth = page.locator(".multi-chart-pane.secondary").nth(2);
  await page.keyboard.press("Alt+J");
  await expect(fourth).toHaveClass(/maximized/);
  await expect(fourth).toHaveAttribute("data-active", "true");
  await expect(page.locator(".multi-chart-pane:visible")).toHaveCount(1);
  await expect.poll(() => fourth.evaluate((element) => element === document.activeElement)).toBe(true);
  await page.keyboard.press("Alt+Enter");
  await expect(page.locator(".multi-chart-pane:visible")).toHaveCount(4);
  await expectNoAxeViolations(page);
});

test("restores the last four-chart session after reload without a named workspace", async ({ page }) => {
  const candles = mockChartCandles();
  await mockCandleHistory(page, candles);
  await page.reload();
  await page.getByRole("button", { name: "Chart layout" }).click();
  await page.getByRole("menuitemradio", { name: "Four-chart grid" }).click();

  const second = page.locator(".multi-chart-pane.secondary").nth(0);
  const third = page.locator(".multi-chart-pane.secondary").nth(1);
  const fourth = page.locator(".multi-chart-pane.secondary").nth(2);
  await second.getByRole("combobox", { name: "Symbol · 2" }).selectOption("ETHUSDT");
  await second.getByRole("combobox", { name: "Timeframe · 2" }).selectOption("5m");
  await second.locator('[data-link-field="linkCrosshair"]').click();
  await third.getByRole("combobox", { name: "Symbol · 3" }).selectOption("SOLUSDT");
  await fourth.getByRole("combobox", { name: "Symbol · 4" }).selectOption("EURUSD");
  await second.getByLabel("Time zone").selectOption("Asia/Almaty");
  await third.getByLabel("Time zone").selectOption("America/New_York");
  await second.locator(".pane-maximize").click();
  await expect(second.locator(".chart-indicator-overlay")).toBeVisible();
  await second.getByRole("button", { name: "Remove SMA" }).click();
  await second.locator(".compare-add").click();
  const compareMenu = second.locator(".compare-menu");
  await compareMenu.getByRole("combobox").fill("SOLUSDT");
  await compareMenu.getByRole("option", { name: /SOLUSDT/ }).click();
  await expect(second.locator(".compare-chip").filter({ hasText: "SOLUSDT" })).toBeVisible();

  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("sbv2:last-chart-session:v1") ?? "null")))
    .toMatchObject({
      version: 5,
      preset: "grid-4",
      charts: [
        { id: "chart-1", symbol: "BTCUSDT" },
        { id: "chart-2", symbol: "ETHUSDT", timeframe: "5m", timeZone: "Asia/Almaty", linkTimeframe: false, linkChartType: true, linkCrosshair: false, linkIndicators: false },
        { id: "chart-3", symbol: "SOLUSDT", timeZone: "America/New_York" },
        { id: "chart-4", symbol: "EURUSD" }
      ]
    });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const session = JSON.parse(localStorage.getItem("sbv2:last-chart-session:v1") ?? "null");
        return session?.charts?.[1]?.indicatorOverrides?.find((item: { id?: string }) => item.id === "sma-20")?.enabled;
      })
    )
    .toBe(false);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const session = JSON.parse(localStorage.getItem("sbv2:last-chart-session:v1") ?? "null");
        return session?.charts?.[1]?.compareOverlays?.map((item: { symbol?: string }) => item.symbol);
      })
    )
    .toEqual(["SOLUSDT"]);

  await page.reload();
  const restoredPanes = page.locator(".multi-chart-pane");
  await expect(restoredPanes).toHaveCount(4);
  await expect(page.locator(".multi-chart-pane:visible")).toHaveCount(4);
  await expect(page.getByRole("button", { name: /Current instrument BTCUSDT/i })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Symbol · 2" })).toHaveValue("ETHUSDT");
  await expect(page.getByRole("combobox", { name: "Timeframe · 2" })).toHaveValue("5m");
  await expect(page.getByRole("combobox", { name: "Symbol · 3" })).toHaveValue("SOLUSDT");
  await expect(page.getByRole("combobox", { name: "Symbol · 4" })).toHaveValue("EURUSD");
  await expect(page.locator(".multi-chart-pane.secondary").nth(0).getByLabel("Time zone")).toHaveValue("Asia/Almaty");
  await expect(page.locator(".multi-chart-pane.secondary").nth(1).getByLabel("Time zone")).toHaveValue("America/New_York");
  const restoredSecond = page.locator(".multi-chart-pane.secondary").first();
  await expect(restoredSecond.locator('[data-link-field="linkCrosshair"]')).toHaveAttribute("aria-pressed", "false");
  const indicatorLink = restoredSecond.locator('[data-link-field="linkIndicators"]');
  const compareLink = restoredSecond.locator('[data-link-field="linkCompare"]');
  const restoredChartTypeLink = restoredSecond.locator('[data-link-field="linkChartType"]');
  await expect(indicatorLink).toHaveAttribute("aria-pressed", "false");
  await expect(compareLink).toHaveAttribute("aria-pressed", "false");
  await expect(restoredChartTypeLink).toHaveAttribute("aria-pressed", "true");
  await restoredSecond.locator(".pane-maximize").click();
  await expect(restoredSecond.locator(".indicator-chip").filter({ hasText: "SMA" })).toHaveCount(0);
  await expect(restoredSecond.locator(".compare-chip").filter({ hasText: "SOLUSDT" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".multi-chart-pane.primary .indicator-chip").filter({ hasText: "SMA" })).toBeVisible();
  await expect(page.locator(".multi-chart-pane.primary .compare-chip")).toHaveCount(0);
  await indicatorLink.click();
  await compareLink.click();
  await expect(indicatorLink).toHaveAttribute("aria-pressed", "true");
  await expect(compareLink).toHaveAttribute("aria-pressed", "true");
  await restoredSecond.locator(".pane-maximize").click();
  await expect(restoredSecond.locator(".indicator-chip").filter({ hasText: "SMA" })).toBeVisible();
  await expect(restoredSecond.locator(".compare-chip")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /Current instrument ETHUSDT/i })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("sbv2:workspaces"))).toBe("[]");
  await expectNoAxeViolations(page);
});

test("isolates and restores drawings for identical symbols in separate panes", async ({ page }) => {
  const candles = mockChartCandles();
  await mockCandleHistory(page, candles);
  await installMarketSocketMock(page, "stable", candles);
  await page.reload();
  await expect(page.locator(".chart-legend .vol")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Chart layout" }).click();
  await page.getByRole("menuitemradio", { name: "Vertical split" }).click();
  const primary = page.locator(".multi-chart-pane.primary");
  const secondary = page.locator(".multi-chart-pane.secondary");
  await expect(secondary.locator(".chart-legend .vol")).toBeVisible({ timeout: 20_000 });
  await secondary.locator(".pane-maximize").click();
  await secondary.getByRole("button", { name: "Horizontal line" }).click();
  await secondary.locator(".chart-canvas-interaction").click({ position: { x: 430, y: 260 } });
  await secondary.getByRole("button", { name: "Drawing object tree" }).click();
  await expect(secondary.getByRole("button", { name: "Horizontal line #1", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("sbv2:drawings:v2:chart-2:BTCUSDT") ?? "[]").map((drawing: { tool?: string }) => drawing.tool))).toEqual(["hline"]);
  expect(await page.evaluate(() => localStorage.getItem("sbv2:drawings:v2:chart-1:BTCUSDT"))).toBeNull();

  await page.reload();
  const restoredPrimary = page.locator(".multi-chart-pane.primary");
  const restoredSecondary = page.locator(".multi-chart-pane.secondary");
  await expect(restoredSecondary).toBeVisible({ timeout: 20_000 });
  await restoredPrimary.locator(".pane-maximize").click();
  await restoredPrimary.getByRole("button", { name: "Drawing object tree" }).click();
  await expect(restoredPrimary.locator(".drawing-object-list li")).toHaveCount(1);
  await expect(restoredPrimary.locator(".drawing-objects-empty")).toBeVisible();
  await page.keyboard.press("Escape");
  await restoredSecondary.locator(".pane-maximize").click();
  await restoredSecondary.getByRole("button", { name: "Drawing object tree" }).click();
  await expect(restoredSecondary.getByRole("button", { name: "Horizontal line #1", exact: true })).toBeVisible();
  await expectNoAxeViolations(page);
});

test("offers the complete mobile drawing catalog with 44px history controls and focus restoration", async ({ page }) => {
  test.setTimeout(60_000);
  const candles = mockChartCandles();
  await mockCandleHistory(page, candles);
  await installMarketSocketMock(page, "stable", candles);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.includes("drawings:v2")) localStorage.removeItem(key);
    }
  });
  await page.reload();
  await expect(page.locator(".chart-legend .vol")).toBeVisible({ timeout: 20_000 });

  const toolbar = page.locator(".mobile-drawing-toolbar");
  const trigger = toolbar.locator(".mobile-drawing-tools-trigger");
  const undo = toolbar.getByRole("button", { name: "Undo drawing" });
  const redo = toolbar.getByRole("button", { name: "Redo drawing" });
  const removeSelected = toolbar.getByRole("button", { name: "Delete drawing" });
  const objects = toolbar.getByRole("button", { name: "Drawing object tree" });
  await expect(toolbar).toBeVisible();
  await expect(page.locator(".tool-rail")).toBeHidden();
  for (const target of [trigger, undo, redo, removeSelected, objects]) {
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }

  await trigger.focus();
  await trigger.click();
  const toolsDialog = page.getByRole("dialog", { name: "Drawing tools" });
  const search = toolsDialog.getByPlaceholder("Search drawing tools");
  await expect(toolsDialog).toBeVisible();
  await expect(search).toBeFocused();
  await expect(toolsDialog.locator(".mobile-drawing-groups button")).toHaveCount(19);
  await expect(toolsDialog.locator(".menu-group-title")).toHaveCount(7);
  await search.fill("horizontal line");
  await expect(toolsDialog.getByRole("button", { name: "Horizontal line", exact: true })).toBeVisible();
  await expect(toolsDialog.getByText("Lines", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(toolsDialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await toolsDialog.getByPlaceholder("Search drawing tools").fill("horizontal line");
  await toolsDialog.getByRole("button", { name: "Horizontal line", exact: true }).click();
  await expect(toolsDialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText("Horizontal line");

  const canvas = page.locator(".chart-canvas-interaction");
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  await canvas.click({ position: { x: canvasBox!.width * 0.5, y: canvasBox!.height * 0.42 } });
  const storedTools = () =>
    page.evaluate(() =>
      Object.entries(localStorage)
        .filter(([key]) => key.includes("drawings:v2"))
        .flatMap(([, value]) => (JSON.parse(value) as Array<{ tool: string }>).map((drawing) => drawing.tool))
    );
  await expect.poll(storedTools).toEqual(["hline"]);
  const indicatorStripBox = await page.locator(".indicator-strip").boundingBox();
  const styleBarBox = await page.locator(".drawing-style-toolbar").boundingBox();
  expect(indicatorStripBox).not.toBeNull();
  expect(styleBarBox).not.toBeNull();
  expect(styleBarBox!.y).toBeGreaterThanOrEqual(indicatorStripBox!.y + indicatorStripBox!.height);

  await expect(undo).toBeEnabled();
  await undo.click();
  await expect.poll(storedTools).toEqual([]);
  await expect(redo).toBeEnabled();
  await redo.click();
  await expect.poll(storedTools).toEqual(["hline"]);

  await objects.click();
  const objectsDialog = page.getByRole("dialog", { name: "Drawing object tree" });
  const object = objectsDialog.getByRole("button", { name: "Horizontal line #1", exact: true });
  await expect(objectsDialog).toBeVisible();
  await expect(object).toBeVisible();
  const objectBox = await object.boundingBox();
  expect(objectBox).not.toBeNull();
  expect(objectBox!.height).toBeGreaterThanOrEqual(44);
  await object.click();
  await page.keyboard.press("Escape");
  await expect(objectsDialog).toBeHidden();
  await expect(objects).toBeFocused();
  await expect(removeSelected).toBeEnabled();
  await removeSelected.click();
  await expect.poll(storedTools).toEqual([]);

  await trigger.click();
  await expect(toolsDialog).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(toolsDialog).toBeHidden();
});

test("keeps the chart context menu keyboard-operable", async ({ page }) => {
  const canvas = page.locator(".chart-canvas-interaction");
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  const drawingTool = page.getByRole("button", { name: "Trend line", exact: true });
  await drawingTool.click();
  await expect(drawingTool).toHaveAttribute("aria-pressed", "true");
  const returnTarget = page.getByRole("button", { name: "Chart layout" });
  await returnTarget.focus();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await canvas.click({ button: "right", position: { x: box!.width * 0.48, y: box!.height * 0.46 } });

  const menu = page.getByRole("menu");
  const items = menu.getByRole("menuitem");
  await expect(menu).toBeVisible();
  expect(await items.count()).toBeGreaterThan(1);
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(drawingTool).toHaveAttribute("aria-pressed", "true");

  await canvas.click({ button: "right", position: { x: box!.width * 0.48, y: box!.height * 0.46 } });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(menu).toBeHidden();
});

test("creates, exposes and persists an anchored VWAP drawing", async ({ page }) => {
  await installMarketSocketMock(page, "stable", mockChartCandles());
  await page.reload();
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
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("sbv2:drawings:v2:chart-1:EURUSD") ?? "[]").some((drawing: { tool?: string }) => drawing.tool === "anchored-vwap"))).toBe(true);
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
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("sbv2:microstructure-alerts:v1") ?? "null")?.largePrintNotional)).toBe(100);
  await page.evaluate(() => {
    const target = window as Window & { __emitTradeFlow?: (trades: Array<{ id: string; price: number; size: number; side: "buy" | "sell"; exchangeTs: number }>) => void };
    target.__emitTradeFlow?.([{ id: "large-after-threshold", price: 100, size: 2, side: "buy", exchangeTs: Date.now() }]);
  });
  const dismissAlert = alertCenter.getByRole("button", { name: "Dismiss microstructure alert" }).first();
  await expect(dismissAlert).toBeVisible({ timeout: 10_000 });
  await dismissAlert.click();
  await expectNoAxeViolations(page);
  await toggle.click();
  await expect(badge).toBeHidden();
});

test("passes automated WCAG A/AA audits on chart, strategy and trading surfaces", { tag: "@smoke" }, async ({ page }) => {
  await expect(page.getByRole("img", { name: /BTCUSDT candles chart on 1m/i })).toBeVisible({ timeout: 20_000 });
  await expectNoAxeViolations(page);
  await openStrategyWorkspace(page);
  await expect(page.locator(".strategy-lab")).toBeVisible({ timeout: 20_000 });
  await expectNoAxeViolations(page);
  await openRobotsWorkspace(page);
  await expect(page.getByRole("heading", { name: "Trading is locked" })).toBeVisible();
  await expectNoAxeViolations(page);
});

test("honours reduced motion and remains operable at 200 percent text size", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const transition = await page.getByRole("button", { name: "Toggle markets panel" }).evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(Number.parseFloat(transition)).toBeLessThanOrEqual(0.00001);
  await page.locator("html").evaluate((element) => {
    element.style.fontSize = "200%";
  });
  await expect(page.getByRole("navigation", { name: "Primary workspaces" })).toBeVisible();
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
  await expect(page.getByRole("button", { name: "Open command palette" })).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();

  const search = palette.getByPlaceholder("Search symbols, timeframes, chart types, actions...");
  await expect(search).toBeFocused();
  await search.fill("EURUSD");
  await expect(palette.getByRole("option").filter({ hasText: "EURUSD" }).first()).toBeVisible({ timeout: 20_000 });
  await search.press("Enter");

  await expect(page.getByRole("button", { name: /Current instrument EURUSD/i })).toBeVisible();
  await expect(page.getByRole("img", { name: /EURUSD candles chart on 1m/i })).toBeVisible();
});

test("opens the lazy Strategy workspace without losing the shell", async ({ page }) => {
  const workspaceModes = page.getByRole("navigation", { name: "Primary workspaces" });
  await openStrategyWorkspace(page);

  await expect(page.locator(".strategy-lab")).toBeVisible({ timeout: 20_000 });
  await expect(workspaceModes.getByRole("button", { name: "Monitoring", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(workspaceModes.getByRole("button", { name: "Strategies", exact: true })).toHaveAttribute("aria-pressed", "true");
  const stages = page.getByRole("navigation", { name: "Studio stages" });
  await expect(stages.getByRole("button", { name: "Build", exact: true })).toHaveAttribute("aria-pressed", "true");
  await stages.getByRole("button", { name: "Learn", exact: true }).click();
  await expect(page.getByText("Select a block in the workspace to inspect its contract, example and pitfalls.")).toBeVisible();
});

test("creates an ordinary editable strategy with the guided wizard", async ({ page }) => {
  await openStrategyWorkspace(page);
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

test("imports a Pine indicator as an editable artifact", { tag: "@smoke" }, async ({ page }) => {
  await openStrategyWorkspace(page);
  await expect(page.locator(".strategy-lab")).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Pine", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import Pine Script" });
  await expect(dialog).toBeVisible();
  await dialog.locator("textarea").fill(["//@version=6", 'indicator("E2E SMA", overlay=true)', 'plot(ta.sma(close, 3), "SMA")'].join("\n"));
  await dialog.getByRole("button", { name: "Convert", exact: true }).click();

  await expect(dialog.getByText(/indicator · “E2E SMA”/i)).toBeVisible();
  await dialog.getByRole("button", { name: "Add 1 artifact", exact: true }).click();

  await expect(dialog).toBeHidden();
  await expect(page.locator(".strategy-library")).toContainText("E2E SMA");
});

test("reviews an OS-launched Pine file before conversion and import", async ({ page }) => {
  await installPwaLaunchQueue(page);
  await dispatchPwaFile(page, {
    name: "os-launch.pine",
    type: "text/plain",
    content: ["//@version=6", 'indicator("OS Launch EMA", overlay=true)', 'plot(ta.ema(close, 9), "EMA")'].join("\n")
  });

  const launchReview = page.getByRole("dialog", { name: "Review files opened by the operating system" });
  await expect(launchReview).toBeVisible({ timeout: 20_000 });
  await expect(launchReview).toContainText("Contents have not been read yet");
  await expect(page.locator(".strategy-lab")).toHaveCount(0);
  await expectNoAxeViolations(page);
  await launchReview.getByRole("button", { name: "Review files locally" }).click();

  const pineReview = page.getByRole("dialog", { name: "Import Pine Script" });
  await expect(pineReview).toContainText("os-launch");
  await expect(page.locator(".strategy-library")).not.toContainText("OS Launch EMA");
  await pineReview.getByRole("button", { name: /^Convert/ }).click();
  await expect(pineReview.getByText(/indicator · “OS Launch EMA”/i)).toBeVisible();
  await pineReview.getByRole("button", { name: "Add 1 artifact", exact: true }).click();

  await expect(pineReview).toBeHidden();
  await expect(page.locator(".strategy-library")).toContainText("OS Launch EMA");
});

test("receives shared research files through the installed PWA without automatic import", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Web Share Target is exercised through the production service worker in Chromium.");
  test.setTimeout(90_000);
  const destination = await shareResearchFiles(page, [
    {
      name: "share-target.pine",
      type: "text/plain",
      content: ["//@version=6", 'indicator("Shared RSI", overlay=false)', 'plot(ta.rsi(close, 14), "RSI")'].join("\n")
    },
    { name: "orders.json", type: "application/json", content: "{}" },
    { name: "oversized.pine", type: "text/plain", bytes: 1_000_001 }
  ]);
  const token = new URL(destination).searchParams.get("share");
  expect(token).toMatch(/^[0-9a-f-]{36}$/);

  await page.goto(destination);

  const review = page.getByRole("dialog", { name: "Review files shared with SaltanatbotV2" });
  await expect(review).toBeVisible({ timeout: 20_000 });
  await expect(review).toContainText("share-target.pine");
  await expect(review).toContainText("orders.json");
  await expect(review).toContainText("Unsupported file extension");
  await expect(review).toContainText("oversized.pine");
  await expect(review).toContainText("File exceeds its bounded safety limit");
  await expect(review).toContainText("temporarily on this device");
  await expect(page.getByRole("navigation", { name: "Primary workspaces" }).getByRole("button", { name: "Monitoring", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".strategy-lab")).toHaveCount(0);
  await expectNoAxeViolations(page);

  await review.getByRole("button", { name: "Review files locally" }).click();

  const pineReview = page.getByRole("dialog", { name: "Import Pine Script" });
  await expect(pineReview).toContainText("share-target", { timeout: 20_000 });
  await expect(page.locator(".strategy-library")).not.toContainText("Shared RSI");
  await expect.poll(() => new URL(page.url()).searchParams.has("share")).toBe(false);
  await expect.poll(() => hasPendingSharedFiles(page, token!)).toBe(false);
  await pineReview.getByRole("button", { name: /^Convert/ }).click();
  await expect(pineReview.getByText(/indicator · “Shared RSI”/i)).toBeVisible();
  await pineReview.getByRole("button", { name: "Add 1 artifact", exact: true }).click();

  await expect(pineReview).toBeHidden();
  await expect(page.locator(".strategy-library")).toContainText("Shared RSI");
});

test("checksum-reviews an OS-launched strategy before adding it", async ({ page }) => {
  const artifact: StrategyArtifact = {
    id: "strategy:os-launch",
    kind: "strategy",
    name: "OS Launch Strategy",
    description: "PWA file-handler fixture",
    xml: pluginXml("OS Launch Strategy"),
    semanticVersion: "1.2.0",
    schemaVersion: 2,
    parameters: [],
    dependencies: [],
    provenance: { source: "local" },
    createdAt: 1,
    updatedAt: 1
  };
  const content = await encodeStrategyFile(artifact, 10);
  await installPwaLaunchQueue(page);
  await dispatchPwaFile(page, { name: "review-me.strategy", type: "application/json", content });

  const launchReview = page.getByRole("dialog", { name: "Review files opened by the operating system" });
  await expect(launchReview).toContainText("review-me.strategy", { timeout: 20_000 });
  await launchReview.getByRole("button", { name: "Review files locally" }).click();
  const strategyReview = page.getByRole("dialog", { name: "Review strategy file" });
  await expect(strategyReview).toContainText("OS Launch Strategy");
  await expect(strategyReview).toContainText("Checksum, schema and resource limits verified locally");
  await expect(page.locator(".strategy-library .library-item-main").filter({ hasText: "OS Launch Strategy" })).toHaveCount(0);
  await expectNoAxeViolations(page);
  await strategyReview.getByRole("button", { name: "Import reviewed strategy" }).click();

  await expect(strategyReview).toBeHidden();
  await expect(page.locator(".strategy-library .library-item-main").filter({ hasText: "OS Launch Strategy" })).toHaveCount(1);
});

test("reviews a checksummed declarative plugin before importing it", async ({ page }) => {
  test.setTimeout(60_000);
  await installPwaLaunchQueue(page);
  await openStrategyWorkspace(page);
  const library = page.locator(".strategy-library");
  await expect(library).toBeVisible({ timeout: 20_000 });
  await expect(library).toContainText("A checksum proves integrity, not publisher trust");

  const plugin: PluginManifest = {
    id: "e2e.research-pack",
    name: "E2E research pack",
    version: "1.0.0",
    description: "Browser import fixture.",
    license: "MIT",
    publisher: { name: "E2E publisher", url: "https://example.com" },
    minAppVersion: "0.1.0",
    permissions: ["market.read", "chart.overlay", "trade.intent"],
    artifacts: [
      { id: "overlay", kind: "indicator", name: "E2E plugin overlay", description: "Editable overlay", xml: pluginXml("E2E plugin overlay"), schemaVersion: 2, semanticVersion: "1.0.0", parameters: [], dependencies: [] },
      { id: "strategy", kind: "strategy", name: "E2E plugin strategy", description: "Editable strategy", xml: pluginXml("E2E plugin strategy"), schemaVersion: 2, semanticVersion: "1.0.0", parameters: [], dependencies: ["overlay"] }
    ]
  };
  const signer = await createPluginSigningKeyPair();
  const signedPlugin = await encodeSignedPluginFile(plugin, signer);
  await dispatchPwaFile(page, { name: "e2e.saltanat-plugin", type: "application/json", content: signedPlugin });
  const launchReview = page.getByRole("dialog", { name: "Review files opened by the operating system" });
  await expect(launchReview).toContainText("e2e.saltanat-plugin");
  await launchReview.getByRole("button", { name: "Review files locally" }).click();

  const review = page.getByRole("dialog", { name: "Review plugin package" });
  await expect(review).toBeVisible();
  await expect(review).toContainText("E2E publisher");
  await expect(review).toContainText("market.read");
  await expect(review).toContainText("E2E plugin strategy");
  await expect(review).toContainText("Valid signature · key not trusted");
  await expect(review.getByText(signer.keyFingerprint, { exact: true })).toBeVisible();
  await expect(review.locator(".plugin-checksum code")).toHaveText(/^[a-f0-9]{64}$/);
  await expect(library.locator(".library-item-main").filter({ hasText: "E2E plugin overlay" })).toHaveCount(0);
  await expectNoAxeViolations(page);

  await page.keyboard.press("Escape");
  await expect(review).toBeHidden();
  await expect(library.locator(".library-item-main").filter({ hasText: "E2E plugin overlay" })).toHaveCount(0);

  await page.getByLabel("Import plugin package").setInputFiles({
    name: "e2e.saltanat-plugin",
    mimeType: "application/json",
    buffer: Buffer.from(signedPlugin)
  });
  const confirmedReview = page.getByRole("dialog", { name: "Review plugin package" });
  await confirmedReview.getByLabel("Trust this fingerprint for the named publisher after import").check();
  await confirmedReview.getByRole("button", { name: "Import reviewed plugin" }).click();

  await expect(library.getByRole("status")).toContainText("Plugin imported: E2E research pack · 2 artifacts");
  await expect(library).toContainText("E2E plugin overlay");
  await expect(library).toContainText("E2E plugin strategy");
  await expectNoAxeViolations(page);

  await page.evaluate(() => {
    const key = "marketforge.strategyLibrary.v1";
    const artifacts = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{ id: string; provenance?: { source?: string }; dependencies?: string[] }>;
    const pluginArtifact = artifacts.find((artifact) => artifact.provenance?.source === "plugin");
    const localArtifact = artifacts.find((artifact) => artifact.id === "strategy:price-cross-ema");
    if (pluginArtifact && localArtifact) localArtifact.dependencies = [pluginArtifact.id];
    localStorage.setItem(key, JSON.stringify(artifacts));
  });

  await navigateToCurrentAppAndWaitForWorkspace(page);
  await openStrategyWorkspace(page);
  const restoredLibrary = page.locator(".strategy-library");
  await expect(restoredLibrary).toContainText("E2E plugin overlay", { timeout: 20_000 });
  await expect(restoredLibrary).toContainText("E2E plugin strategy");

  const authenticatedSigner = await rotatePluginSigningKeyPair(signer);
  const authenticatedUpdate = await encodeSignedPluginFile({ ...plugin, version: "1.1.0" }, authenticatedSigner);
  await page.getByLabel("Import plugin package").setInputFiles({
    name: "e2e-authenticated-update.saltanat-plugin",
    mimeType: "application/json",
    buffer: Buffer.from(authenticatedUpdate)
  });
  const authenticatedReview = page.getByRole("dialog", { name: "Review plugin package" });
  await expect(authenticatedReview).toContainText("Newer package version detected");
  await expect(authenticatedReview).toContainText("Authenticated key rotation · old and new keys both signed the transition chain.");
  await expect(authenticatedReview.getByLabel("I verified this signer transition independently and accept the new package identity.")).toHaveCount(0);
  await expect(authenticatedReview.getByRole("button", { name: "Import reviewed plugin" })).toBeEnabled();
  await expectNoAxeViolations(page);
  await page.keyboard.press("Escape");
  await expect(authenticatedReview).toBeHidden();

  const replacementSigner = await createPluginSigningKeyPair();
  const riskyReplacement = await encodeSignedPluginFile({ ...plugin, version: "0.9.0" }, replacementSigner);
  await page.getByLabel("Import plugin package").setInputFiles({
    name: "e2e-risky-replacement.saltanat-plugin",
    mimeType: "application/json",
    buffer: Buffer.from(riskyReplacement)
  });
  const riskyReview = page.getByRole("dialog", { name: "Review plugin package" });
  const confirmRiskyImport = riskyReview.getByRole("button", { name: "Import reviewed plugin" });
  await expect(riskyReview).toContainText("Older package version detected");
  await expect(riskyReview).toContainText("Signer fingerprint changed. No authenticated key rotation proves continuity.");
  await expect(riskyReview).toContainText("v1.0.0 → v0.9.0");
  await expect(confirmRiskyImport).toBeDisabled();
  await riskyReview.getByLabel("I understand this is not a normal newer-version upgrade and want a separate local installation.").check();
  await expect(confirmRiskyImport).toBeDisabled();
  await riskyReview.getByLabel("I verified this signer transition independently and accept the new package identity.").check();
  await expect(confirmRiskyImport).toBeEnabled();
  await expectNoAxeViolations(page);
  await page.keyboard.press("Escape");
  await expect(riskyReview).toBeHidden();
  await expect(restoredLibrary.getByRole("button", { name: /Installed plugins 1/ })).toBeVisible();

  await restoredLibrary.getByRole("button", { name: /Installed plugins 1/ }).click();
  const catalog = page.getByRole("dialog", { name: "Installed plugins" });
  await expect(catalog).toContainText("E2E research pack");
  await expect(catalog).toContainText("E2E publisher");
  await expect(catalog).toContainText("MIT");
  await expect(catalog).toContainText("trade.intent");
  await expect(catalog).toContainText("Signature verified · signer trusted now");
  await expect(catalog).toContainText("trusted at import");
  await expect(catalog.getByText(signer.keyFingerprint, { exact: true })).toBeVisible();
  await expect(catalog.locator(".plugin-catalog-checksum code")).toHaveText(/^[a-f0-9]{64}$/);
  await catalog.getByRole("button", { name: "Forget signer trust", exact: true }).click();
  await expect(catalog).toContainText("Signature verified · signer not trusted");
  await catalog.getByRole("button", { name: "Trust signer key", exact: true }).click();
  await expect(catalog).toContainText("Signature verified · signer trusted now");
  await expectNoAxeViolations(page);

  await catalog.getByRole("button", { name: "Block signer key", exact: true }).click();
  await expect(catalog).toContainText("Signer key blocked locally");
  await catalog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByLabel("Import plugin package").setInputFiles({
    name: "e2e-blocked.saltanat-plugin",
    mimeType: "application/json",
    buffer: Buffer.from(signedPlugin)
  });
  const blockedReview = page.getByRole("dialog", { name: "Review plugin package" });
  const blockedImport = blockedReview.getByRole("button", { name: "Import reviewed plugin" });
  await expect(blockedReview).toContainText("Signer key blocked locally");
  await expect(blockedReview).toContainText(signer.keyFingerprint);
  await expect(blockedImport).toBeDisabled();
  await blockedReview.getByLabel("I understand this is not a normal newer-version upgrade and want a separate local installation.").check();
  await expect(blockedImport).toBeDisabled();
  await expectNoAxeViolations(page);
  await blockedReview.getByRole("button", { name: `Unblock signer key: ${signer.keyFingerprint}` }).click();
  await expect(blockedReview).toContainText("Valid signature · key not trusted");
  await expect(blockedImport).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(blockedReview).toBeHidden();
  await restoredLibrary.getByRole("button", { name: /Installed plugins 1/ }).click();
  const restoredCatalog = page.getByRole("dialog", { name: "Installed plugins" });
  await expect(restoredCatalog).toContainText("Signature verified · signer not trusted");
  await restoredCatalog.getByRole("button", { name: "Trust signer key", exact: true }).click();
  await expect(restoredCatalog).toContainText("Signature verified · signer trusted now");

  await restoredCatalog.getByRole("button", { name: /Uninstall: E2E research pack/ }).click();
  const removal = page.getByRole("dialog", { name: "Uninstall plugin" });
  await expect(removal).toContainText("Running paper/live bots and chart overlays are not stopped");
  await expect(removal).toContainText("Price Cross EMA");
  await expect(removal.getByRole("button", { name: "Remove plugin", exact: true })).toBeDisabled();
  await expectNoAxeViolations(page);
  await removal.getByRole("button", { name: "Back to catalog", exact: true }).click();
  await page.getByRole("dialog", { name: "Installed plugins" }).getByRole("button", { name: "Close", exact: true }).click();

  await page.evaluate(() => {
    const key = "marketforge.strategyLibrary.v1";
    const artifacts = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<{ id: string; dependencies?: string[] }>;
    const localArtifact = artifacts.find((artifact) => artifact.id === "strategy:price-cross-ema");
    if (localArtifact) localArtifact.dependencies = [];
    localStorage.setItem(key, JSON.stringify(artifacts));
  });
  await navigateToCurrentAppAndWaitForWorkspace(page);
  await openStrategyWorkspace(page);
  await page
    .locator(".strategy-library")
    .getByRole("button", { name: /Installed plugins 1/ })
    .click();
  await page
    .getByRole("dialog", { name: "Installed plugins" })
    .getByRole("button", { name: /Uninstall: E2E research pack/ })
    .click();
  const allowedRemoval = page.getByRole("dialog", { name: "Uninstall plugin" });
  await expect(allowedRemoval.getByRole("button", { name: "Remove plugin", exact: true })).toBeEnabled();
  await allowedRemoval.getByRole("button", { name: "Remove plugin", exact: true }).click();
  await expect(page.getByText("No installed plugins", { exact: true })).toBeVisible();
  await page.getByRole("dialog", { name: "Installed plugins" }).getByRole("button", { name: "Close", exact: true }).click();
  await expect(restoredLibrary.getByRole("status")).toContainText("Plugin removed from the local library");
  await expect(restoredLibrary).not.toContainText("E2E plugin overlay");

  await navigateToCurrentAppAndWaitForWorkspace(page);
  await openStrategyWorkspace(page);
  await expect(page.locator(".strategy-library")).not.toContainText("E2E plugin overlay", { timeout: 20_000 });
});

test("exports selected local artifacts as a verified plugin package", { tag: "@smoke" }, async ({ page }) => {
  await openStrategyWorkspace(page);
  const library = page.locator(".strategy-library");
  await expect(library).toBeVisible({ timeout: 20_000 });
  await library.getByRole("button", { name: "Build plugin", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Export plugin package" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Package will contain", { exact: false })).toBeVisible();
  await dialog.getByLabel("Local signing identity name").fill("E2E local signer");
  await dialog.getByRole("button", { name: "Create signing identity", exact: true }).click();
  await expect(dialog.getByLabel("Sign this package with the local identity")).toBeChecked();
  await expect(dialog.locator(".plugin-signing-identity code")).toHaveText(/^[a-f0-9]{64}$/);
  const originalFingerprint = await dialog.locator(".plugin-signing-identity code").innerText();
  await expect(dialog).toContainText("Authenticated key rotations: 0/8");
  await dialog.getByRole("button", { name: "Rotate signing key", exact: true }).click();
  const confirmRotation = dialog.getByRole("button", { name: "Rotate key now", exact: true });
  await expect(confirmRotation).toBeDisabled();
  await dialog.getByLabel("I understand the old private key cannot be recovered after this rotation.").check();
  await expect(confirmRotation).toBeEnabled();
  await confirmRotation.click();
  await expect(dialog).toContainText("Authenticated key rotations: 1/8");
  await expect(dialog.locator(".plugin-signing-identity code")).not.toHaveText(originalFingerprint);
  await expectNoAxeViolations(page);

  await dialog.getByLabel("Package name").fill("E2E local pack");
  await dialog.getByLabel("Plugin ID").fill("e2e.local-pack");
  const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Download plugin", exact: true }).click()]);
  expect(download.suggestedFilename()).toBe("e2e-local-pack.saltanat-plugin");
  const path = await download.path();
  expect(path).toBeTruthy();
  const parsed = await parsePluginFile(await readFile(path!, "utf8"), { appVersion: "0.1.0", maxArtifactSchemaVersion: 2 });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.manifest).toMatchObject({ id: "e2e.local-pack", name: "E2E local pack", minAppVersion: "0.1.0" });
  expect(parsed.manifest.artifacts.length).toBeGreaterThan(0);
  expect(parsed.manifest.permissions).toContain("market.read");
  expect(parsed.signature?.scheme).toBe("ECDSA-P256-SHA256");
  expect(parsed.signature?.keyFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(parsed.signature?.keyTransitions).toHaveLength(1);
  expect(parsed.signature?.keyTransitions?.[0]).toMatchObject({ sequence: 1, previousKeyFingerprint: originalFingerprint, nextKeyFingerprint: parsed.signature?.keyFingerprint });
  await expect(library.getByRole("status")).toContainText("Plugin exported: E2E local pack");

  await library.getByRole("button", { name: "Build plugin", exact: true }).click();
  const restoredIdentity = page.getByRole("dialog", { name: "Export plugin package" });
  await expect(restoredIdentity.locator(".plugin-signing-identity code")).toHaveText(parsed.signature!.keyFingerprint);
  await expect(restoredIdentity).toContainText("Authenticated key rotations: 1/8");
  await restoredIdentity.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("switches and persists the interface locale", { tag: "@smoke" }, async ({ page }) => {
  await expect(page.locator(".locale-toggle")).toHaveText("EN");
  await page.getByRole("button", { name: "Switch interface language to Russian" }).click();

  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page).toHaveTitle("Мониторинг · SaltanatbotV2");
  const workspaceModes = page.locator(".workspace-navigation");
  await expect(workspaceModes.getByRole("button", { name: "Мониторинг", exact: true })).toBeVisible();
  await expect(workspaceModes.getByRole("button", { name: "Автоматизация", exact: true })).toBeVisible();
  await expect(workspaceModes.getByRole("button", { name: "Стратегии", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Переключить язык интерфейса на казахский" })).toBeVisible();
  await expect(page.locator(".locale-toggle")).toHaveText("RU");
  await expect(page.getByRole("button", { name: "Данные графика", exact: true })).toBeVisible();
  await expect(page.getByText("Рынки", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Статистика свечи")).toBeVisible();
  await expect(page.getByRole("button", { name: "Линия тренда", exact: true })).toBeVisible();
  await expect(page.locator(".indicator-add")).toHaveText("Добавить");
  await expect(page.getByRole("button", { name: "Сохранённые рабочие пространства" })).toBeVisible();
  await expect(page.locator(".compare-add")).toContainText("Сравнить");
  await page.keyboard.press("Control+k");
  const localizedPalette = page.getByRole("dialog", { name: "Палитра команд" });
  await expect(localizedPalette.getByPlaceholder("Поиск символов, интервалов, типов графика и действий…")).toBeFocused();
  await page.keyboard.press("Escape");

  await openStrategyWorkspace(page, { automation: "Автоматизация", strategies: "Стратегии" });
  await expect(workspaceModes.getByRole("button", { name: "Стратегии", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveTitle("Автоматизация · Стратегии · SaltanatbotV2");
  await page.getByRole("navigation", { name: "Этапы Студии" }).getByRole("button", { name: "Бэктест", exact: true }).click();
  await expect(page.getByRole("button", { name: "Запустить бэктест", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Галерея", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pine", exact: true }).click();
  const pineDialog = page.getByRole("dialog", { name: "Импорт Pine Script" });
  await expect(pineDialog.getByRole("button", { name: "Преобразовать", exact: true })).toBeDisabled();
  await pineDialog.getByRole("button", { name: "Закрыть", exact: true }).click();

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  await expect(workspaceModes.getByRole("button", { name: "Мониторинг", exact: true })).toBeVisible();
  await openRobotsWorkspace(page, { automation: "Автоматизация", robots: "Роботы" });
  await expect(page.getByRole("heading", { name: "Торговля заблокирована" })).toBeVisible();
  await page.getByRole("button", { name: "Переключить язык интерфейса на казахский" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "kk");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page).toHaveTitle("Автоматтандыру · Роботтар · SaltanatbotV2");
  await expect(page.getByRole("heading", { name: "Сауда жабық" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Интерфейс тілін ағылшын тіліне ауыстыру" })).toBeVisible();
  await expect(page.locator(".locale-toggle")).toHaveText("KK");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("sbv2:locale"))).toBe("kk");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "kk");
  await expect(page).toHaveTitle("Автоматтандыру · Роботтар · SaltanatbotV2");
  await expect(workspaceModes.getByRole("button", { name: "Роботтар", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Access token").fill("e2e-local-admin-token");
  await page.getByRole("button", { name: "Құлыпты ашу", exact: true }).click();
  await page.getByRole("button", { name: "Параметрлер", exact: true }).click();
  const paperNotice = page.locator(".runtime-paper-notice");
  await expect(paperNotice).toContainText("Research / Paper");
  await expect(paperNotice).toContainText("Тек зерттеу және симуляция қолжетімді.");
  await expect(page.getByRole("region", { name: "Сауда аккаунттарының тізілімі" })).toHaveCount(0);
  await expect(page.getByLabel("Бот token-і")).toBeVisible();
});

test("saves and restores a named chart workspace", async ({ page }) => {
  await selectChartSymbol(page, "EURUSD");

  await page.getByRole("button", { name: "Saved workspaces" }).click();
  await page.getByRole("textbox", { name: "Workspace name" }).fill("EUR research");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator(".workspace-apply").filter({ hasText: "EUR research" })).toContainText("EURUSD");

  await page.reload();
  await page.getByRole("button", { name: "Saved workspaces" }).click();
  await expect(page.locator(".workspace-apply").filter({ hasText: "EUR research" })).toContainText("EURUSD");
});

test("archives, restores and permanently removes a workspace with confirmation", async ({ page }) => {
  await page.getByRole("button", { name: "Saved workspaces" }).click();
  const menu = page.getByRole("region", { name: "Saved workspaces" });
  await menu.getByRole("textbox", { name: "Workspace name" }).fill("Lifecycle workspace");
  await menu.getByRole("button", { name: "Create", exact: true }).click();
  await expect(menu.locator(".workspace-apply").filter({ hasText: "Lifecycle workspace" })).toBeVisible();

  await menu.getByRole("button", { name: "Archive workspace Lifecycle workspace" }).click();
  await expect(menu.locator(".workspace-apply").filter({ hasText: "Lifecycle workspace" })).toHaveCount(0);
  await menu.getByRole("button", { name: /Archived/ }).click();
  await expect(menu.locator(".workspace-apply").filter({ hasText: "Lifecycle workspace" })).toBeDisabled();

  await menu.getByRole("button", { name: "Restore workspace Lifecycle workspace" }).click();
  await menu.getByRole("button", { name: /Active/ }).click();
  await expect(menu.locator(".workspace-apply").filter({ hasText: "Lifecycle workspace" })).toBeEnabled();

  await menu.getByRole("button", { name: "Archive workspace Lifecycle workspace" }).click();
  await menu.getByRole("button", { name: /Archived/ }).click();
  await menu.getByRole("button", { name: "Delete permanently Lifecycle workspace" }).click();
  const confirmation = menu.getByRole("group", { name: /Permanently delete this archived workspace/ });
  await expect(confirmation).toBeVisible();
  await expectNoAxeViolations(page);
  await confirmation.getByRole("button", { name: "Delete permanently", exact: true }).click();

  await expect(menu.locator(".workspace-apply").filter({ hasText: "Lifecycle workspace" })).toHaveCount(0);
  await expect(menu).toContainText("No saved workspaces yet.");
});

test("keeps the workspace menu inside a 320px viewport with touch-sized controls", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.reload();
  await page.getByRole("button", { name: "More tools" }).click();
  await page.getByRole("button", { name: "Saved workspaces" }).click();
  const menu = page.getByRole("region", { name: "Saved workspaces" });
  await menu.getByRole("textbox", { name: "Workspace name" }).fill("Mobile workspace");
  await menu.getByRole("button", { name: "Create", exact: true }).click();

  const geometry = await menu.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const controls = Array.from(element.querySelectorAll<HTMLElement>("button, input"))
      .filter((control) => !control.classList.contains("sr-only") && control.getClientRects().length > 0);
    return {
      left: bounds.left,
      right: bounds.right,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      shortestControl: Math.min(...controls.map((control) => control.getBoundingClientRect().height))
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.shortestControl).toBeGreaterThanOrEqual(43);
  await expectNoAxeViolations(page);
});

test("runs a backtest and exposes assumptions and metrics", { tag: "@smoke" }, async ({ page }) => {
  await openStrategyWorkspace(page);
  await expect(page.locator(".strategy-lab")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("navigation", { name: "Studio stages" }).getByRole("button", { name: "Backtest", exact: true }).click();
  await page
    .locator(".config-row label")
    .filter({ hasText: /^Market/ })
    .locator("select")
    .selectOption("EURUSD");
  await page.getByRole("button", { name: "Run backtest" }).click();

  const report = page.locator(".backtest-report");
  await expect(report).toBeVisible({ timeout: 30_000 });
  await expect(report).toContainText("Net profit");
  await expect(report).toContainText(/next-open fills/i);
  await expect(report).toContainText(/Data fallback/i);
  await expect(report.getByRole("alert").filter({ hasText: /Performance claims are not valid/i })).toBeVisible();
  await expect(report).toContainText("Trades");
});

test("runs several markets through one portfolio capital pool", async ({ page }) => {
  await mockCandleHistory(page, mockChartCandles());
  await openStrategyWorkspace(page);
  await expect(page.locator(".strategy-lab")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("navigation", { name: "Studio stages" }).getByRole("button", { name: "Backtest", exact: true }).click();

  await page.getByLabel("Portfolio mode").check();
  await page.getByLabel("Add market").selectOption("ETHUSDT");
  await expect(page.locator(".portfolio-market-chip")).toContainText(["BTCUSDT", "ETHUSDT"]);
  await page.getByLabel("Max concurrent positions").fill("2");
  await page.getByLabel("Max gross exposure %").fill("100");
  expect(
    await page
      .locator(".strategy-backtest-form")
      .evaluate((form) => [...(form as HTMLFormElement).elements].filter((element) => !(element as HTMLInputElement).checkValidity()).map((element) => ({ name: (element as HTMLInputElement).name, value: (element as HTMLInputElement).value, message: (element as HTMLInputElement).validationMessage })))
  ).toEqual([]);
  await page.getByRole("button", { name: "Run backtest" }).click();

  const report = page.locator(".portfolio-report");
  await expect(report.getByRole("heading", { name: "Portfolio backtest" })).toBeVisible({ timeout: 30_000 });
  await expect(report).toContainText("BTCUSDT");
  await expect(report).toContainText("ETHUSDT");
  await expect(report.getByRole("table", { name: "Contribution by market" })).toBeVisible();
  await expect(report.getByRole("table", { name: /Return correlation/ })).toBeVisible();
  await expect(report.getByRole("heading", { name: "Execution quality analysis" })).toBeVisible();
  await expect(report.getByRole("table", { name: "Execution costs by market" })).toBeVisible();
  await expect(report).toContainText("All-in cost");
  await expect(report.getByRole("heading", { name: "Portfolio risk lab" })).toBeVisible();
  await expect(report.getByRole("table", { name: "Moving-block bootstrap" })).toBeVisible();
  await expect(report.getByRole("table", { name: "Portfolio stress scenarios" })).toBeVisible();
  await expect(report).toContainText("VaR 95%");
  await expect(report).toContainText("Break-even extra cost per fill");
  await expect(report.getByRole("note")).toContainText(/first generates single-market candidate fills/i);
  await expectNoAxeViolations(page);
});

test("keeps trading locked for a bad token and opens an authenticated session", { tag: "@smoke" }, async ({ page }) => {
  await openRobotsWorkspace(page);
  await expect(page.getByRole("heading", { name: "Trading is locked" })).toBeVisible();

  const token = page.getByLabel("Access token");
  await token.fill("invalid-token");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Invalid access token");

  await token.fill("e2e-local-admin-token");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByRole("region", { name: "Running robots" })).toBeVisible({ timeout: 15_000 });
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
  const workspaceModes = page.getByRole("navigation", { name: "Primary workspaces" });
  await openStrategyWorkspace(page);
  await expect(page.locator(".strategy-lab")).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Pine", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import Pine Script" });
  await dialog.locator("textarea").fill(["//@version=6", 'indicator("Chart E2E SMA", overlay=true)', 'plot(ta.sma(close, 3), "SMA")'].join("\n"));
  await dialog.getByRole("button", { name: "Convert", exact: true }).click();
  await dialog.getByRole("button", { name: "Add 1 artifact", exact: true }).click();

  await workspaceModes.getByRole("button", { name: "Monitoring", exact: true }).click();
  await page.getByRole("button", { name: "ADD", exact: true }).click();
  await page.getByRole("menuitem").filter({ hasText: "Chart E2E SMA" }).click();

  await expect(page.locator(".strategy-chip")).toContainText("Chart E2E SMA", { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Remove artifact from chart" })).toBeVisible();
});

test("creates, starts, journals and stops a paper bot", { tag: "@smoke" }, async ({ page }) => {
  await openRobotsWorkspace(page);
  await page.getByLabel("Access token").fill("e2e-local-admin-token");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByRole("region", { name: "Running robots" })).toBeVisible({ timeout: 15_000 });

  await page
    .getByRole("button", { name: /Create paper bot|New bot/ })
    .first()
    .click();
  const botName = `Paper E2E ${Date.now()}`;
  await page.getByLabel("Bot name").fill(botName);
  // Keep lifecycle E2E deterministic: EURUSD is backed by the local synthetic
  // provider, while BTCUSDT startup depends on public exchange latency.
  const botForm = page.locator("form.trade-form");
  await botForm.locator('select[name="symbol"]').selectOption("EURUSD");
  const exchange = botForm.locator('select[name="exchange"]');
  await expect(exchange).toHaveValue("paper");
  await expect(exchange.locator("option")).toHaveCount(1);
  await page.getByRole("button", { name: "Create bot", exact: true }).click();

  const detail = page.locator(".trade-detail");
  await expect(detail.locator(".trade-detail-head strong")).toHaveText(botName, { timeout: 15_000 });
  await detail.getByRole("button", { name: "Start", exact: true }).click();
  await expect(detail.getByRole("button", { name: "Stop", exact: true })).toBeVisible({ timeout: 15_000 });

  const command = detail.getByRole("textbox", { name: "Bot command" });
  await command.fill("action=openposition;symbol=EURUSD;side=buy;qty=0.001;lev=1");
  await command.press("Enter");
  await expect(detail.locator("#order-journal-title")).toBeVisible({ timeout: 15_000 });
  const orderTable = detail.locator(".trade-order-journal table");
  await orderTable.scrollIntoViewIfNeeded();
  await expect(orderTable).toBeVisible();
  await expect(orderTable.getByRole("columnheader", { name: "Reason" })).toBeVisible();
  await expect(
    orderTable
      .getByRole("row")
      .filter({ hasText: /open|filled/i })
      .first()
  ).toBeVisible();

  await detail.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(detail.getByRole("button", { name: "Start", exact: true })).toBeVisible({ timeout: 15_000 });
  await detail.getByRole("button", { name: "Delete bot" }).click();
});

test("keeps research and paper settings usable without exposing exchange secrets", async ({ page }) => {
  let accountRequests = 0;
  await page.route("**/api/trade/accounts", async (route) => {
    accountRequests += 1;
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { accounts: [tradingAccountFixture("binance", false), tradingAccountFixture("bybit", true)] } });
    } else await route.continue();
  });
  await openRobotsWorkspace(page);
  await page.getByLabel("Access token").fill("e2e-local-admin-token");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  const paperNotice = page.locator(".runtime-paper-notice");
  await expect(paperNotice).toContainText("Research / Paper");
  await expect(paperNotice).toContainText("Private exchange requests, API keys and live orders are disabled on this server.");
  await expect(page.getByRole("region", { name: "Trading account registry" })).toHaveCount(0);
  await expect(page.locator('.account-credential-form, input[name="apiKey"], input[name="apiSecret"]')).toHaveCount(0);
  await expect(page.locator(".account-telemetry, .uta-panel")).toHaveCount(0);
  expect(accountRequests).toBe(0);
  await expect(page.getByLabel("Bot token")).toHaveAttribute("autocomplete", "new-password");
  await expect(page.getByLabel("Chat ID")).toHaveAttribute("inputmode", "numeric");
});

test("shows protected account economics as read-only admin evidence", async ({ page }) => {
  let requestedUrl = "";
  await page.route("**/api/trade/settings", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ json: { ok: true, demo: false, liveTradingEnabled: false, secureTradingOrigin: true, role: "admin" } });
    else await route.continue();
  });
  await page.route("**/api/trade/accounts", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ json: { accounts: [tradingAccountFixture("binance", true), tradingAccountFixture("bybit", true)] } });
    else await route.continue();
  });
  await page.route("**/api/trade/account-telemetry?**", async (route) => {
    requestedUrl = route.request().url();
    await route.fulfill({ json: accountTelemetryFixture() });
  });

  await openRobotsWorkspace(page);
  await page.getByLabel("Access token").fill("e2e-local-admin-token");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  const panel = page.locator(".account-telemetry");
  await expect(panel.getByText("Account economics evidence", { exact: true })).toBeVisible();
  await expect(panel).toContainText("executable is always false");
  await panel.getByRole("button", { name: "Refresh evidence" }).click();
  await expect(panel.getByRole("table", { name: "Account fee rates" })).toContainText("BTCUSDT");
  await expect(panel.getByRole("table", { name: "Borrow capacity and current rate" })).toContainText("Recall guarantee unavailable");
  await expect(panel.getByRole("table", { name: "Deposit / withdrawal networks" })).toContainText("BTC · BTC");
  await expect(panel.getByRole("table", { name: "Stablecoin bid / ask" })).toContainText("USDCUSDT");
  expect(requestedUrl).toContain("symbols=BTCUSDT%2CETHUSDT");
  await expectNoAxeViolations(page);
});

test("confirms account emergency stop and requires a separate flatten confirmation", async ({ page }) => {
  const mutations: Array<Record<string, unknown>> = [];
  let emergencyStatus: EmergencyStopStatus = {
    phase: "idle",
    ok: true,
    flattenRequested: false,
    botsStopped: 0,
    accounts: [],
    errors: []
  };
  await page.route("**/api/trade/settings", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ json: { demo: false, liveTradingEnabled: true, secureTradingOrigin: true, role: "admin" } });
    else await route.continue();
  });
  await page.route("**/api/trade/accounts", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ json: { accounts: [] } });
    else await route.continue();
  });
  await page.route("**/api/trade/kill", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ json: emergencyStatus });
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    mutations.push(body);
    emergencyStatus = {
      operationId: String(body.operationId),
      phase: "terminal",
      ok: true,
      flattenRequested: body.flatten === true,
      startedAt: 1,
      completedAt: 2,
      botsStopped: 2,
      accounts: [],
      errors: []
    };
    await route.fulfill({ json: emergencyStatus });
  });

  await openRobotsWorkspace(page);
  await page.getByLabel("Access token").fill("e2e-local-admin-token");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Stop bots + cancel orders" }).click();
  await expect(page.getByText("Emergency stop confirmed", { exact: true })).toBeVisible();
  expect(mutations[0]).toMatchObject({ flatten: false });
  expect(mutations[0]?.operationId).toMatch(/^[0-9a-f-]{36}$/);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Stop + cancel + flatten positions" }).click();
  await expect.poll(() => mutations.length).toBe(2);
  expect(mutations[1]).toMatchObject({ flatten: true, confirmFlatten: "FLATTEN_ALL_LIVE_POSITIONS" });
});

test("shows Bybit UTA collateral risk and requires explicit debt confirmations", { tag: "@smoke" }, async ({ page }) => {
  const mutations: Array<{ url: string; body: Record<string, unknown> }> = [];
  const snapshot = bybitUtaFixture();
  await page.route("**/api/trade/settings", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ json: { demo: false, liveTradingEnabled: true, secureTradingOrigin: true, role: "admin" } });
    else await route.continue();
  });
  await page.route("**/api/trade/accounts", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ json: { accounts: [tradingAccountFixture("bybit", true)] } });
    else await route.continue();
  });
  await page.route("**/api/trade/bybit/uta**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ json: { configured: true, snapshot } });
      return;
    }
    mutations.push({ url: request.url(), body: request.postDataJSON() as Record<string, unknown> });
    await route.fulfill({ json: { ok: true, status: "success", snapshot } });
  });

  await openRobotsWorkspace(page);
  await page.getByLabel("Access token").fill("e2e-local-admin-token");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  const panel = page.locator(".uta-panel");
  await expect(panel.getByText("Bybit UTA collateral & debt", { exact: true })).toBeVisible();
  await expect(panel.getByText("$50,000.00", { exact: true })).toBeVisible();
  await expect(panel.getByRole("table", { name: "Collateral and liabilities" })).toContainText("BTC");
  await expect(panel.getByRole("table", { name: "Collateral and liabilities" })).toContainText("USDT");

  const borrow = panel.getByRole("group", { name: "Manual variable-rate borrow" });
  await borrow.getByLabel("Amount").fill("25");
  await borrow.getByLabel("I understand that interest accrues and BTC collateral can be liquidated.").check();
  page.once("dialog", (dialog) => dialog.accept());
  await borrow.getByRole("button", { name: "Borrow USDT" }).click();
  await expect.poll(() => mutations.length).toBe(1);
  expect(mutations[0]).toMatchObject({ body: { coin: "USDT", amount: 25, confirm: true } });

  const repay = panel.getByRole("group", { name: "Repay liability" });
  await repay.getByLabel("Amount").fill("10");
  await repay.getByLabel("I confirm this repayment instruction.").check();
  page.once("dialog", (dialog) => dialog.accept());
  await repay.getByRole("button", { name: "Repay USDT" }).click();
  await expect.poll(() => mutations.length).toBe(2);
  expect(mutations[1]).toMatchObject({ body: { coin: "USDT", amount: 10, repaymentType: "FLEXIBLE", convertCollateral: false, confirm: true } });

  await page.getByRole("button", { name: "New bot" }).click();
  const botForm = page.locator("form.trade-form");
  const exchange = botForm.locator('select[name="exchange"]');
  await expect(exchange).toHaveValue("paper");
  await expect(exchange.locator("option")).toHaveCount(1);
  await expect(exchange.locator('option[value="bybit"]')).toHaveCount(0);
  await expect(page.getByLabel("Use Bybit UTA cross collateral")).toHaveCount(0);
  await expect(botForm.getByRole("note")).toContainText("paper account");
});

test("filters basis research candidates without placing orders", { tag: "@smoke" }, async ({ page }) => {
  const publicVenueBoundary = await page.request.get("/api/market-data/unknown/tickers?marketType=spot");
  expect(publicVenueBoundary.status()).toBe(404);
  expect(await publicVenueBoundary.json()).toMatchObject({ availableVenues: expect.arrayContaining(["deribit", "gate", "hyperliquid", "okx"]) });
  const scanCapturedAt = Date.now();
  const scanFixture = {
    updatedAt: scanCapturedAt,
    stale: false,
    scannedSymbols: 2,
    estimatedTotalCostBps: 0,
    sources: [
      { exchange: "binance", market: "spot", ok: true },
      { exchange: "binance", market: "perpetual", ok: true },
      { exchange: "bybit", market: "spot", ok: true },
      { exchange: "bybit", market: "perpetual", ok: true }
    ],
    opportunities: [
      {
        id: "BTCUSDT:binance:bybit",
        symbol: "BTCUSDT",
        assetId: "crypto:bitcoin",
        identityScope: "cross-venue-reviewed",
        spotInstrumentId: "binance:spot:BTCUSDT",
        futuresInstrumentId: "bybit:perpetual:BTCUSDT",
        spotExchange: "binance",
        futuresExchange: "bybit",
        spotBid: 99900,
        spotAsk: 100000,
        spotAskSize: 1,
        futuresBid: 101500,
        futuresAsk: 101600,
        futuresBidSize: 0.5,
        grossSpreadBps: 150,
        estimatedTotalCostBps: 0,
        netEdgeBps: 150,
        topBookCapacityUsd: 50750,
        fundingRate: 0.0001,
        fundingIntervalMinutes: 480,
        fundingScheduleVerified: true,
        nextFundingTime: scanCapturedAt + 3600000,
        spotExchangeTs: scanCapturedAt,
        spotExchangeTimestampVerified: true,
        spotReceivedAt: scanCapturedAt,
        futuresExchangeTs: scanCapturedAt,
        futuresExchangeTimestampVerified: true,
        futuresReceivedAt: scanCapturedAt,
        quoteAgeMs: 0,
        legSkewMs: 0,
        dataQuality: "fresh",
        capturedAt: scanCapturedAt
      },
      {
        id: "ETHUSDT:bybit:binance",
        symbol: "ETHUSDT",
        assetId: "crypto:ethereum",
        identityScope: "cross-venue-reviewed",
        spotInstrumentId: "bybit:spot:ETHUSDT",
        futuresInstrumentId: "binance:perpetual:ETHUSDT",
        spotExchange: "bybit",
        futuresExchange: "binance",
        spotBid: 3999,
        spotAsk: 4000,
        spotAskSize: 0.2,
        futuresBid: 4020,
        futuresAsk: 4021,
        futuresBidSize: 0.2,
        grossSpreadBps: 50,
        estimatedTotalCostBps: 0,
        netEdgeBps: 50,
        topBookCapacityUsd: 800,
        fundingRate: -0.00005,
        fundingIntervalMinutes: 480,
        fundingScheduleVerified: true,
        nextFundingTime: scanCapturedAt + 3600000,
        spotExchangeTs: scanCapturedAt,
        spotExchangeTimestampVerified: true,
        spotReceivedAt: scanCapturedAt,
        futuresExchangeTs: scanCapturedAt,
        futuresExchangeTimestampVerified: true,
        futuresReceivedAt: scanCapturedAt,
        quoteAgeMs: 0,
        legSkewMs: 0,
        dataQuality: "fresh",
        capturedAt: scanCapturedAt
      }
    ]
  };
  let markSocketRouted!: () => void;
  const socketRouted = new Promise<void>((resolve) => {
    markSocketRouted = resolve;
  });
  await page.routeWebSocket("/arbitrage-stream", () => {
    // REST owns the deterministic fixture in this journey. Keeping the routed socket open without
    // sending a second snapshot avoids racing two valid initial transports during the first click.
    markSocketRouted();
  });
  await page.route("**/api/arbitrage**", async (route) => {
    const requestUrl = new URL(route.request().url());
    const pathname = requestUrl.pathname;
    if (pathname.endsWith("/clock-health")) {
      const updatedAt = Date.now();
      await route.fulfill({
        json: {
          schemaVersion: 1,
          updatedAt,
          stale: false,
          sources: ["binance", "bybit"].map((venue) => ({
            sourceId: `${venue}:public`,
            status: "calibrated",
            evaluatedAt: updatedAt,
            sampleCount: 3,
            consistentSampleCount: 3,
            sampledAt: updatedAt - 10,
            expiresAt: updatedAt + 60_000,
            roundTripMs: 10,
            minimumObservedRoundTripMs: 8,
            offsetLowerMs: -4,
            offsetUpperMs: 6,
            offsetMidpointMs: 1,
            uncertaintyMs: 5,
            rejectedProbes: 0,
            ok: true,
            endpoint: `https://${venue}.example/time`
          }))
        }
      });
      return;
    }
    if (pathname.endsWith("/native-spreads")) {
      const nativeUpdatedAt = Date.now();
      await route.fulfill({
        json: {
          venue: "bybit",
          marketDataMode: "venue-native-spread-orderbook",
          executionModel: "venue-matched-multi-leg",
          readOnly: true,
          updatedAt: nativeUpdatedAt,
          totalInstruments: 4,
          eligibleInstruments: 2,
          scannedInstruments: 2,
          healthyBooks: 1,
          totalOpportunities: 1,
          truncated: false,
          candidateTruncated: false,
          sourceErrors: ["SECOND_SPREAD: one-sided book"],
          opportunities: [
            {
              id: "bybit:native-spread:SOLUSDT_SOL/USDT",
              venue: "bybit",
              symbol: "SOLUSDT_SOL/USDT",
              contractType: "FundingRateArb",
              status: "Trading",
              baseCoin: "SOL",
              quoteCoin: "USDT",
              settleCoin: "USDT",
              tickSize: 0.0001,
              minimumPrice: -2000,
              maximumPrice: 2000,
              quantityStep: 0.1,
              minimumQuantity: 0.1,
              maximumQuantity: 50000,
              launchTime: nativeUpdatedAt - 100000,
              legs: [
                { symbol: "SOLUSDT", contractType: "LinearPerpetual" },
                { symbol: "SOLUSDT", contractType: "Spot" }
              ],
              bidPrice: -1.25,
              bidQuantity: 2,
              askPrice: -1.2,
              askQuantity: 3,
              bookWidth: 0.05,
              relativeBookWidthBps: 408.1632653061228,
              executableQuantity: 2,
              sequence: 10,
              exchangeTs: nativeUpdatedAt - 10,
              matchingEngineTs: nativeUpdatedAt - 12,
              receivedAt: nativeUpdatedAt,
              quoteAgeMs: 10,
              riskFlags: ["read-only", "top-book-only", "venue-native-combination", "revalidate-before-order"]
            }
          ]
        }
      });
      return;
    }
    if (pathname.endsWith("/triangular")) {
      await route.fulfill({
        json: {
          updatedAt: Date.now(),
          venue: "binance",
          startAsset: "USDT",
          requestedStartQuantity: 1000,
          scannedMarkets: 300,
          scannedCycles: 20,
          totalOpportunities: 1,
          truncated: false,
          marketDataMode: "rest-top-book",
          snapshotSource: "rest-snapshot",
          executionStatus: "non-executable-candidate",
          sequenceVerified: false,
          opportunities: [
            {
              id: "binance:USDT-BTC-ETH-USDT",
              venue: "binance",
              edgeKind: "non-executable-candidate",
              executionStatus: "non-executable-candidate",
              marketDataMode: "rest-top-book",
              sequenceVerified: false,
              startAsset: "USDT",
              startQuantity: 900,
              endQuantity: 902,
              grossReturnBps: 52,
              netReturnBps: 22,
              limitingCapacity: { requestedStartQuantity: 1000, executableStartQuantity: 900, utilizationPct: 90 },
              legs: [
                { index: 0, symbol: "BTCUSDT", side: "buy", fromAsset: "USDT", toAsset: "BTC", inputQuantity: 900, outputQuantity: 0.009, averagePrice: 100000, feeBps: 10, levelsUsed: 1 },
                { index: 1, symbol: "ETHBTC", side: "buy", fromAsset: "BTC", toAsset: "ETH", inputQuantity: 0.009, outputQuantity: 0.225, averagePrice: 0.04, feeBps: 10, levelsUsed: 1 },
                { index: 2, symbol: "ETHUSDT", side: "sell", fromAsset: "ETH", toAsset: "USDT", inputQuantity: 0.225, outputQuantity: 902, averagePrice: 4008.89, feeBps: 10, levelsUsed: 1 }
              ],
              timestamps: { evaluatedAt: Date.now(), quoteAgeMs: 15, legSkewMs: 3, exchangeTimestampsVerified: false },
              riskFlags: ["sequential-leg-risk", "top-book-only", "rest-snapshot", "unsequenced", "non-executable-candidate"]
            }
          ]
        }
      });
      return;
    }
    if (pathname.endsWith("/history")) {
      await route.fulfill({
        json: {
          routeId: "BTCUSDT:binance:bybit",
          points: [
            { routeId: "BTCUSDT:binance:bybit", symbol: "BTCUSDT", spotExchange: "binance", futuresExchange: "bybit", grossSpreadBps: 120, topBookCapacityUsd: 50000, fundingRate: 0.0001, ts: Date.now() - 60000 },
            { routeId: "BTCUSDT:binance:bybit", symbol: "BTCUSDT", spotExchange: "binance", futuresExchange: "bybit", grossSpreadBps: 150, topBookCapacityUsd: 50750, fundingRate: 0.0001, ts: Date.now() }
          ]
        }
      });
      return;
    }
    if (pathname.endsWith("/depth")) {
      const exit = requestUrl.searchParams.get("direction") === "exit";
      const capturedAt = Date.now();
      await route.fulfill({
        json: {
          identityScope: "cross-venue-reviewed",
          assetId: "crypto:bitcoin",
          economicAssetId: "crypto:bitcoin",
          spotInstrumentId: "binance:spot:BTCUSDT",
          futuresInstrumentId: "bybit:perpetual:BTCUSDT",
          symbol: "BTCUSDT",
          direction: exit ? "exit" : "entry",
          requestedNotionalUsd: 10000,
          targetQuantity: 0.1,
          matchedQuantity: 0.1,
          quantityStep: 0.001,
          quantityStepSource: "instrument",
          precisionVerified: true,
          roundingDustQuantity: 0,
          liquidityShortfallQuantity: 0,
          residualDeltaQuantity: 0,
          grossSpreadBps: 150,
          constraints: { metadataVerified: true, minimumsSatisfied: true, verified: true, failures: [] },
          complete: true,
          capturedAt,
          timing: {
            spot: { exchangeTs: capturedAt, receivedAt: capturedAt, ageMs: 0 },
            perpetual: { exchangeTs: capturedAt, receivedAt: capturedAt, ageMs: 0 },
            ageMs: 0,
            receiveSkewMs: 0,
            exchangeSkewMs: 0,
            legSkewMs: 0,
            exchangeTimestampsVerified: true,
            quality: "fresh"
          },
          spot: {
            exchange: "binance",
            market: "spot",
            side: exit ? "sell" : "buy",
            requestedNotionalUsd: 10000,
            filledNotionalUsd: exit ? 10050 : 10000,
            quantity: 0.1,
            averagePrice: exit ? 100500 : 100000,
            worstPrice: exit ? 100500 : 100000,
            topPrice: exit ? 100500 : 100000,
            slippageBps: 0,
            levelsUsed: 1,
            complete: true,
            capturedAt
          },
          perpetual: {
            exchange: "bybit",
            market: "perpetual",
            side: exit ? "buy" : "sell",
            requestedNotionalUsd: 10000,
            filledNotionalUsd: exit ? 10100 : 10150,
            quantity: 0.1,
            averagePrice: exit ? 101000 : 101500,
            worstPrice: exit ? 101000 : 101500,
            topPrice: exit ? 101000 : 101500,
            slippageBps: 0,
            levelsUsed: 1,
            complete: true,
            capturedAt
          }
        }
      });
      return;
    }
    await route.fulfill({ json: scanFixture });
  });

  // Firefox requires WebSocket routes to be installed before navigation.
  await page.goto("/");
  await page.getByRole("navigation", { name: "Primary workspaces" }).getByRole("button", { name: "Screener", exact: true }).click();
  await socketRouted;
  const table = page.getByRole("table", { name: /spot\/perpetual research candidates/ });
  const btcRow = table.getByRole("row").filter({ hasText: "BTCUSDT" });
  await expect(btcRow).toBeVisible();
  await expect(page.getByText("Venue clock calibration", { exact: true })).toBeVisible();
  await expect(page.getByText("clock calibrated", { exact: false }).first()).toBeVisible();
  await expect(table.getByRole("row").filter({ hasText: "ETHUSDT" })).toBeHidden();
  await btcRow.getByRole("button", { name: "Analyze order-book depth for BTCUSDT" }).click();
  await expect(table.getByText("Depth estimate for $10,000")).toBeVisible();
  await expect(table.getByText("Both legs have enough visible depth")).toBeVisible();
  await expect(table.getByRole("img", { name: "24-hour opportunity history" })).toBeVisible();
  await btcRow.getByRole("button", { name: "Open paper two-leg position for BTCUSDT" }).click();
  const paper = page.getByRole("region", { name: "Paper arbitrage positions" });
  await expect(paper).toContainText("BTCUSDT");
  const exitDepthRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === "/api/arbitrage/depth" && url.searchParams.get("direction") === "exit";
  });
  await paper.getByRole("button", { name: "Close paper" }).click();
  expect(new URL((await exitDepthRequest).url()).searchParams.get("quantity")).toBe("0.1");
  await expect(paper).toContainText("Closed");
  await expect(paper).toContainText("Closed win rate");
  await page.getByLabel("Minimum top-book capacity").fill("0");
  await page.getByLabel("Search pair").fill("ETH");
  const ethRow = table.getByRole("row").filter({ hasText: "ETHUSDT" });
  await expect(ethRow).toContainText("Bybit");
  await expect(ethRow).toContainText("Binance");
  const chartRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === "/api/candles" && url.searchParams.get("symbol") === "ETHUSDT" && url.searchParams.get("exchange") === "binance" && url.searchParams.get("marketType") === "linear";
  });
  await ethRow.getByRole("button", { name: "Open Binance perpetual chart for ETHUSDT" }).click();
  await chartRequest;
  await expect(page.getByRole("button", { name: /Current instrument ETHUSDT/ })).toBeVisible();

  await page.getByRole("navigation", { name: "Primary workspaces" }).getByRole("button", { name: "Screener", exact: true }).click();
  await page.getByRole("group", { name: "Arbitrage scanner mode" }).getByRole("button", { name: "Triangular" }).click();
  const triangular = page.getByRole("table", { name: "Three-leg top-book simulations" });
  await expect(triangular.getByRole("row").filter({ hasText: "USDT → BTC → ETH → USDT" })).toBeVisible();
  await expect(page.getByText("Sequential execution risk")).toBeVisible();

  await page.getByRole("group", { name: "Arbitrage scanner mode" }).getByRole("button", { name: "Bybit native spreads" }).click();
  const nativeSpreads = page.getByRole("table", { name: "Venue-native two-leg combination quotes" });
  const nativeRow = nativeSpreads.getByRole("row").filter({ hasText: "SOLUSDT_SOL/USDT" });
  await expect(nativeRow).toContainText("Perpetual + spot");
  await expect(nativeRow).toContainText("-1.25");
  await expect(page.getByText("Native book is not guaranteed profit")).toBeVisible();
  await expect(page.getByText("Some books were rejected (1).")).toBeVisible();
  await expectNoAxeViolations(page);
});

test("traps command-palette focus and restores it on Escape", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "Open command palette" });
  await trigger.click();

  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toHaveAttribute("aria-modal", "true");
  const search = palette.getByPlaceholder("Search symbols, timeframes, chart types, actions...");
  await expect(search).toBeFocused();

  await search.press("Shift+Tab");
  await expect(palette.getByRole("option").last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("uses exclusive mobile market and instrument sheets without covering the chart", { tag: "@smoke" }, async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("img", { name: /BTCUSDT candles chart on 1m/i })).toBeVisible({ timeout: 20_000 });
  const mobileTools = page.getByRole("button", { name: "More tools" });
  await expect(mobileTools).toHaveAttribute("aria-expanded", "false");
  const marketsTrigger = page.getByRole("button", { name: "Toggle markets panel", includeHidden: true });
  const instrumentTrigger = page.getByRole("button", { name: "Toggle instrument panel", includeHidden: true });
  await expect(page.getByRole("dialog", { name: "Markets" })).toBeHidden();
  await expect(page.getByRole("dialog", { name: "Current instrument" })).toBeHidden();
  const stageBox = await page.locator(".chart-stage").boundingBox();
  const analysisBox = await page.locator(".session-liquidity-badge").boundingBox();
  const indicatorOverlay = page.locator(".chart-indicator-overlay");
  const indicatorBox = await indicatorOverlay.boundingBox();
  const priceAxis = page.getByRole("slider", { name: /Price axis scale/i });
  const priceAxisBox = await priceAxis.boundingBox();
  expect(stageBox).not.toBeNull();
  expect(analysisBox).not.toBeNull();
  expect(indicatorBox).not.toBeNull();
  expect(priceAxisBox).not.toBeNull();
  expect(analysisBox!.x).toBeGreaterThanOrEqual(stageBox!.x);
  expect(analysisBox!.x + analysisBox!.width).toBeLessThanOrEqual(stageBox!.x + stageBox!.width);
  expect(indicatorBox!.x + indicatorBox!.width).toBeLessThanOrEqual(priceAxisBox!.x + 1);
  await indicatorOverlay.locator(".indicator-strip").evaluate((strip) => {
    strip.scrollLeft = strip.scrollWidth;
  });
  const hideRsi = indicatorOverlay.getByRole("button", { name: "Hide RSI" });
  await expect(hideRsi).toBeVisible();
  const hideRsiBox = await hideRsi.boundingBox();
  expect(hideRsiBox).not.toBeNull();
  expect(hideRsiBox!.x + hideRsiBox!.width).toBeLessThanOrEqual(priceAxisBox!.x + 1);
  await hideRsi.click();
  await expect(indicatorOverlay.getByRole("button", { name: "Show RSI" })).toBeVisible();

  await openMobileTools(page);
  await expect(marketsTrigger).toBeVisible();
  await expect(instrumentTrigger).toBeVisible();
  await expect(marketsTrigger).toHaveAttribute("aria-haspopup", "dialog");
  await expect(marketsTrigger).toHaveAttribute("aria-pressed", "false");
  await expect(instrumentTrigger).toHaveAttribute("aria-pressed", "false");
  await marketsTrigger.click();
  const markets = page.getByRole("dialog", { name: "Markets" });
  await expect(markets).toBeVisible();
  await expect(marketsTrigger).toHaveAttribute("aria-pressed", "true");
  await expect(markets.getByPlaceholder("Search BTC, NASDAQ, EUR…")).toBeFocused();
  await page.mouse.click(8, 90);
  await expect(markets).toBeHidden();
  await expect(mobileTools).toBeVisible();
  await expect(mobileTools).toHaveAttribute("aria-expanded", "false");
  await openMobileTools(page);
  await marketsTrigger.click();
  await expect(markets).toBeVisible();
  await markets.getByPlaceholder("Search BTC, NASDAQ, EUR…").fill("ETHUSDT");
  await markets.getByRole("button", { name: /^ETHUSDT/ }).click();
  await expect(markets).toBeHidden();
  await expect(page.getByRole("img", { name: /ETHUSDT candles chart on 1m/i })).toBeVisible({ timeout: 20_000 });

  await openMobileTools(page);
  await instrumentTrigger.click();
  const instrument = page.getByRole("dialog", { name: "Current instrument" });
  await expect(instrument).toBeVisible();
  await expect(instrument.locator(".quote-meta")).toContainText("ETHUSDT");
  await expect(markets).toBeHidden();
  await expectNoAxeViolations(page);
  const sheetBox = await instrument.boundingBox();
  expect(sheetBox).not.toBeNull();
  expect(sheetBox!.y + sheetBox!.height).toBeLessThanOrEqual(844);
  await page.keyboard.press("Escape");
  await expect(instrument).toBeHidden();
  await expect(mobileTools).toBeVisible();
  await expect(mobileTools).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("img", { name: /ETHUSDT candles chart on 1m/i })).toBeVisible();
});

test("keeps every mobile Strategy Studio pane full-width and operable", { tag: "@smoke" }, async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();

  await openStrategyWorkspace(page);
  await expect(page.locator(".strategy-lab")).toBeVisible({ timeout: 20_000 });
  const paneTabs = page.getByRole("navigation", { name: "Strategy Studio panels" });
  const libraryTab = paneTabs.getByRole("button", { name: "Library", exact: true });
  const editorTab = paneTabs.getByRole("button", { name: "Editor", exact: true });
  const parametersTab = paneTabs.getByRole("button", { name: "Parameters", exact: true });
  const grid = page.locator(".strategy-grid");

  const expectPaneFits = async (selector: string) => {
    await expect
      .poll(() =>
        page.locator(selector).evaluate((pane) => {
          const paneRect = pane.getBoundingClientRect();
          const gridElement = pane.closest(".strategy-grid");
          if (!gridElement) return false;
          const gridRect = gridElement.getBoundingClientRect();
          return gridElement.scrollWidth <= gridElement.clientWidth + 1 && paneRect.width > 0 && paneRect.height >= gridRect.height - 2 && paneRect.left >= gridRect.left - 1 && paneRect.right <= gridRect.right + 1;
        })
      )
      .toBe(true);
  };

  await expect(editorTab).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".strategy-authoring")).toBeVisible();
  await expect(page.locator(".strategy-library")).toBeHidden();
  await expect(page.locator(".code-preview")).toBeHidden();
  await expect(page.locator(".blocklySvg")).toBeVisible({ timeout: 20_000 });
  const toolboxToggle = page.getByRole("button", { name: "Show blocks" });
  await expect(toolboxToggle).toBeVisible();
  await expect(toolboxToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".blocklyToolbox")).toBeHidden();
  await toolboxToggle.click();
  await expect(page.getByRole("button", { name: "Hide blocks" })).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".blocklyToolbox")).toBeVisible();
  await page.getByRole("button", { name: "Hide blocks" }).click();
  await expect(page.locator(".blocklyToolbox")).toBeHidden();
  await expectPaneFits(".strategy-authoring");

  await libraryTab.click();
  await expect(libraryTab).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".strategy-library")).toBeVisible();
  await expect(page.locator(".strategy-authoring")).toBeHidden();
  await expectPaneFits(".strategy-library");

  await parametersTab.click();
  await expect(parametersTab).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".code-preview")).toBeVisible();
  await expect(page.locator(".strategy-library")).toBeHidden();
  await expectPaneFits(".code-preview");
  await expectNoAxeViolations(page);

  await editorTab.click();
  await expect(page.locator(".blocklySvg")).toBeVisible({ timeout: 20_000 });
  await expectPaneFits(".strategy-authoring");
  expect(await grid.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);

  for (const width of [320, 760]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(paneTabs).toBeVisible();
    await expectPaneFits(".strategy-authoring");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  }
});

test("reconnects the market stream without duplicating candles", async ({ page }) => {
  const candles = mockCandles();
  await mockCandleHistory(page, candles);
  await installMarketSocketMock(page, "reconnect", candles);
  await page.reload();

  await expect(page.getByRole("status", { name: "Feed: connected" })).toHaveAttribute("title", "Feed: connected", { timeout: 20_000 });
  await expect(page.locator(".feed-row").filter({ hasText: "Candles" }).locator("strong")).toHaveText("2");
  await expect(page.locator(".feed-row").filter({ hasText: "Provider" }).locator("strong")).toHaveText("mock");
  await expect.poll(() => page.evaluate(() => (window as Window & { __marketSocketAttempts?: number }).__marketSocketAttempts)).toBe(2);
});

test("shows an explicit market-data unavailable state", async ({ page }) => {
  await page.route("**/api/candles?**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Market data unavailable for BTCUSDT", unavailable: true })
    })
  );
  await installMarketSocketMock(page, "unavailable", []);
  await page.reload();

  await expect(page.getByRole("status", { name: "Feed: error" })).toHaveAttribute("title", "Feed: error", { timeout: 20_000 });
  await expect(page.locator(".feed-row").filter({ hasText: "Status" })).toContainText("Market data unavailable for BTCUSDT");
  await expect(page.locator(".feed-row").filter({ hasText: "Candles" }).locator("strong")).toHaveText("0");
});

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
            type: "orderbook",
            symbol: "BTCUSDT",
            exchange: "binance",
            bids: [
              [100, 2],
              [99.9, 4]
            ],
            asks: [
              [100.1, 3],
              [100.2, 5]
            ],
            sequence: 1,
            exchangeTs: Date.now(),
            ts: Date.now()
          });
        }, 0);
      }

      close() {
        this.readyState = MockOrderBookSocket.CLOSED;
      }
      send() {}
      private emit(message: unknown) {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
      }
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
    const target = window as Window & { __emitTradeFlow?: (trades: Array<{ id: string; price: number; size: number; side: "buy" | "sell"; exchangeTs: number }>) => void };
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
        target.__emitTradeFlow = (trades) => this.emit({ type: "trade_flow", symbol: "BTCUSDT", exchange: "binance", ts: Date.now(), trades });
        window.setTimeout(() => {
          this.readyState = MockTradeFlowSocket.OPEN;
          this.onopen?.(new Event("open"));
          this.emit({ type: "trade_flow_status", symbol: "BTCUSDT", exchange: "binance", status: "connected", message: "mock trades connected", ts: Date.now() });
          this.emit({
            type: "trade_flow",
            symbol: "BTCUSDT",
            exchange: "binance",
            ts: Date.now(),
            trades: [
              { id: "buy-1", price: 100, size: 2, side: "buy", exchangeTs: Date.now() },
              { id: "sell-1", price: 100, size: 1, side: "sell", exchangeTs: Date.now() }
            ]
          });
        }, 0);
      }

      close() {
        this.readyState = MockTradeFlowSocket.CLOSED;
      }
      send() {}
      private emit(message: unknown) {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
      }
    }
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(Target, args) {
        const url = String(args[0]);
        return url.includes("/trade-flow?") ? new MockTradeFlowSocket(url) : Reflect.construct(Target, args);
      }
    });
  });
}

function tradingAccountFixture(exchange: "binance" | "bybit", configured: boolean) {
  const status = configured ? "ready" : "credentials_missing";
  return {
    id: `${exchange}-e2e-account`,
    label: `Demo ${exchange} account`,
    exchange,
    ownership: "own",
    enabled: true,
    createdAt: 1_780_000_000_000,
    updatedAt: 1_780_000_000_000,
    status,
    credential: { mode: "account_isolated", status: configured ? "configured" : "missing", isolated: true },
    capabilities: { liveExecution: configured, credentialIsolation: true, multipleCredentialAccounts: true },
    botIds: []
  };
}

function accountTelemetryFixture() {
  const evidence = { source: "bybit:/v5/account/fee-rate", version: "account-telemetry-v1", asOf: Date.now(), validUntil: Date.now() + 30_000, timestampQuality: "venue", fresh: true };
  return {
    schemaVersion: 1,
    readOnly: true,
    generatedAt: Date.now(),
    validUntil: Date.now() + 30_000,
    complete: true,
    request: { venues: ["binance", "bybit"], symbols: ["BTCUSDT", "ETHUSDT"], assets: ["BTC", "USDT", "USDC"], stableAssets: ["USDC"] },
    venues: [
      {
        venue: "bybit",
        configured: true,
        status: "fresh",
        generatedAt: Date.now(),
        validUntil: Date.now() + 30_000,
        fees: [{ venue: "bybit", market: "perpetual", symbol: "BTCUSDT", tierId: "account-symbol", makerBps: 2, takerBps: 5, feeAsset: { status: "execution-dependent", actualFillRequired: true }, usableForRateRanking: true, evidence }],
        borrow: [{ venue: "bybit", asset: "BTC", availableQuantity: 0.5, accountLimitQuantity: 1, annualRateBps: 1_200, rateBasis: "current-hourly-annualized", borrowable: true, recallStatus: "unknown", usableForProjectedCost: true, usableForNonRecallableRoutes: false, evidence }],
        transferNetworks: [{ venue: "bybit", asset: "BTC", network: "BTC", depositEnabled: true, withdrawEnabled: true, fixedWithdrawFee: 0.0001, estimatedArrivalMinutes: 20, usableForTransfer: true, evidence }],
        issues: []
      },
      { venue: "binance", configured: true, status: "partial", generatedAt: Date.now(), validUntil: Date.now() + 30_000, fees: [], borrow: [], transferNetworks: [], issues: [] }
    ],
    stablecoinFx: [{ venue: "bybit", baseAsset: "USDC", quoteAsset: "USDT", symbol: "USDCUSDT", bid: 0.999, ask: 1.001, usableForEconomics: true, evidence }],
    issues: [],
    readiness: { feeRates: true, feeAssets: false, borrowCapacityAndRate: true, borrowRecall: false, transferNetworks: true, stablecoinFx: true, executable: false, blockers: ["Borrow recall is not proven"] },
    governor: { healthy: true, sources: [] }
  };
}

function bybitUtaFixture() {
  return {
    updatedAt: 1_780_000_000_000,
    account: { unifiedMarginStatus: 5, marginMode: "REGULAR_MARGIN", totalEquity: 50_000, totalWalletBalance: 49_000, totalMarginBalance: 49_500, totalAvailableBalance: 39_000, totalPerpUpl: 500, totalInitialMargin: 10_000, totalMaintenanceMargin: 5_000, accountImRate: 0.2, accountMmRate: 0.1 },
    assets: [
      {
        coin: "BTC",
        equity: 1,
        usdValue: 49_000,
        walletBalance: 1,
        borrowAmount: 0,
        spotBorrow: 0,
        derivativesBorrow: 0,
        accruedInterest: 0,
        unrealisedPnl: 0,
        marginCollateral: true,
        collateralEnabled: true,
        collateralRestriction: "none",
        hourlyBorrowRate: 0.000001,
        maxBorrowingAmount: 10,
        availableToBorrow: 9,
        borrowUsageRate: 0.1,
        borrowable: true
      },
      {
        coin: "USDT",
        equity: -100,
        usdValue: -100,
        walletBalance: 0,
        borrowAmount: 100,
        spotBorrow: 40,
        derivativesBorrow: 60,
        accruedInterest: 0.01,
        unrealisedPnl: 0,
        marginCollateral: true,
        collateralEnabled: true,
        collateralRestriction: "none",
        hourlyBorrowRate: 0.00001,
        maxBorrowingAmount: 1_000,
        availableToBorrow: 900,
        borrowUsageRate: 0.1,
        borrowable: true
      }
    ],
    borrowHistory: [],
    risk: { level: "warning", entryAllowed: true, reasons: [], maxBorrowUsageRate: 0.1 },
    limits: { maxBorrowUsageRate: 0.8, maxAccountMmRate: 0.5 }
  };
}

async function expectNoAxeViolations(page: Page) {
  const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(audit.violations, audit.violations.map((item) => `${item.id}: ${item.help} (${item.nodes.length})`).join("\n")).toEqual([]);
}

async function navigateToCurrentAppAndWaitForWorkspace(page: Page) {
  // Firefox can leave Playwright's reload lifecycle pending after a service-worker navigation.
  // A same-URL navigation still creates a fresh document; the mounted workspace is the readiness boundary.
  await page.goto(page.url(), { waitUntil: "commit" });
  await expect(page.getByRole("navigation", { name: "Primary workspaces" })).toBeVisible({ timeout: 20_000 });
}

async function openStrategyWorkspace(page: Page, labels = { automation: "Automation", strategies: "Strategies" }) {
  const navigation = page.locator(".workspace-navigation");
  const strategies = navigation.getByRole("button", { name: labels.strategies, exact: true });
  await expect(navigation).toBeVisible({ timeout: 20_000 });
  if ((page.viewportSize()?.width ?? 0) <= 760) {
    await expect(strategies).toBeVisible({ timeout: 20_000 });
    await strategies.click();
    return;
  }
  if (await strategies.isVisible()) {
    await strategies.click();
    return;
  }
  await navigation.getByRole("button", { name: labels.automation, exact: true }).click();
}

async function openRobotsWorkspace(page: Page, labels = { automation: "Automation", robots: "Robots" }) {
  const navigation = page.locator(".workspace-navigation");
  const robots = navigation.getByRole("button", { name: labels.robots, exact: true });
  await expect(navigation).toBeVisible({ timeout: 20_000 });
  if ((page.viewportSize()?.width ?? 0) <= 760) {
    await expect(robots).toBeVisible({ timeout: 20_000 });
    await robots.click();
    return;
  }
  if (!(await robots.isVisible())) {
    await navigation.getByRole("button", { name: labels.automation, exact: true }).click();
    await expect(robots).toBeVisible();
  }
  await robots.click();
}

async function openMobileTools(page: Page) {
  const trigger = page.getByRole("button", { name: "More tools" });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
}

async function installPwaLaunchQueue(page: Page) {
  await page.addInitScript(() => {
    type LaunchConsumer = (params: { files: Array<{ name: string; getFile(): Promise<File> }> }) => void;
    const target = window as Window & {
      launchQueue?: { setConsumer(next: LaunchConsumer): void };
      __pwaLaunchReady?: boolean;
      __dispatchPwaFile?: (input: { name: string; type: string; content: string }) => void;
    };
    let consumer: LaunchConsumer | undefined;
    const launchQueue = {
      setConsumer(next) {
        consumer = next;
        target.__pwaLaunchReady = true;
      }
    };
    Object.defineProperty(target, "launchQueue", { configurable: true, value: launchQueue });
    target.__dispatchPwaFile = ({ name, type, content }) => {
      if (!consumer) throw new Error("PWA launch consumer is not ready");
      consumer({ files: [{ name, getFile: async () => new File([content], name, { type }) }] });
    };
  });
  await navigateToCurrentAppAndWaitForWorkspace(page);
  await expect.poll(() => page.evaluate(() => Boolean((window as Window & { __pwaLaunchReady?: boolean }).__pwaLaunchReady))).toBe(true);
}

async function dispatchPwaFile(page: Page, input: { name: string; type: string; content: string }) {
  await page.evaluate((file) => {
    const target = window as Window & { __dispatchPwaFile?: (value: typeof file) => void };
    target.__dispatchPwaFile?.(file);
  }, input);
}

async function shareResearchFiles(page: Page, inputs: Array<{ name: string; type: string; content?: string; bytes?: number }>) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          await navigator.serviceWorker.ready;
          return Boolean(navigator.serviceWorker.controller);
        }),
      { timeout: 20_000 }
    )
    .toBe(true);
  await page.evaluate(() => {
    const form = document.createElement("form");
    form.id = "pwa-share-target-test-form";
    form.action = "/share-target";
    form.method = "POST";
    form.enctype = "multipart/form-data";
    const fileInput = document.createElement("input");
    fileInput.id = "pwa-share-target-test-files";
    fileInput.type = "file";
    fileInput.name = "research_files";
    fileInput.multiple = true;
    form.append(fileInput);
    document.body.append(form);
  });
  await page.locator("#pwa-share-target-test-files").setInputFiles(
    inputs.map((input) => ({
      name: input.name,
      mimeType: input.type,
      buffer: input.bytes ? Buffer.alloc(input.bytes) : Buffer.from(input.content ?? "")
    }))
  );
  await Promise.all([page.waitForURL((url) => url.searchParams.has("share") || url.searchParams.has("share_error"), { timeout: 20_000 }), page.locator("#pwa-share-target-test-form").evaluate((form: HTMLFormElement) => form.requestSubmit())]);
  return page.url();
}

async function hasPendingSharedFiles(page: Page, token: string) {
  return page.evaluate(async (shareToken) => {
    const registration = await navigator.serviceWorker.ready;
    const worker = navigator.serviceWorker.controller ?? registration.active;
    if (!worker) return false;
    return new Promise<boolean>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => resolve(event.data?.ok === true);
      worker.postMessage({ type: "saltanat:share-target:load", token: shareToken }, [channel.port2]);
    });
  }, token);
}

async function openChartAnalysis(page: Page) {
  const analysis = page.locator("details.session-liquidity-badge").first();
  await expect(analysis).toBeVisible({ timeout: 20_000 });
  if ((await analysis.getAttribute("open")) === null) await analysis.locator("summary").click();
  await expect(analysis).toHaveAttribute("open", "");
}

async function selectChartSymbol(page: Page, symbol: string) {
  await expect(page.getByRole("button", { name: "Open command palette" })).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  const search = palette.getByPlaceholder("Search symbols, timeframes, chart types, actions...");
  await search.fill(symbol);
  await expect(palette.getByRole("option").filter({ hasText: symbol }).first()).toBeVisible({ timeout: 20_000 });
  await search.press("Enter");
  await expect(page.getByRole("button", { name: new RegExp(`Current instrument ${symbol}`, "i") })).toBeVisible();
}

function pluginXml(name: string) {
  return `<xml xmlns="https://developers.google.com/blockly/xml"><block type="strategy_start"><field name="NAME">${name}</field></block></xml>`;
}
