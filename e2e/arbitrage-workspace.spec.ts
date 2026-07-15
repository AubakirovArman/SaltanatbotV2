import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

test("persists bounded scanner presets, columns, heatmap and route comparison across all scanner modes", { tag: "@smoke" }, async ({ page, browserName }) => {
  // Firefox needs more headroom for the full six-mode journey plus axe and reload.
  test.setTimeout(120_000);
  await installMocks(page);
  await page.goto("/");
  await page.getByRole("navigation", { name: "Primary workspaces" }).getByRole("button", { name: "Screener", exact: true }).click();

  const workspace = page.getByRole("region", { name: "Scanner workspace" });
  await expect(workspace).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Opportunity lifecycle" })).toContainText("read-only research state");

  await page.getByText("How 2-leg, 3-leg and intra-exchange routes differ").click();
  const forkGuide = page.locator(".arb-fork-guide");
  await expect(forkGuide).toContainText("Double / pairwise");
  await expect(forkGuide).toContainText("Triple / triangular");
  await expect(forkGuide).toContainText("A “fork” is a route hypothesis, not guaranteed profit");
  await captureAuditStep(page, "01-fork-guide.png");
  await page.getByText("How 2-leg, 3-leg and intra-exchange routes differ").click();

  await workspace.getByRole("checkbox", { name: "Funding" }).uncheck();
  await expect(page.getByRole("table", { name: /spot\/perpetual research candidates/ }).getByRole("columnheader", { name: "Funding rate" })).toHaveCount(0);
  await page.getByLabel("Minimum top-book capacity").fill("0");
  await page.getByLabel("Search pair").fill("ETH");
  await workspace.getByLabel("Preset name").fill("Low-cap ETH");
  await workspace.getByRole("button", { name: "Save preset" }).click();
  await expect(workspace.getByLabel("Saved presets")).toHaveValue(/preset-/);

  await page.getByLabel("Search pair").fill("BTC");
  await workspace.getByLabel("Saved presets").selectOption({ label: "Low-cap ETH" });
  await expect(page.getByLabel("Search pair")).toHaveValue("ETH");
  await page.getByLabel("Search pair").fill("");

  await workspace.getByRole("button", { name: "Heatmap" }).click();
  const heatmap = page.getByRole("figure", { name: "Opportunity heatmap" });
  await expect(heatmap).toContainText("BTCUSDT");
  await expect(heatmap).toContainText("Rank 1");
  await workspace.getByRole("button", { name: "Route compare" }).click();
  await expect(page.getByRole("img", { name: "Route graph for BTCUSDT" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Current snapshot comparison" })).toContainText("ETHUSDT");

  const modes = page.getByRole("group", { name: "Arbitrage scanner mode" });
  await modes.getByRole("button", { name: "Triangular" }).click();
  const triangularWorkspace = page.getByRole("region", { name: "Scanner workspace" });
  await triangularWorkspace.getByRole("button", { name: "Heatmap" }).click();
  await expect(page.getByRole("figure", { name: "Opportunity heatmap" })).toContainText("USDT → BTC → ETH → USDT");
  await triangularWorkspace.getByRole("button", { name: "Route compare" }).click();
  await expect(page.getByRole("img", { name: /Route graph for USDT → BTC → ETH → USDT/ })).toBeVisible();
  await triangularWorkspace.getByRole("button", { name: "Table" }).click();
  await page.getByRole("button", { name: "Verify this route with sequence-reconstructed L2 depth" }).first().click();
  const depthProof = page.locator(".arb-depth-verification");
  await expect(depthProof).toContainText("Route passed sequence-verified depth simulation");
  await expect(depthProof).toContainText("BTCUSDT #101 · g7");
  await expect(depthProof).toContainText("no API keys, balances or orders are used");

  await modes.getByRole("button", { name: "Bybit native spreads" }).click();
  const nativeWorkspace = page.getByRole("region", { name: "Scanner workspace" });
  await nativeWorkspace.getByRole("button", { name: "Heatmap" }).click();
  await expect(page.getByRole("figure", { name: "Opportunity heatmap" })).toContainText("SOLUSDT_SOL/USDT");
  await nativeWorkspace.getByRole("button", { name: "Route compare" }).click();
  await expect(page.getByRole("table", { name: "Current snapshot comparison" })).toContainText("BTCUSDT_BTC/USDT");

  await modes.getByRole("button", { name: "Options parity" }).click();
  await expect(page.getByRole("heading", { name: "European options parity lab" })).toBeVisible();
  await expect(page.getByText(/Visible-depth research only/)).toBeVisible();
  await page.getByRole("button", { name: "Evaluate scenario" }).click();
  const optionsResults = page.getByRole("table", { name: "Research candidates" });
  await expect(optionsResults).toContainText("put-call-parity");
  await expect(optionsResults).toContainText("synthetic-forward");
  await expect(page.locator(".options-parity-workbench")).not.toContainText("Place order");

  await modes.getByRole("button", { name: "Funding stress" }).click();
  await expect(page.getByRole("heading", { name: "Funding curve scenario lab" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: /^Instrument 1/ })).toHaveValue("okx:perpetual:BTC-USDT-SWAP");
  await expect(page.getByRole("combobox", { name: /^Instrument 2/ })).toHaveValue("gate:perpetual:BTC_USDT");
  await page.getByRole("button", { name: "Build funding curve" }).click();
  await expect(page.getByRole("table", { name: "Point-in-time funding scenarios" })).toContainText("BTC-USDT-SWAP");
  await expect(page.getByRole("complementary", { name: "Largest reviewed funding-rate gap" })).toContainText("6 bp over the selected horizon");
  await expect(page.locator(".funding-curve-workbench")).not.toContainText("Place order");
  await captureAuditStep(page, "02-funding-scenarios.png");

  await modes.getByRole("button", { name: "Live routes" }).click();
  await expect(page.getByRole("heading", { name: "Continuous multi-venue routes" })).toBeVisible();
  await expect(page.locator(".arb-live-coverage")).toContainText("complete and current");
  await expect(page.locator(".arb-live-coverage")).toContainText("all configured instruments were evaluated from the current registry refresh");
  const publicSourceHealth = page.getByRole("region", { name: "Public source health", exact: true });
  await expect(publicSourceHealth).toContainText("okx:spot:BTC-USDT");
  await expect(publicSourceHealth).toContainText("dydx:perpetual:BTC-USD");
  await expect(publicSourceHealth).toContainText("kucoin:spot:BTC-USDT");
  await expect(publicSourceHealth).toContainText("mexc:spot:BTCUSDT");
  const venueFilter = page.getByRole("combobox", { name: "Venue filter", exact: true });
  await expect(venueFilter).toContainText("dydx");
  await expect(venueFilter).toContainText("kucoin");
  await expect(venueFilter).toContainText("mexc");
  await expect(page.getByRole("region", { name: "Research candidates", exact: true })).toContainText("cross-venue-spot-spot");
  await expect(page.getByText("read-only research", { exact: true })).toBeVisible();
  const continuousEconomics = page.getByRole("region", { name: "Observed market economics table", exact: true });
  await expect(continuousEconomics).toContainText("market-only");
  await expect(continuousEconomics).toContainText("maximum visible top-book capacity");
  await expect(continuousEconomics).toContainText("2 BTC");
  await expect(continuousEconomics).toContainText("Entry basis after estimated fees");
  await expect(continuousEconomics).toContainText("+188.02 bps");
  await expect(continuousEconomics).toContainText("public taker · quote-equivalent estimate");
  await expect(continuousEconomics).toContainText("fee asset and exposure impact are not verified");
  await expect(continuousEconomics).toContainText("canonical-registry · registry-v1 · valid until");
  await expect(continuousEconomics).toContainText("verified account capital is missing");
  await expect(continuousEconomics).toContainText("verified sell-side inventory is missing");
  await expect(continuousEconomics).toContainText("network availability, fees and rebalance proof are missing");
  await expect(continuousEconomics).toContainText("calibrated venue-time interval");
  await expect(page.getByText("orders not permitted", { exact: true }).first()).toBeVisible();
  const continuousWorkspace = page.locator(".arb-live-routes");
  await expect(continuousWorkspace).not.toContainText("Place order");
  await expect(continuousWorkspace.getByRole("button", { name: /^(?:place|submit|execute)\b.*\border/i })).toHaveCount(0);

  // The DOM ruleset is browser-independent and is covered once in Chromium;
  // Firefox smoke stays focused on native interaction, navigation and persistence.
  if (browserName === "chromium") await expectNoAxeViolations(page);

  // Firefox can keep the production PWA load event pending while the service-worker
  // hand-off settles; DOM readiness is the state this persistence assertion needs.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("navigation", { name: "Primary workspaces" }).getByRole("button", { name: "Screener", exact: true }).click();
  const restored = page.getByRole("region", { name: "Scanner workspace" });
  await expect(restored.getByLabel("Saved presets")).toContainText("Low-cap ETH");
  await expect(restored.getByRole("button", { name: "Route compare" })).toHaveAttribute("aria-pressed", "true");
  await expect(restored.getByRole("checkbox", { name: "Funding" })).not.toBeChecked();
});

async function installMocks(page: Page) {
  await page.routeWebSocket("/arbitrage-stream", () => {
    // Deterministic REST owns this journey; an open routed socket prevents reconnect churn.
  });
  await page.route("**/api/instruments**", (route) => route.fulfill({ json: fundingInstruments(Date.now()) }));
  await page.route("**/api/venues", (route) => route.fulfill({ json: fundingVenues(Date.now()) }));
  await page.route("**/api/arbitrage**", async (route) => {
    const url = new URL(route.request().url());
    const now = Date.now();
    if (url.pathname.endsWith("/clock-health")) return route.fulfill({ json: clockHealth(now) });
    if (url.pathname.endsWith("/lifecycle")) return route.fulfill({ json: lifecycle(now) });
    if (url.pathname.endsWith("/route-families/live")) return route.fulfill({ json: continuousRoutes(now) });
    if (url.pathname.endsWith("/options-parity/evaluate")) return route.continue();
    if (url.pathname.endsWith("/funding-curve/universe")) return route.fulfill({ json: fundingUniverse(now) });
    if (url.pathname.endsWith("/funding-curve")) return route.fulfill({ json: fundingCurve(now) });
    if (url.pathname.endsWith("/triangular/verify-depth")) return route.fulfill({ json: triangularDepth(now) });
    if (url.pathname.endsWith("/triangular")) return route.fulfill({ json: triangular(now) });
    if (url.pathname.endsWith("/native-spreads")) return route.fulfill({ json: nativeSpreads(now) });
    return route.fulfill({ json: basis(now) });
  });
}

async function captureAuditStep(page: Page, name: string) {
  const directory = process.env.CAPTURE_UX_AUDIT;
  if (!directory) return;
  await page.evaluate(async () => document.fonts.ready);
  await page.screenshot({ path: path.join(directory, name), fullPage: true, animations: "disabled" });
}

function fundingInstruments(now: number) {
  return {
    updatedAt: now,
    checkedAt: now,
    stale: false,
    includeStale: false,
    total: 2,
    truncated: false,
    sourceErrors: [],
    sourceStates: ["okx", "gate"].map((source) => ({ source, status: "fresh", receivedAt: now, checkedAt: now, ageMs: 0 })),
    instruments: [registryPerpetual("okx", "okx:perpetual:BTC-USDT-SWAP", "BTC-USDT-SWAP"), registryPerpetual("gate", "gate:perpetual:BTC_USDT", "BTC_USDT")]
  };
}

function fundingVenues(now: number) {
  const capability = (venue: string) => ({
    venue,
    publicData: true,
    spot: true,
    margin: false,
    perpetual: true,
    datedFuture: false,
    option: false,
    nativeSpread: false,
    topBook: true,
    depth: true,
    publicTrades: false,
    funding: true,
    borrow: false,
    depositWithdrawal: false,
    privateExecution: false,
    demoEnvironment: false
  });
  return {
    updatedAt: now,
    checkedAt: now,
    stale: false,
    sourceErrors: [],
    sourceStates: ["okx", "gate"].map((source) => ({ source, status: "fresh", receivedAt: now, checkedAt: now, ageMs: 0 })),
    capabilities: [capability("okx"), capability("gate")]
  };
}

function fundingUniverse(now: number) {
  return {
    engine: "funding-curve-universe-v1",
    readOnly: true,
    researchOnly: true,
    executable: false,
    updatedAt: now,
    stale: false,
    contract: {
      owner: "server",
      adapterRegistry: "publicVenueAdapters",
      instruments: "fresh-verified-trading-perpetuals",
      execution: "none"
    },
    economicIdentityCatalog: {
      schemaVersion: 1,
      source: "deterministic E2E reviewed identity fixture",
      version: "e2e-v1",
      asOf: now - 60_000,
      validUntil: now + 60_000
    },
    supportedVenues: ["gate", "okx"],
    total: 2,
    truncated: false,
    instruments: [registryPerpetual("gate", "gate:perpetual:BTC_USDT", "BTC_USDT"), registryPerpetual("okx", "okx:perpetual:BTC-USDT-SWAP", "BTC-USDT-SWAP")],
    sourceErrors: []
  };
}

function registryPerpetual(venue: string, id: string, venueSymbol: string) {
  return {
    id,
    assetId: `${venue}:BTC`,
    economicAssetId: "crypto:bitcoin",
    venue,
    venueSymbol,
    baseAsset: "BTC",
    quoteAsset: "USDT",
    settleAsset: "USDT",
    marketType: "perpetual",
    contractDirection: "linear",
    contractMultiplier: 1,
    quantityUnit: "base",
    tickSize: 0.1,
    quantityStep: 0.001,
    minimumQuantity: 0.001,
    minimumNotional: 1,
    status: "trading",
    fundingIntervalMinutes: 480
  };
}

function fundingCurve(now: number) {
  const interval = 480;
  const intervalMs = interval * 60_000;
  const fundingTime = now + 60 * 60_000;
  const horizonEnd = now + 24 * 60 * 60_000;
  const curve = (venue: "okx" | "gate", instrumentId: string, rate: number) => {
    const settlements = [0, 1, 2].map((offset) => ({
      settlementAt: fundingTime + offset * intervalMs,
      baseRate: rate,
      baseRateBps: rate * 10_000,
      rateUnit: "decimal-per-settlement",
      rateSource: offset === 0 ? "current-estimate" : "latest-estimate-persistence"
    }));
    const scenario = (id: "down" | "base" | "up", bumpBps: number) => {
      const stressed = rate + bumpBps / 10_000;
      return {
        id,
        bumpBps,
        unit: "basis-points-additive-per-settlement",
        settlementCount: settlements.length,
        cumulativeRate: stressed * settlements.length,
        averageRatePerSettlement: stressed,
        outsidePublishedMinimumCount: 0,
        outsidePublishedMaximumCount: 0
      };
    };
    return {
      venue,
      instrumentId,
      marketType: "perpetual",
      rateUnit: "decimal-per-settlement",
      rateSignConvention: "positive-longs-pay-shorts",
      projectionSemantics: "rate-sum-only-no-notional-or-pnl",
      freshness: {
        status: "fresh",
        clockBasis: "calibrated-venue-interval",
        crossVenueComparable: true,
        observedAt: now - 10,
        ageMs: 10,
        maxAgeMs: 60_000,
        ageLowerMs: 10,
        ageUpperMs: 10,
        clockLeg: { sourceId: `${venue}:public`, exchangeTs: now - 10, clockStatus: "calibrated", ageLowerMs: 10, ageUpperMs: 10, localEventEarliestAt: now - 10, localEventLatestAt: now - 10 }
      },
      schedule: { verified: true, interval, unit: "minutes", fundingTime, nextFundingTime: fundingTime + intervalMs },
      current: { settlementAt: fundingTime, estimateRate: rate, estimateRateBps: rate * 10_000, rateUnit: "decimal-per-settlement" },
      history: [],
      settlements,
      scenarios: [scenario("down", -1), scenario("base", 0), scenario("up", 1)],
      source: {
        adapter: "publicVenueAdapters",
        operation: "funding",
        public: true,
        credentialed: false,
        exchangeTs: now - 10,
        receivedAt: now - 10,
        historyComplete: true,
        sourceErrors: [],
        sourceErrorsTruncated: false
      }
    };
  };
  return {
    engine: "funding-curve-v1",
    readOnly: true,
    researchOnly: true,
    executable: false,
    evaluatedAt: now,
    horizonEnd,
    contract: {
      source: "credential-free-public-venue-adapters",
      rateUnit: "decimal-per-settlement",
      stressUnit: "basis-points-additive-per-settlement",
      scheduleRequirement: "adapter-verified-discrete-settlements",
      projection: "point-in-time-estimate-persistence",
      pnl: "not-computed-without-explicit-notional-and-price-path",
      execution: "none"
    },
    crossVenueClock: {
      status: "eligible",
      eligible: true,
      clockBasis: "calibrated-venue-interval",
      comparedVenueCount: 2,
      calibratedVenueCount: 2,
      maxSkewMs: 2_000,
      maximumPossibleSkewMs: 0
    },
    curves: [curve("okx", "okx:perpetual:BTC-USDT-SWAP", 0.0001), curve("gate", "gate:perpetual:BTC_USDT", 0.0003)],
    rejections: []
  };
}

function triangularDepth(now: number) {
  const symbols = ["BTCUSDT", "ETHBTC", "ETHUSDT"] as const;
  const leg = (index: 0 | 1 | 2, symbol: string, side: "buy" | "sell", fromAsset: string, toAsset: string, inputQuantity: number, orderBaseQuantity: number, price: number, outputQuantity: number) => ({
    index,
    marketId: `binance:spot:${symbol}`,
    symbol,
    side,
    fromAsset,
    toAsset,
    inputQuantity,
    inputConsumedQuantity: inputQuantity,
    inputDustQuantity: 0,
    orderBaseQuantity,
    averagePrice: price,
    worstPrice: price,
    quoteNotional: orderBaseQuantity * price,
    grossOutputQuantity: outputQuantity,
    feeBps: 0,
    feeQuantity: 0,
    feeAsset: toAsset,
    outputQuantity,
    levelsUsed: 1,
    exchangeTs: now - 10,
    exchangeTimestampVerified: true,
    receivedAt: now - 5
  });
  return {
    schemaVersion: 1,
    readOnly: true,
    researchOnly: true,
    executable: false,
    execution: "none",
    verificationStatus: "sequence-verified-paper-candidate",
    marketDataMode: "sequence-verified-depth",
    venue: "binance",
    startAsset: "USDT",
    requestedStartQuantity: 1_000,
    symbols,
    evaluatedAt: now,
    books: symbols.map((symbol, index) => ({
      symbol,
      sequence: 101 + index,
      connectionGeneration: 7,
      exchangeTs: now - 10,
      receivedAt: now - 5,
      retainedDepth: 100,
      source: "websocket-reconstructed",
      sequenceVerified: true
    })),
    totalOpportunities: 1,
    opportunities: [
      {
        id: "triangular:binance:USDT:BTCUSDT:ETHBTC:ETHUSDT",
        strategyKind: "triangular",
        edgeKind: "executable-sequential",
        executionStatus: "executable",
        marketDataMode: "sequence-verified-depth",
        sequenceVerified: true,
        venue: "binance",
        cycleId: "binance:USDT:BTCUSDT:ETHBTC:ETHUSDT",
        startAsset: "USDT",
        endAsset: "USDT",
        requestedStartQuantity: 1_000,
        startQuantity: 1_000,
        grossEndQuantity: 1_040,
        endQuantity: 1_040,
        grossReturnBps: 400,
        netReturnBps: 400,
        limitingCapacity: { requestedStartQuantity: 1_000, executableStartQuantity: 1_000, utilizationPct: 100 },
        legs: [leg(0, "BTCUSDT", "buy", "USDT", "BTC", 1_000, 10, 100, 10), leg(1, "ETHBTC", "buy", "BTC", "ETH", 10, 200, 0.05, 200), leg(2, "ETHUSDT", "sell", "ETH", "USDT", 200, 200, 5.2, 1_040)],
        dustByAsset: {},
        timestamps: {
          evaluatedAt: now,
          oldestExchangeTs: now - 10,
          newestExchangeTs: now - 10,
          oldestReceivedAt: now - 5,
          newestReceivedAt: now - 5,
          quoteAgeMs: 10,
          legSkewMs: 0,
          exchangeTimestampsVerified: true
        },
        riskFlags: ["sequential-leg-risk", "output-fee-assumption"]
      }
    ],
    rejections: []
  };
}

function continuousRoutes(now: number) {
  const first = "okx:spot:BTC-USDT";
  const second = "gate:spot:BTC_USDT";
  const dydx = "dydx:perpetual:BTC-USD";
  const kucoin = "kucoin:spot:BTC-USDT";
  const mexc = "mexc:spot:BTCUSDT";
  const routeId = "rf:cross-venue-spot-spot:9f8981c777e987bff71923f8";
  const longBook = continuousTopBook("okx", first, "spot", "okx-seqid", 99, 100, now - 20, now - 10);
  const shortBook = continuousTopBook("gate", second, "spot", "gate-update-id", 102, 103, now - 18, now - 8);
  const longSourceId = `okx:public-websocket:${first}:okx-seqid:generation-1`;
  const shortSourceId = `gate:public-websocket:${second}:gate-update-id:generation-1`;
  return {
    schemaVersion: 1,
    engine: "continuous-route-runtime-v1",
    readOnly: true,
    executionStatus: "research-only",
    executable: false,
    configurationSource: "operator-environment",
    state: "live",
    coverage: { complete: true, current: true, retainedPriorDiscovery: false, reason: "complete" },
    evaluatedAt: now,
    refreshedAt: now - 10,
    configuredInstrumentIds: [first, second, dydx, kucoin, mexc],
    activeInstrumentIds: [first, second, dydx, kucoin, mexc],
    unavailable: [],
    discovery: {
      engine: "continuous-route-discovery-v1",
      executionStatus: "research-only",
      executable: false,
      capturedAt: now,
      totalCompatibleCandidates: 1,
      truncated: false,
      candidates: [
        {
          routeKey: JSON.stringify(["cross-venue-spot-spot", first, second]),
          routeId,
          family: "cross-venue-spot-spot",
          longInstrumentId: first,
          shortInstrumentId: second,
          longMarketType: "spot",
          shortMarketType: "spot",
          economicAssetId: "crypto:bitcoin",
          edgeKind: "research-candidate",
          executable: false
        }
      ],
      instruments: [continuousInstrument("okx", first, "BTC-USDT", now), continuousInstrument("gate", second, "BTC_USDT", now)],
      routeReadyBooks: [continuousReadyBook(longBook, longSourceId), continuousReadyBook(shortBook, shortSourceId)],
      topBooks: [longBook, shortBook],
      fundingObservations: [],
      excludedBooks: [],
      rejectedInstruments: [],
      marketEconomics: {
        engine: "continuous-market-economics-v1",
        readOnly: true,
        researchOnly: true,
        executable: false,
        outcomeClass: "projected",
        evaluatedAt: now,
        totalCandidates: 1,
        evaluatedCandidates: 1,
        marketOnlyCandidates: 1,
        blockedCandidates: 0,
        publishedEvaluations: 1,
        publishedMarketOnlyCandidates: 1,
        publishedBlockedCandidates: 0,
        truncated: false,
        feePolicy: {
          version: "continuous-public-taker-fee-v1",
          source: "operator-environment",
          liquidity: "taker",
          discountsApplied: false,
          rebatesApplied: false,
          feeAssetVerified: false,
          exposureImpactIncluded: false,
          coverage: "entry-only"
        }
      },
      marketEvaluations: [
        {
          engine: "continuous-market-economics-v1",
          readOnly: true,
          researchOnly: true,
          executable: false,
          outcomeClass: "projected",
          strategyStatus: "blocked",
          evaluatedAt: now,
          routeId,
          family: "cross-venue-spot-spot",
          longInstrumentId: first,
          shortInstrumentId: second,
          economicAssetId: "crypto:bitcoin",
          baseAsset: "BTC",
          quoteAsset: "USDT",
          executionBoundary: { permission: false, orders: "not-supported", reason: "market-data-and-public-entry-fees-only" },
          status: "market-only",
          blockedReasons: [
            { code: "account-capital-missing", stage: "strategy-evidence", subject: first, message: "Verified account capital is not connected." },
            { code: "account-inventory-missing", stage: "strategy-evidence", subject: second, message: "Verified sell-side inventory is not connected." },
            { code: "network-rebalance-missing", stage: "strategy-evidence", subject: routeId, message: "Network availability, fees and rebalance evidence are not connected." }
          ],
          legs: [continuousMarketLeg("long", "buy", "okx", "BTC-USDT", first, longBook, 100, 200, 0.1, longSourceId), continuousMarketLeg("short", "sell", "gate", "BTC_USDT", second, shortBook, 102, 204, 0.102, shortSourceId)],
          capacity: {
            scope: "maximum-visible-top-book",
            matchedBaseQuantity: 2,
            commonBaseQuantity: 2,
            referenceNotionalQuote: 202,
            longAlignedBaseCapacity: 2,
            shortAlignedBaseCapacity: 2
          },
          edges: {
            grossEntryValueDifferenceQuote: 4,
            grossEntryBasisBps: (4 / 202) * 10_000,
            publicEntryFeesQuoteEquivalentEstimate: 0.202,
            netEntryValueDifferenceAfterEstimatedFeesQuote: 3.798,
            netEntryBasisAfterEstimatedFeesBps: (3.798 / 202) * 10_000,
            coverage: "top-book-entry-and-public-taker-fees-only"
          },
          freshness: {
            status: "fresh",
            clockBasis: "calibrated-venue-interval",
            crossVenueComparable: true,
            quoteAgeMs: 20,
            legSkewMs: 2,
            maxBookAgeMs: 10_000,
            maxLegSkewMs: 1_000,
            oldestReceivedAt: now - 10,
            newestReceivedAt: now - 8,
            quoteAgeLowerMs: 20,
            quoteAgeUpperMs: 20,
            minimumPossibleLegSkewMs: 2,
            maximumPossibleLegSkewMs: 2,
            clockLegs: [
              { sourceId: "okx:public", exchangeTs: now - 20, clockStatus: "calibrated", ageLowerMs: 20, ageUpperMs: 20, localEventEarliestAt: now - 20, localEventLatestAt: now - 20 },
              { sourceId: "gate:public", exchangeTs: now - 18, clockStatus: "calibrated", ageLowerMs: 18, ageUpperMs: 18, localEventEarliestAt: now - 18, localEventLatestAt: now - 18 }
            ]
          },
          evidence: {
            marketDataComplete: true,
            continuityVerified: true,
            requiredStrategyEvidenceComplete: false,
            sourceIds: [longSourceId, shortSourceId],
            economicIdentities: [continuousEconomicIdentity(first, now), continuousEconomicIdentity(second, now)]
          }
        }
      ],
      sources: [
        { instrument: { venue: "okx", instrumentId: first, venueSymbol: "BTC-USDT", marketType: "spot", quantityUnit: "base" }, status: { venue: "okx", instrumentId: first, state: "live", message: "sequence-ready book", generation: 1 }, topBook: longBook },
        { instrument: { venue: "gate", instrumentId: second, venueSymbol: "BTC_USDT", marketType: "spot", quantityUnit: "base" }, status: { venue: "gate", instrumentId: second, state: "live", message: "sequence-ready book", generation: 1 }, topBook: shortBook },
        {
          instrument: { venue: "dydx", instrumentId: dydx, venueSymbol: "BTC-USD", marketType: "perpetual", quantityUnit: "base" },
          status: { venue: "dydx", instrumentId: dydx, state: "live", message: "non-canonical Indexer book", generation: 1 },
          book: {
            venue: "dydx",
            instrumentId: dydx,
            venueSymbol: "BTC-USD",
            marketType: "perpetual",
            quantityUnit: "base",
            bids: [[99, 1]],
            asks: [[101, 1]],
            exchangeTs: now - 15,
            receivedAt: now - 15,
            complete: true,
            continuity: { kind: "sequence-observed", sequence: 10, protocol: "dydx-indexer-message-id", sequenceVerified: false },
            source: "public-websocket",
            connectionGeneration: 1,
            retainedDepth: 100
          }
        },
        {
          instrument: { venue: "kucoin", instrumentId: kucoin, venueSymbol: "BTC-USDT", marketType: "spot", quantityUnit: "base" },
          status: { venue: "kucoin", instrumentId: kucoin, state: "live", message: "sequence-ready book", generation: 1 },
          topBook: { ...longBook, venue: "kucoin", instrumentId: kucoin, continuity: { kind: "sequence-verified", sequence: 11, protocol: "kucoin-obu-range" } }
        },
        {
          instrument: { venue: "mexc", instrumentId: mexc, venueSymbol: "BTCUSDT", marketType: "spot", quantityUnit: "base" },
          status: { venue: "mexc", instrumentId: mexc, state: "live", message: "sequence-ready book", generation: 1 },
          topBook: { ...shortBook, venue: "mexc", instrumentId: mexc, continuity: { kind: "sequence-verified", sequence: 12, protocol: "mexc-spot-version" } }
        }
      ]
    }
  };
}

function continuousEconomicIdentity(instrumentId: string, now: number) {
  return {
    instrumentId,
    economicAssetId: "crypto:bitcoin",
    status: "reviewed",
    source: "canonical-registry",
    version: "registry-v1",
    asOf: now - 60_000,
    validUntil: now + 86_400_000
  };
}

function continuousInstrument(venue: "okx" | "gate", instrumentId: string, symbol: string, now: number) {
  return {
    instrumentId,
    venue,
    symbol,
    marketType: "spot",
    baseAsset: "BTC",
    economicAssetId: "crypto:bitcoin",
    economicIdentity: {
      status: "reviewed",
      source: "canonical-registry",
      version: "registry-v1",
      asOf: now - 60_000,
      validUntil: now + 86_400_000
    },
    quoteAsset: "USDT",
    settleAsset: "USDT",
    quantityModel: { unit: "base" },
    quantityStep: 0.001,
    minimumQuantity: 0.001,
    minimumNotional: 1,
    takerFeeBps: 5
  };
}

function continuousTopBook(venue: "okx" | "gate", instrumentId: string, marketType: "spot", protocol: "okx-seqid" | "gate-update-id", bid: number, ask: number, exchangeTs: number, receivedAt: number) {
  return {
    venue,
    instrumentId,
    marketType,
    quantityUnit: "base",
    bid,
    bidSize: 2,
    ask,
    askSize: 2,
    exchangeTs,
    receivedAt,
    continuity: { kind: "sequence-verified", sequence: 10, protocol },
    connectionGeneration: 1
  };
}

function continuousReadyBook(book: ReturnType<typeof continuousTopBook>, sourceId: string) {
  return {
    instrumentId: book.instrumentId,
    quantityUnit: book.quantityUnit,
    bids: [[book.bid, book.bidSize]],
    asks: [[book.ask, book.askSize]],
    exchangeTs: book.exchangeTs,
    receivedAt: book.receivedAt,
    complete: true,
    sequence: book.continuity.sequence,
    source: "websocket",
    sourceId
  };
}

function continuousMarketLeg(role: "long" | "short", side: "buy" | "sell", venue: "okx" | "gate", symbol: string, instrumentId: string, book: ReturnType<typeof continuousTopBook>, price: number, quoteNotional: number, publicEntryFeeQuoteEquivalentEstimate: number, sourceId: string) {
  return {
    role,
    side,
    instrumentId,
    venue,
    symbol,
    marketType: "spot",
    quantityUnit: "base",
    price,
    topNativeQuantity: 2,
    alignedNativeCapacity: 2,
    usedNativeQuantity: 2,
    baseQuantity: 2,
    quoteNotional,
    takerFeeBps: 5,
    publicEntryFeeQuoteEquivalentEstimate,
    feeAssumption: {
      policyVersion: "continuous-public-taker-fee-v1",
      source: "operator-environment",
      accountTierVerified: false,
      discountsApplied: false,
      rebatesApplied: false,
      feeAssetVerified: false,
      exposureImpactIncluded: false
    },
    bookEvidence: {
      sourceId,
      quality: "sequence-verified",
      protocol: book.continuity.protocol,
      sequence: book.continuity.sequence,
      connectionGeneration: book.connectionGeneration,
      exchangeTs: book.exchangeTs,
      receivedAt: book.receivedAt
    }
  };
}

function basis(now: number) {
  return {
    updatedAt: now,
    stale: false,
    scannedSymbols: 2,
    totalOpportunities: 2,
    truncated: false,
    estimatedTotalCostBps: 0,
    sources: [
      { exchange: "binance", market: "spot", ok: true },
      { exchange: "binance", market: "perpetual", ok: true },
      { exchange: "bybit", market: "spot", ok: true },
      { exchange: "bybit", market: "perpetual", ok: true }
    ],
    opportunities: [basisRow(now, "BTCUSDT", "crypto:bitcoin", "binance", "bybit", 100_000, 101_500, 150, 50_750, 0.5), basisRow(now, "ETHUSDT", "crypto:ethereum", "bybit", "binance", 4_000, 4_040, 100, 8_000, 2)]
  };
}

function basisRow(now: number, symbol: string, assetId: string, spotExchange: "binance" | "bybit", futuresExchange: "binance" | "bybit", spotAsk: number, futuresBid: number, spread: number, capacity: number, quantity: number) {
  return {
    id: `${symbol}:${spotExchange}:${futuresExchange}`,
    symbol,
    assetId,
    identityScope: "cross-venue-reviewed",
    spotInstrumentId: `${spotExchange}:spot:${symbol}`,
    futuresInstrumentId: `${futuresExchange}:perpetual:${symbol}`,
    spotExchange,
    futuresExchange,
    spotBid: spotAsk - 1,
    spotAsk,
    spotAskSize: quantity,
    futuresBid,
    futuresAsk: futuresBid + 1,
    futuresBidSize: quantity,
    grossSpreadBps: spread,
    estimatedTotalCostBps: 0,
    netEdgeBps: spread,
    topBookCapacityUsd: capacity,
    topBookMatchedQuantity: quantity,
    expectedNetProfitUsd: (capacity * spread) / 10_000,
    fundingRate: 0.0001,
    fundingIntervalMinutes: 480,
    fundingScheduleVerified: true,
    nextFundingTime: now + 3_600_000,
    spotExchangeTs: now,
    spotExchangeTimestampVerified: true,
    spotReceivedAt: now,
    futuresExchangeTs: now,
    futuresExchangeTimestampVerified: true,
    futuresReceivedAt: now,
    quoteAgeMs: 0,
    legSkewMs: 0,
    dataQuality: "fresh",
    capturedAt: now
  };
}

function triangular(now: number) {
  const route = (id: string, middle: string, end: number, net: number) => ({
    id,
    venue: "binance",
    edgeKind: "non-executable-candidate",
    executionStatus: "non-executable-candidate",
    marketDataMode: "rest-top-book",
    sequenceVerified: false,
    startAsset: "USDT",
    startQuantity: 1_000,
    endQuantity: end,
    grossReturnBps: net + 30,
    netReturnBps: net,
    limitingCapacity: { requestedStartQuantity: 1_000, executableStartQuantity: 900, utilizationPct: 90 },
    legs: [
      { index: 0, symbol: "BTCUSDT", side: "buy", fromAsset: "USDT", toAsset: "BTC", inputQuantity: 900, outputQuantity: 0.009, averagePrice: 100_000, feeBps: 10, levelsUsed: 1 },
      { index: 1, symbol: `${middle}BTC`, side: "buy", fromAsset: "BTC", toAsset: middle, inputQuantity: 0.009, outputQuantity: 0.2, averagePrice: 0.04, feeBps: 10, levelsUsed: 1 },
      { index: 2, symbol: `${middle}USDT`, side: "sell", fromAsset: middle, toAsset: "USDT", inputQuantity: 0.2, outputQuantity: end, averagePrice: 5_000, feeBps: 10, levelsUsed: 1 }
    ],
    timestamps: { evaluatedAt: now, quoteAgeMs: 10, legSkewMs: 2, exchangeTimestampsVerified: false },
    riskFlags: ["sequential-leg-risk", "top-book-only", "rest-snapshot", "unsequenced", "non-executable-candidate"]
  });
  return {
    updatedAt: now,
    venue: "binance",
    startAsset: "USDT",
    requestedStartQuantity: 1_000,
    scannedMarkets: 300,
    scannedCycles: 40,
    totalOpportunities: 2,
    truncated: false,
    marketDataMode: "rest-top-book",
    snapshotSource: "rest-snapshot",
    executionStatus: "non-executable-candidate",
    sequenceVerified: false,
    opportunities: [route("route-eth", "ETH", 1_003, 30), route("route-sol", "SOL", 1_002, 20)]
  };
}

function nativeSpreads(now: number) {
  const row = (symbol: string, baseCoin: string, bid: number, ask: number) => ({
    id: `bybit:native-spread:${symbol}`,
    venue: "bybit",
    symbol,
    contractType: "FundingRateArb",
    status: "Trading",
    baseCoin,
    quoteCoin: "USDT",
    settleCoin: "USDT",
    tickSize: 0.1,
    minimumPrice: -100,
    maximumPrice: 100,
    quantityStep: 1,
    minimumQuantity: 1,
    maximumQuantity: 100,
    launchTime: now - 10_000,
    legs: [
      { symbol: `${baseCoin}USDT`, contractType: "LinearPerpetual" },
      { symbol: `${baseCoin}USDT`, contractType: "Spot" }
    ],
    bidPrice: bid,
    bidQuantity: 3,
    askPrice: ask,
    askQuantity: 2,
    bookWidth: ask - bid,
    relativeBookWidthBps: ((ask - bid) / Math.abs((bid + ask) / 2)) * 10_000,
    executableQuantity: 2,
    sequence: 10,
    exchangeTs: now - 10,
    matchingEngineTs: now - 12,
    receivedAt: now,
    quoteAgeMs: 10,
    riskFlags: ["read-only", "top-book-only", "venue-native-combination", "revalidate-before-order"]
  });
  return {
    venue: "bybit",
    marketDataMode: "venue-native-spread-orderbook",
    executionModel: "venue-matched-multi-leg",
    readOnly: true,
    updatedAt: now,
    totalInstruments: 2,
    eligibleInstruments: 2,
    scannedInstruments: 2,
    healthyBooks: 2,
    totalOpportunities: 2,
    truncated: false,
    candidateTruncated: false,
    sourceErrors: [],
    opportunities: [row("SOLUSDT_SOL/USDT", "SOL", 1, 1.1), row("BTCUSDT_BTC/USDT", "BTC", 2, 2.1)]
  };
}

function lifecycle(now: number) {
  return {
    schemaVersion: 1,
    readOnly: true,
    executionPermission: false,
    generatedAt: now,
    runtime: { acceptedSnapshots: 1, rejectedSnapshots: 0, lastAcceptedAt: now },
    summary: { universeCount: 0, retainedRoutes: 0, matchedRoutes: 0, returnedRoutes: 0, routesTruncated: false, retainedEvents: 0, matchedEvents: 0, returnedEvents: 0, eventsTruncated: false, nextEventSequence: 1 },
    universes: [],
    routes: [],
    events: []
  };
}

function clockHealth(now: number) {
  return {
    schemaVersion: 1,
    updatedAt: now,
    stale: false,
    sources: ["binance", "bybit"].map((venue) => ({
      sourceId: `${venue}:public`,
      status: "calibrated",
      evaluatedAt: now,
      sampleCount: 3,
      consistentSampleCount: 3,
      sampledAt: now - 10,
      expiresAt: now + 60_000,
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
  };
}

async function expectNoAxeViolations(page: Page) {
  const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(audit.violations, audit.violations.map((item) => `${item.id}: ${item.help} (${item.nodes.length})`).join("\n")).toEqual([]);
}
