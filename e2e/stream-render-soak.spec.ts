import { expect, test, type Browser, type CDPSession, type Page, type TestInfo } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { installSoakEnvironment, pauseSoakStream, readSoakBrowserSnapshot, resetSoakProbe, resumeSoakStream, SOAK_HISTORY_SIZE, type SoakBrowserSnapshot } from "./support/marketSoak";
import { rawJsHeapOlsSlopeMiBPerMinute, summarizeRetainedHeapCheckpoint, summarizeRetainedHeapCheckpoints } from "./support/soakStatistics";

const durationMs = numericEnvironment("SOAK_DURATION_MS", 300_000, 5_000, 600_000);
const warmupMs = numericEnvironment("SOAK_WARMUP_MS", durationMs >= 300_000 ? 30_000 : 3_000, 1_000, 60_000);
const sampleIntervalMs = numericEnvironment("SOAK_SAMPLE_MS", durationMs >= 300_000 ? 15_000 : 3_000, 1_000, 60_000);
const tickIntervalMs = numericEnvironment("SOAK_TICK_MS", 100, 25, 1_000);
const strictThresholds = process.env.SOAK_ENFORCE_THRESHOLDS === "1";
const requireInstrumentation = process.env.SOAK_REQUIRE_INSTRUMENTATION === "1";

interface SoakProfile {
  name: "desktop" | "mobile";
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  taskDutyLimit: number;
}

interface CdpSnapshot {
  atMs: number;
  usedHeapBytes: number;
  totalHeapBytes: number;
  documents: number;
  nodes: number;
  listeners: number;
  taskDurationSeconds: number;
  scriptDurationSeconds: number;
  layoutDurationSeconds: number;
}

const profiles: SoakProfile[] = [
  {
    name: "desktop",
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    taskDutyLimit: 0.35
  },
  {
    name: "mobile",
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    taskDutyLimit: 0.45
  }
];

for (const profile of profiles) {
  test(`${profile.name} synthetic stream/render soak`, async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(durationMs + warmupMs + 180_000);
    if (!baseURL) throw new Error("Playwright baseURL is required for the soak harness");
    await runSoakProfile(browser, baseURL, profile, testInfo);
  });
}

