import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test("keeps the RU/KK arbitrage screener keyboard and screen-reader operable on mobile at 200% text size", { tag: "@smoke" }, async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("sbv2:locale", "ru"));
  await installScannerMocks(page);
  await page.goto("/");
  await page.locator("html").evaluate((element) => {
    element.style.fontSize = "200%";
  });

  const ruWorkspace = page.locator(".workspace-navigation");
  const ruScreener = ruWorkspace.getByRole("button", { name: "Скринер", exact: true });
  await ruScreener.focus();
  await expect(ruScreener).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { name: "Арбитражный скринер спот/фьючерс" })).toBeVisible();
  const ruBasisTable = page.getByRole("table", { name: "Исследовательские внутрибиржевые и межбиржевые кандидаты спот/фьючерс" });
  await expect(ruBasisTable.getByRole("row").filter({ hasText: "BTCUSDT" })).toBeVisible();
  const search = page.getByLabel("Поиск пары");
  await search.focus();
  await page.keyboard.type("BTC");
  await expect(search).toHaveValue("BTC");
  await page.getByText("Комиссии, алерты и симуляция", { exact: true }).click();
  await expect(page.getByLabel("Binance — спот")).toBeVisible();
  await expect(page.getByLabel("Binance — бессрочный фьючерс")).toBeVisible();
  await expect(page.locator(".arb-workspace")).not.toContainText("Binance spot");
  await expect(page.locator(".arb-workspace")).not.toContainText("Binance perpetual");

  const modeTrigger = page.locator(".arb-mode-trigger");
  await expect(modeTrigger).toBeVisible();
  await expect(modeTrigger).toHaveAttribute("aria-expanded", "false");
  expect(await page.locator(".arb-mode-bar").evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(100);

  const ruModes = page.getByRole("group", { name: "Режим арбитражного скринера" });
  await modeTrigger.click();
  await expect(modeTrigger).toHaveAttribute("aria-expanded", "true");
  const triangular = ruModes.getByRole("button", { name: "Треугольный", exact: true });
  await triangular.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".arb-mode-switch button[aria-pressed=true]")).toHaveText("Треугольный");
  await expect(modeTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(modeTrigger).toBeFocused();
  await expect(page.getByRole("table", { name: "Top-book симуляции маршрутов из трёх ног" })).toBeVisible();
  await expect(page.getByText("Binance · спот · 3 ноги", { exact: true })).toBeVisible();
  await expect(page.locator(".arb-workspace")).not.toContainText("Binance · spot · 3 legs");

  await modeTrigger.click();
  const native = ruModes.getByRole("button", { name: "Нативные спреды Bybit", exact: true });
  await native.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".arb-mode-switch button[aria-pressed=true]")).toHaveText("Нативные спреды Bybit");
  await expect(page.getByRole("table", { name: "Биржевые котировки двухногих комбинаций" })).toBeVisible();
  await expect(page.getByText("Bybit · спред-торговля · публичный API", { exact: true })).toBeVisible();
  await expect(page.locator(".arb-workspace")).not.toContainText("Bybit · Spread Trading · public API");

  const mobileTools = page.getByRole("button", { name: "Дополнительные инструменты" });
  await mobileTools.click();
  await expect(mobileTools).toHaveAttribute("aria-expanded", "true");
  const locale = page.getByRole("button", { name: "Переключить язык интерфейса на казахский" });
  await expect(locale).toBeVisible();
  await locale.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("lang", "kk");
  await expect(page.getByRole("heading", { name: "Bybit нативті спред стаканы" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Екі аяқты комбинацияның биржалық котировкалары" })).toBeVisible();
  await expect(page.getByText("Bybit · спред саудасы · ашық API", { exact: true })).toBeVisible();

  const kkModes = page.getByRole("group", { name: "Арбитраж скринерінің режимі" });
  await modeTrigger.click();
  const kkTriangular = kkModes.getByRole("button", { name: "Үшбұрышты", exact: true });
  await kkTriangular.click();
  await expect(page.getByText("Binance · спот · 3 аяқ", { exact: true })).toBeVisible();
  await expect(page.locator(".arb-workspace")).not.toContainText("Binance · spot · 3 legs");

  await modeTrigger.click();
  const kkBasis = kkModes.getByRole("button", { name: "Spot ↔ perpetual", exact: true });
  await kkBasis.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".arb-mode-switch button[aria-pressed=true]")).toHaveText("Spot ↔ perpetual");
  await expect(page.getByRole("heading", { name: "Spot/perpetual арбитраж скринері" })).toBeVisible();
  const kkBasisTable = page.getByRole("table", { name: "Биржаішілік және биржааралық spot/perpetual зерттеу кандидаттары" });
  await expect(kkBasisTable.getByRole("row").filter({ hasText: "BTCUSDT" })).toBeVisible();
  await page.getByText("Комиссиялар, alert және симуляция", { exact: true }).click();
  await expect(page.getByLabel("Binance — мерзімсіз фьючерс")).toBeVisible();
  await expect(page.locator(".arb-workspace")).not.toContainText("Binance perpetual");

  const layout = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".arb-table-shell");
    const workspace = document.querySelector<HTMLElement>(".arb-workspace");
    if (!shell || !workspace) throw new Error("arbitrage workspace is missing");
    const workspaceBounds = workspace.getBoundingClientRect();
    return {
      documentFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      tableScrollsInsideItsRegion: getComputedStyle(shell).overflowX !== "visible" && shell.scrollWidth > shell.clientWidth,
      workspaceFitsViewport: workspaceBounds.left >= -1 && workspaceBounds.right <= innerWidth + 1
    };
  });
  expect(layout).toEqual({ documentFits: true, tableScrollsInsideItsRegion: true, workspaceFitsViewport: true });
  await expectNoAxeViolations(page);
});

