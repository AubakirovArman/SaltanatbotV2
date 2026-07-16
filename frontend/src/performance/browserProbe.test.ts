import { afterEach, describe, expect, it, vi } from "vitest";
import {
  measureBrowserRender,
  readBrowserPerformanceSummary,
  recordBrowserMetric,
  recordBrowserRender,
  resetBrowserPerformanceProbe,
  type BrowserPerformanceProbeController,
  type BrowserPerformanceSummary
} from "./browserProbe";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  vi.restoreAllMocks();
});

describe("browser performance probe facade", () => {
  it("is a no-op outside an opted-in browser", () => {
    expect(() => recordBrowserMetric("stream.processed")).not.toThrow();
    expect(() => recordBrowserRender("App")).not.toThrow();
    expect(readBrowserPerformanceSummary()).toBeUndefined();
    expect(measureBrowserRender("chart", () => 42)).toBe(42);
  });

  it("forwards bounded metrics and render timings to the installed controller", () => {
    const summary = { schemaVersion: 1 } as BrowserPerformanceSummary;
    const controller: BrowserPerformanceProbeController = {
      recordMetric: vi.fn(),
      recordRender: vi.fn(),
      read: vi.fn(() => summary),
      reset: vi.fn(),
      stop: vi.fn()
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __SBV2_BROWSER_PERF_PROBE__: controller }
    });
    vi.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(15);

    recordBrowserMetric("stream.processed");
    recordBrowserMetric("candle.copiedElements", 12);
    recordBrowserRender("App");
    expect(measureBrowserRender("chart.primary", () => "painted")).toBe("painted");
    resetBrowserPerformanceProbe();

    expect(controller.recordMetric).toHaveBeenNthCalledWith(1, "stream.processed", 1);
    expect(controller.recordMetric).toHaveBeenNthCalledWith(2, "candle.copiedElements", 12);
    expect(controller.recordRender).toHaveBeenNthCalledWith(1, "App", 0);
    expect(controller.recordRender).toHaveBeenNthCalledWith(2, "chart.primary", 5);
    expect(controller.reset).toHaveBeenCalledOnce();
    expect(readBrowserPerformanceSummary()).toBe(summary);
  });
});