async function runSoakProfile(browser: Browser, baseURL: string, profile: SoakProfile, testInfo: TestInfo) {
  const context = await browser.newContext({
    baseURL,
    viewport: profile.viewport,
    screen: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
    colorScheme: "dark",
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    serviceWorkers: "block"
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  const expectedOrigin = new URL(baseURL).origin;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== expectedOrigin) externalRequests.push(url.href);
  });

  try {
    await installSoakEnvironment(page, { tickIntervalMs });
    await page.goto("/");
    await expect(page.locator(".chart-canvas-primary")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".chart-legend .vol")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".status-pill.connected")).toHaveCount(1, { timeout: 30_000 });
    await expect.poll(async () => (await readSoakBrowserSnapshot(page)).runtime.channels.stream.active).toBe(1);

    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    await page.waitForTimeout(warmupMs);
    await collectGarbage(cdp, page);
    const baselineCdp = await captureCdp(cdp, 0);
    const baselineBrowser = await readSoakBrowserSnapshot(page);
    await resetSoakProbe(page);

    const samples: CdpSnapshot[] = [baselineCdp];
    const startedAt = Date.now();
    const activeBeforeMs = Math.floor(durationMs * 0.2);
    const hiddenMs = Math.floor(durationMs * 0.2);
    const resumedMs = durationMs - activeBeforeMs - hiddenMs;
    await collectFor(page, cdp, activeBeforeMs, startedAt, samples);
    const activeBeforeBrowser = await readSoakBrowserSnapshot(page);
    const activeBeforeEndCdp = await captureCdp(cdp, Date.now() - startedAt);

    const strategyEntry = profile.name === "mobile" ? "Strategies" : "Automation";
    await page.getByRole("navigation", { name: "Primary workspaces" }).getByRole("button", { name: strategyEntry, exact: true }).click({ timeout: 20_000 });
    await expect.poll(async () => (await readSoakBrowserSnapshot(page)).runtime.channels.stream.active).toBe(0);
    await expect.poll(async () => (await readSoakBrowserSnapshot(page)).runtime.channels.quotes.active).toBe(0);
    await settleAnimationFrames(page);
    await resetSoakProbe(page);
    await collectFor(page, cdp, hiddenMs, startedAt, samples);
    const hiddenBrowser = await readSoakBrowserSnapshot(page);

    await page.getByRole("navigation", { name: "Primary workspaces" }).getByRole("button", { name: "Monitoring", exact: true }).click({ timeout: 20_000 });
    await expect(page.locator(".chart-canvas-primary")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".status-pill.connected")).toHaveCount(1, { timeout: 30_000 });
    await expect.poll(async () => (await readSoakBrowserSnapshot(page)).runtime.channels.stream.active).toBe(1);
    await expect.poll(async () => (await readSoakBrowserSnapshot(page)).runtime.channels.quotes.active).toBe(profile.name === "desktop" ? 1 : 0);
    await pauseSoakStream(page);
    await settlePausedStream(page);
    const recoveredBaselineCheckpoint = await captureRetainedHeapCheckpoint(cdp, page, startedAt);
    const recoveredBaselineCdp = recoveredBaselineCheckpoint.at(-1)!;
    await resetSoakProbe(page);
    await resumeSoakStream(page);
    const resumedStartedAt = Date.now();
    const resumedSamples: CdpSnapshot[] = [{ ...recoveredBaselineCdp, atMs: 0 }];
    await collectFor(page, cdp, resumedMs, startedAt, samples, recoveredBaselineCdp.atMs, resumedSamples);

    await pauseSoakStream(page);
    const resumedActiveDurationMs = Date.now() - resumedStartedAt;
    await settlePausedStream(page);
    const finalBrowser = await readSoakBrowserSnapshot(page);
    const finalActiveCdp = await captureCdp(cdp, Date.now() - startedAt);
    samples.push(finalActiveCdp);
    const finalRetainedCheckpoint = await captureRetainedHeapCheckpoint(cdp, page, startedAt);
    const finalRetainedCdp = finalRetainedCheckpoint.at(-1)!;
    const summary = makeSummary({
      profile,
      browserVersion: browser.version(),
      baselineBrowser,
      activeBeforeBrowser,
      hiddenBrowser,
      finalBrowser,
      baselineCdp,
      activeBeforeEndCdp,
      recoveredBaselineCdp,
      recoveredBaselineCheckpoint,
      finalActiveCdp,
      finalRetainedCdp,
      finalRetainedCheckpoint,
      resumedActiveDurationMs,
      samples,
      resumedSamples,
      pageErrors,
      consoleErrors,
      externalRequests
    });
    const outputPath = testInfo.outputPath(`${profile.name}-stream-render-soak-summary.json`);
    await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    await testInfo.attach(`${profile.name}-stream-render-soak-summary`, { path: outputPath, contentType: "application/json" });
    const evidenceDirectory = resolve(process.env.SOAK_EVIDENCE_DIR ?? "audits/soak");
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(resolve(evidenceDirectory, `${profile.name}-latest.json`), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

    expect(summary.checks.streamMessagesObserved, "synthetic market stream did not emit the expected minimum messages").toBe(true);
    expect(summary.checks.singleStreamSubscription, "single-chart mode must own exactly one market stream").toBe(true);
    expect(summary.checks.expectedQuoteSubscription, "quote subscription did not match the visible markets-panel contract").toBe(true);
    expect(summary.checks.hiddenSubscriptionsReleased, "Strategy workspace retained market subscriptions").toBe(true);
    expect(summary.checks.subscriptionsRecoveredExactly, "market subscriptions did not recover exactly once").toBe(true);
    expect(summary.checks.noPageErrors, `page errors: ${pageErrors.join(" | ")}`).toBe(true);
    expect(summary.checks.noConsoleErrors, `console errors: ${consoleErrors.join(" | ")}`).toBe(true);
    expect(summary.checks.noExternalRequests, `unexpected external requests: ${externalRequests.join(" | ")}`).toBe(true);

    if (strictThresholds) {
      expect(summary.checks.retainedHeapCheckpointsStable, "post-GC retained JS heap checkpoints were unstable").toBe(true);
      expect(summary.checks.retainedHeapGrowthBounded, "post-GC retained JS heap exceeded the relative/absolute growth budget").toBe(true);
      expect(summary.checks.retainedHeapRateBounded, "post-GC retained JS heap grew faster than 1 MiB/min").toBe(true);
      expect(summary.checks.longTasksBounded, "long-task blocking budget was exceeded").toBe(true);
      expect(summary.checks.eventLoopBounded, "event-loop delay exceeded the 250 ms ceiling").toBe(true);
      expect(summary.checks.taskDutyBounded, "renderer main-thread duty exceeded the profile budget").toBe(true);
      expect(summary.checks.domBounded, "DOM nodes/listeners/documents grew beyond the bounded delta").toBe(true);
      expect(summary.checks.copyPressureBounded, "live updates copied too much retained candle history").toBe(true);
      expect(summary.checks.copyReasonsClassified, "a candle history copy was not classified by lifecycle reason").toBe(true);
      expect(summary.checks.rootRenderIsolated, "market ticks rerendered the application root").toBe(true);
    }
    if (requireInstrumentation) {
      expect(summary.checks.renderProbePresent, "application render instrumentation did not report any scope").toBe(true);
      expect(summary.checks.streamProbePresent, "market-stream instrumentation did not report processed messages").toBe(true);
    }
  } finally {
    await context.close();
  }
}

