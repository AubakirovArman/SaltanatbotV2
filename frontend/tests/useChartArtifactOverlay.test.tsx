// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { useChartArtifactOverlay, type ArtifactOverlayBuilder, type BuiltArtifactOverlay } from "../src/chart/useChartArtifactOverlay";
import type { StrategyArtifact } from "../src/strategy/library";

const artifact: StrategyArtifact = {
  id: "indicator:test",
  kind: "indicator",
  name: "Test overlay",
  description: "Test",
  xml: "<xml />",
  createdAt: 1,
  updatedAt: 1
};
const candles = [{ time: 1, open: 10, high: 11, low: 9, close: 10, volume: 1 }];

function built(symbol: string, exchange: "binance" | "bybit" = "binance"): BuiltArtifactOverlay {
  return {
    overlay: {
      id: artifact.id,
      name: artifact.name,
      signals: [],
      trades: [],
      exchange,
      symbol,
      timeframe: "1m"
    },
    focusTime: 123
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("useChartArtifactOverlay", () => {
  it("publishes a completed overlay and forwards explicit input overrides", async () => {
    const builder = vi.fn<ArtifactOverlayBuilder>(async (request) => built(request.symbol, request.exchange));
    const container = document.createElement("div");
    const root = createRoot(container);
    let controller: ReturnType<typeof useChartArtifactOverlay> | undefined;

    function Harness() {
      const [inputOverrides, setInputOverrides] = useState<Record<string, Record<string, number>>>({});
      controller = useChartArtifactOverlay({
        artifacts: [artifact],
        inputOverrides,
        setInputOverrides,
        symbol: "BTCUSDT",
        timeframe: "1m",
        candles,
        exchange: "binance",
        showChart: vi.fn(),
        buildOverlay: builder
      });
      return null;
    }

    await act(async () => root.render(<Harness />));
    await act(async () => controller?.addArtifact(artifact.id, { period: 21 }));

    expect(builder).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact,
        overrides: { period: 21 },
        symbol: "BTCUSDT",
        candles
      })
    );
    expect(controller?.activeOverlay?.name).toBe("Test overlay");
    expect(controller?.focusTime).toBe(123);
    await act(async () => root.unmount());
  });

  it("ignores an async result after the market changes", async () => {
    const pending = deferred<BuiltArtifactOverlay | undefined>();
    const builder: ArtifactOverlayBuilder = vi.fn(() => pending.promise);
    const container = document.createElement("div");
    const root = createRoot(container);
    let controller: ReturnType<typeof useChartArtifactOverlay> | undefined;

    function Harness({ symbol }: { symbol: string }) {
      const [inputOverrides, setInputOverrides] = useState<Record<string, Record<string, number>>>({});
      controller = useChartArtifactOverlay({
        artifacts: [artifact],
        inputOverrides,
        setInputOverrides,
        symbol,
        timeframe: "1m",
        candles,
        exchange: "binance",
        showChart: vi.fn(),
        buildOverlay: builder
      });
      return null;
    }

    await act(async () => root.render(<Harness symbol="BTCUSDT" />));
    await act(async () => {
      void controller?.addArtifact(artifact.id);
    });
    await act(async () => root.render(<Harness symbol="ETHUSDT" />));
    await act(async () => pending.resolve(built("BTCUSDT")));

    expect(controller?.overlay).toBeUndefined();
    await act(async () => root.unmount());
  });

  it("does not expose an overlay from another exchange as active", async () => {
    const builder = vi.fn<ArtifactOverlayBuilder>(async (request) => built(request.symbol, request.exchange));
    const container = document.createElement("div");
    const root = createRoot(container);
    let controller: ReturnType<typeof useChartArtifactOverlay> | undefined;

    function Harness({ exchange }: { exchange: "binance" | "bybit" }) {
      const [inputOverrides, setInputOverrides] = useState<Record<string, Record<string, number>>>({});
      controller = useChartArtifactOverlay({
        artifacts: [artifact],
        inputOverrides,
        setInputOverrides,
        symbol: "BTCUSDT",
        timeframe: "1m",
        candles,
        exchange,
        showChart: vi.fn(),
        buildOverlay: builder
      });
      return null;
    }

    await act(async () => root.render(<Harness exchange="binance" />));
    await act(async () => controller?.addArtifact(artifact.id));
    expect(controller?.activeOverlay?.exchange).toBe("binance");
    await act(async () => root.render(<Harness exchange="bybit" />));
    expect(controller?.overlay?.exchange).toBe("binance");
    expect(controller?.activeOverlay).toBeUndefined();
    await act(async () => root.unmount());
  });
});