test("keeps the screener mode chooser compact across the complete mobile breakpoint", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("sbv2:locale", "ru"));
  await installScannerMocks(page);
  await page.goto("/");
  await page.locator(".workspace-navigation").getByRole("button", { name: "Скринер", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Арбитражный скринер спот/фьючерс" })).toBeVisible();

  const trigger = page.locator(".arb-mode-trigger");
  for (const width of [320, 390, 600, 760]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1))
      .toBe(true);
    expect(await page.locator(".arb-mode-bar").evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(80);
  }

  await page.setViewportSize({ width: 761, height: 844 });
  await expect(trigger).toBeHidden();
  await expect(page.getByRole("group", { name: "Режим арбитражного скринера" })).toBeVisible();
});

async function installScannerMocks(page: Page) {
  await page.routeWebSocket("/arbitrage-stream", () => {
    // REST provides the deterministic snapshot; the open socket prevents reconnect churn.
  });
  await page.route("**/api/arbitrage**", async (route) => {
    const url = new URL(route.request().url());
    const updatedAt = Date.now();
    if (url.pathname.endsWith("/lifecycle")) {
      await route.fulfill({
        json: {
          schemaVersion: 1,
          readOnly: true,
          executionPermission: false,
          generatedAt: updatedAt,
          runtime: { acceptedSnapshots: 1, rejectedSnapshots: 0, lastAcceptedAt: updatedAt },
          summary: { universeCount: 0, retainedRoutes: 0, matchedRoutes: 0, returnedRoutes: 0, routesTruncated: false, retainedEvents: 0, matchedEvents: 0, returnedEvents: 0, eventsTruncated: false, nextEventSequence: 1 },
          universes: [],
          routes: [],
          events: []
        }
      });
      return;
    }
    if (url.pathname.endsWith("/clock-health")) {
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
    if (url.pathname.endsWith("/triangular")) {
      await route.fulfill({
        json: {
          updatedAt,
          venue: "binance",
          startAsset: "USDT",
          requestedStartQuantity: 1_000,
          scannedMarkets: 300,
          scannedCycles: 20,
          totalOpportunities: 0,
          truncated: false,
          marketDataMode: "rest-top-book",
          opportunities: []
        }
      });
      return;
    }
    if (url.pathname.endsWith("/native-spreads")) {
      await route.fulfill({
        json: {
          venue: "bybit",
          marketDataMode: "venue-native-spread-orderbook",
          executionModel: "venue-matched-multi-leg",
          readOnly: true,
          updatedAt,
          totalInstruments: 0,
          eligibleInstruments: 0,
          scannedInstruments: 0,
          healthyBooks: 0,
          totalOpportunities: 0,
          truncated: false,
          candidateTruncated: false,
          sourceErrors: [],
          opportunities: []
        }
      });
      return;
    }

    await route.fulfill({ json: basisScan(updatedAt) });
  });
}

function basisScan(capturedAt: number) {
  return {
    updatedAt: capturedAt,
    stale: false,
    scannedSymbols: 1,
    totalOpportunities: 1,
    truncated: false,
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
        spotBid: 99_900,
        spotAsk: 100_000,
        spotAskSize: 1,
        futuresBid: 101_500,
        futuresAsk: 101_600,
        futuresBidSize: 0.5,
        grossSpreadBps: 150,
        estimatedTotalCostBps: 0,
        netEdgeBps: 150,
        topBookCapacityUsd: 50_750,
        fundingRate: 0.0001,
        fundingIntervalMinutes: 480,
        fundingScheduleVerified: true,
        nextFundingTime: capturedAt + 3_600_000,
        spotExchangeTs: capturedAt,
        spotExchangeTimestampVerified: true,
        spotReceivedAt: capturedAt,
        futuresExchangeTs: capturedAt,
        futuresExchangeTimestampVerified: true,
        futuresReceivedAt: capturedAt,
        quoteAgeMs: 0,
        legSkewMs: 0,
        dataQuality: "fresh",
        capturedAt
      }
    ]
  };
}

async function expectNoAxeViolations(page: Page) {
  const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(audit.violations, audit.violations.map((item) => `${item.id}: ${item.help} (${item.nodes.length})`).join("\n")).toEqual([]);
}