function makeSummary(input: {
  profile: SoakProfile;
  browserVersion: string;
  baselineBrowser: SoakBrowserSnapshot;
  activeBeforeBrowser: SoakBrowserSnapshot;
  hiddenBrowser: SoakBrowserSnapshot;
  finalBrowser: SoakBrowserSnapshot;
  baselineCdp: CdpSnapshot;
  activeBeforeEndCdp: CdpSnapshot;
  recoveredBaselineCdp: CdpSnapshot;
  recoveredBaselineCheckpoint: CdpSnapshot[];
  finalActiveCdp: CdpSnapshot;
  finalRetainedCdp: CdpSnapshot;
  finalRetainedCheckpoint: CdpSnapshot[];
  resumedActiveDurationMs: number;
  samples: CdpSnapshot[];
  resumedSamples: CdpSnapshot[];
  pageErrors: string[];
  consoleErrors: string[];
  externalRequests: string[];
}) {
  const baselineStream = input.baselineBrowser.runtime.channels.stream;
  const finalStream = input.finalBrowser.runtime.channels.stream;
  const finalQuotes = input.finalBrowser.runtime.channels.quotes;
  const emittedCandles = finalStream.candles - baselineStream.candles;
  const streamedDurationMs = durationMs - Math.floor(durationMs * 0.2);
  const expectedMinimum = Math.floor((streamedDurationMs / tickIntervalMs) * 0.75);
  const retainedHeap = summarizeRetainedHeapCheckpoints(input.recoveredBaselineCheckpoint, input.finalRetainedCheckpoint, input.resumedActiveDurationMs);
  const retainedGrowthLimitBytes = Math.max(8 * 1024 * 1024, retainedHeap.baselineMedianBytes * 0.1);
  const rawJsHeapOlsSlope = rawJsHeapOlsSlopeMiBPerMinute(input.resumedSamples);
  const activeBeforeTaskSeconds = Math.max(0, input.activeBeforeEndCdp.taskDurationSeconds - input.baselineCdp.taskDurationSeconds);
  const resumedTaskSeconds = Math.max(0, input.finalActiveCdp.taskDurationSeconds - input.recoveredBaselineCdp.taskDurationSeconds);
  const taskDurationSeconds = activeBeforeTaskSeconds + resumedTaskSeconds;
  const elapsedSeconds = Math.max(0.001, (durationMs * 0.8) / 1_000);
  const taskDuty = taskDurationSeconds / elapsedSeconds;
  const activeProbes = [input.activeBeforeBrowser.probe, input.finalBrowser.probe].filter((probe): probe is NonNullable<SoakBrowserSnapshot["probe"]> => probe !== undefined);
  const eventLoopMaxMs = Math.max(0, ...activeProbes.map((probe) => probe.metrics["eventLoop.delayMs"]?.max ?? 0));
  const longTasks = {
    supported: activeProbes.some((probe) => probe.longTasks.supported),
    count: activeProbes.reduce((sum, probe) => sum + probe.longTasks.count, 0),
    totalDurationMs: activeProbes.reduce((sum, probe) => sum + probe.longTasks.totalDurationMs, 0),
    totalBlockingTimeMs: activeProbes.reduce((sum, probe) => sum + probe.longTasks.totalBlockingTimeMs, 0),
    maxDurationMs: Math.max(0, ...activeProbes.map((probe) => probe.longTasks.maxDurationMs)),
    over100Ms: activeProbes.reduce((sum, probe) => sum + probe.longTasks.over100Ms, 0)
  };
  const domDelta = {
    documents: input.finalRetainedCdp.documents - input.recoveredBaselineCdp.documents,
    nodes: input.finalRetainedCdp.nodes - input.recoveredBaselineCdp.nodes,
    listeners: input.finalRetainedCdp.listeners - input.recoveredBaselineCdp.listeners
  };
  const expectedQuotes = input.profile.name === "desktop" ? 1 : 0;
  const initialQuotes = input.baselineBrowser.runtime.channels.quotes;
  const hiddenStream = input.hiddenBrowser.runtime.channels.stream;
  const hiddenQuotes = input.hiddenBrowser.runtime.channels.quotes;
  const renderProbePresent = activeProbes.some((probe) => Object.keys(probe.renders).length > 0);
  const processedMessages = activeProbes.reduce((sum, probe) => sum + (probe.metrics["stream.processed"]?.sum ?? 0), 0);
  const copiedCandleElements = activeProbes.reduce((sum, probe) => sum + (probe.metrics["candle.copiedElements"]?.sum ?? 0), 0);
  const copiedCandleElementsByReason = {
    snapshot: activeProbes.reduce((sum, probe) => sum + (probe.metrics["candle.copiedElements.snapshot"]?.sum ?? 0), 0),
    newBar: activeProbes.reduce((sum, probe) => sum + (probe.metrics["candle.copiedElements.newBar"]?.sum ?? 0), 0),
    finalization: activeProbes.reduce((sum, probe) => sum + (probe.metrics["candle.copiedElements.finalization"]?.sum ?? 0), 0),
    prepend: activeProbes.reduce((sum, probe) => sum + (probe.metrics["candle.copiedElements.prepend"]?.sum ?? 0), 0)
  };
  const classifiedCopiedCandleElements = Object.values(copiedCandleElementsByReason).reduce((sum, value) => sum + value, 0);
  const unclassifiedCopiedCandleElements = copiedCandleElements - classifiedCopiedCandleElements;
  const provisionalTailUpdates = activeProbes.reduce((sum, probe) => sum + (probe.metrics["candle.provisionalTail"]?.sum ?? 0), 0);
  const appRenders = activeProbes.reduce((sum, probe) => sum + (probe.renders.App?.count ?? 0), 0);
  const copiedElementsPerProcessedMessage = processedMessages === 0 ? Number.POSITIVE_INFINITY : copiedCandleElements / processedMessages;
  const appRenderRatio = processedMessages === 0 ? Number.POSITIVE_INFINITY : appRenders / processedMessages;
  const checks = {
    streamMessagesObserved: emittedCandles >= expectedMinimum,
    singleStreamSubscription: finalStream.active === 1 && finalStream.maxActive === 1,
    expectedQuoteSubscription: finalQuotes.active === expectedQuotes && finalQuotes.maxActive === expectedQuotes,
    hiddenSubscriptionsReleased: hiddenStream.active === 0 && hiddenQuotes.active === 0,
    subscriptionsRecoveredExactly:
      finalStream.created - baselineStream.created === 1 && finalStream.closed - baselineStream.closed === 1 && finalStream.active === 1 && finalQuotes.created - initialQuotes.created === expectedQuotes && finalQuotes.closed - initialQuotes.closed === expectedQuotes && finalQuotes.active === expectedQuotes,
    noPageErrors: input.pageErrors.length === 0,
    noConsoleErrors: input.consoleErrors.length === 0,
    noExternalRequests: input.externalRequests.length === 0,
    retainedHeapCheckpointsStable: retainedHeap.stable,
    retainedHeapGrowthBounded: retainedHeap.upperGrowthBytes <= retainedGrowthLimitBytes,
    retainedHeapRateBounded: retainedHeap.upperGrowthRateMiBPerMinute <= 1,
    longTasksBounded: longTasks.maxDurationMs <= 150 && longTasks.totalBlockingTimeMs <= 250,
    eventLoopBounded: eventLoopMaxMs <= 250,
    taskDutyBounded: taskDuty <= input.profile.taskDutyLimit,
    domBounded: domDelta.documents <= 0 && domDelta.nodes <= 50 && domDelta.listeners <= 10,
    renderProbePresent,
    streamProbePresent: processedMessages > 0,
    copyPressureBounded: copiedElementsPerProcessedMessage <= 64,
    copyReasonsClassified: unclassifiedCopiedCandleElements === 0,
    rootRenderIsolated: appRenderRatio <= 0.01
  };
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    profile: input.profile.name,
    acceptanceDuration: durationMs >= 300_000,
    browser: { name: "chromium", version: input.browserVersion },
    viewport: input.profile.viewport,
    configuration: {
      historyCandles: SOAK_HISTORY_SIZE,
      durationMs,
      warmupMs,
      sampleIntervalMs,
      tickIntervalMs,
      strictThresholds,
      requireInstrumentation
    },
    thresholds: {
      retainedHeapGrowthBytes: retainedGrowthLimitBytes,
      retainedHeapRateMiBPerMinute: 1,
      retainedHeapCheckpointSpreadBytes: {
        baseline: retainedHeap.baselineStabilityLimitBytes,
        final: retainedHeap.finalStabilityLimitBytes
      },
      longTaskMaxMs: 150,
      totalBlockingTimeMs: 250,
      eventLoopDelayMaxMs: 250,
      taskDuty: input.profile.taskDutyLimit,
      domNodeDelta: 50,
      listenerDelta: 10
    },
    stream: {
      emittedCandles,
      expectedMinimum,
      streamedDurationMs,
      baseline: input.baselineBrowser.runtime,
      activeBefore: input.activeBeforeBrowser.runtime,
      hidden: input.hiddenBrowser.runtime,
      final: input.finalBrowser.runtime
    },
    render: {
      instrumented: checks.renderProbePresent,
      activeBefore: input.activeBeforeBrowser.probe?.renders ?? {},
      resumed: input.finalBrowser.probe?.renders ?? {},
      appRenders,
      appRenderRatio
    },
    streamInstrumentation: {
      processedMessages,
      provisionalTailUpdates,
      copiedCandleElements,
      copiedCandleElementsByReason,
      unclassifiedCopiedCandleElements,
      copiedElementsPerProcessedMessage
    },
    longTasks,
    eventLoop: {
      maxDelayMs: eventLoopMaxMs,
      activeBefore: input.activeBeforeBrowser.probe?.metrics["eventLoop.delayMs"] ?? null,
      resumed: input.finalBrowser.probe?.metrics["eventLoop.delayMs"] ?? null
    },
    memory: {
      initialBaselineUsedHeapBytes: input.baselineCdp.usedHeapBytes,
      recoveredBaselineUsedHeapBytes: retainedHeap.baselineMedianBytes,
      finalActiveUsedHeapBytes: input.finalActiveCdp.usedHeapBytes,
      finalRetainedUsedHeapBytes: retainedHeap.finalMedianBytes,
      retainedNetGrowthBytes: retainedHeap.netGrowthBytes,
      retainedUpperGrowthBytes: retainedHeap.upperGrowthBytes,
      retainedGrowthLimitBytes,
      retainedNetGrowthRateMiBPerMinute: retainedHeap.netGrowthRateMiBPerMinute,
      retainedUpperGrowthRateMiBPerMinute: retainedHeap.upperGrowthRateMiBPerMinute,
      rawJsHeapOlsSlopeMiBPerMinute: rawJsHeapOlsSlope,
      resumedActiveDurationMs: input.resumedActiveDurationMs,
      checkpointStable: retainedHeap.stable,
      baselineCheckpoint: input.recoveredBaselineCheckpoint,
      finalCheckpoint: input.finalRetainedCheckpoint,
      domDelta
    },
    cpu: {
      taskDurationSeconds,
      elapsedSeconds,
      taskDuty,
      scriptDurationSeconds: input.activeBeforeEndCdp.scriptDurationSeconds - input.baselineCdp.scriptDurationSeconds + input.finalActiveCdp.scriptDurationSeconds - input.recoveredBaselineCdp.scriptDurationSeconds,
      layoutDurationSeconds: input.activeBeforeEndCdp.layoutDurationSeconds - input.baselineCdp.layoutDurationSeconds + input.finalActiveCdp.layoutDurationSeconds - input.recoveredBaselineCdp.layoutDurationSeconds
    },
    samples: input.samples,
    resumedSamples: input.resumedSamples,
    errors: {
      page: input.pageErrors,
      console: input.consoleErrors,
      externalRequests: input.externalRequests
    },
    probe: {
      activeBefore: input.activeBeforeBrowser.probe ?? null,
      hidden: input.hiddenBrowser.probe ?? null,
      resumed: input.finalBrowser.probe ?? null
    },
    checks
  };
}

async function collectFor(page: Page, cdp: CDPSession, phaseDurationMs: number, globalStartedAt: number, allSamples: CdpSnapshot[], phaseOffsetMs?: number, phaseSamples?: CdpSnapshot[]): Promise<void> {
  const phaseStartedAt = Date.now();
  while (Date.now() - phaseStartedAt < phaseDurationMs) {
    const remaining = phaseDurationMs - (Date.now() - phaseStartedAt);
    await page.waitForTimeout(Math.min(sampleIntervalMs, Math.max(1, remaining)));
    const sample = await captureCdp(cdp, Date.now() - globalStartedAt);
    allSamples.push(sample);
    if (phaseSamples && phaseOffsetMs !== undefined) phaseSamples.push({ ...sample, atMs: Math.max(0, sample.atMs - phaseOffsetMs) });
  }
}

async function captureCdp(cdp: CDPSession, atMs: number): Promise<CdpSnapshot> {
  const [heap, dom, performanceMetrics] = await Promise.all([cdp.send("Runtime.getHeapUsage"), cdp.send("Memory.getDOMCounters"), cdp.send("Performance.getMetrics")]);
  const metrics = Object.fromEntries(performanceMetrics.metrics.map((metric) => [metric.name, metric.value]));
  return {
    atMs,
    usedHeapBytes: heap.usedSize,
    totalHeapBytes: heap.totalSize,
    documents: dom.documents,
    nodes: dom.nodes,
    listeners: dom.jsEventListeners,
    taskDurationSeconds: metrics.TaskDuration ?? 0,
    scriptDurationSeconds: metrics.ScriptDuration ?? 0,
    layoutDurationSeconds: metrics.LayoutDuration ?? 0
  };
}

async function collectGarbage(cdp: CDPSession, page: Page): Promise<void> {
  await cdp.send("HeapProfiler.collectGarbage");
  await settleAnimationFrames(page);
}

async function captureRetainedHeapCheckpoint(cdp: CDPSession, page: Page, globalStartedAt: number): Promise<CdpSnapshot[]> {
  const readings: CdpSnapshot[] = [];
  for (let index = 0; index < 8; index += 1) {
    await collectGarbage(cdp, page);
    readings.push(await captureCdp(cdp, Date.now() - globalStartedAt));
    if (readings.length >= 3) {
      const candidate = readings.slice(-3);
      if (summarizeRetainedHeapCheckpoint("candidate", candidate).stable) return candidate;
    }
  }
  return readings.slice(-3);
}

async function settlePausedStream(page: Page): Promise<void> {
  await page.waitForTimeout(Math.max(300, tickIntervalMs * 2));
  await settleAnimationFrames(page);
}

async function settleAnimationFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

function numericEnvironment(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(parsed)));
}
