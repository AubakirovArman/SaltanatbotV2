import { describe, expect, it, vi } from "vitest";
import type { BollingerPoint, MacdPoint, SeriesPoint, StochasticPoint } from "../src/chart/indicatorTypes";
import { drawBollinger, drawMacdPanel, drawOscillatorPanel, drawStochasticPanel } from "../src/chart/renderers/indicatorRenderers";
import type { ChartTheme, PlotArea, PriceScale } from "../src/chart/types";

const plot: PlotArea = { left: 10, top: 20, right: 210, bottom: 120, width: 200, height: 100 };
const scale: PriceScale = {
  min: 0,
  max: 200,
  mode: "linear",
  base: 100,
  y: (value) => value,
  priceAt: (y) => y
};
const theme: ChartTheme = {
  background: "#000",
  panel: "#111",
  grid: "#222",
  text: "#fff",
  muted: "#aaa",
  up: "#0f0",
  down: "#f00",
  accent: "#0ff",
  areaFill: "#012"
};

describe("indicator renderer visible ranges", () => {
  it("draws Bollinger bands from the visible window without full-series array helpers", () => {
    const start = 6_000;
    const end = 6_012;
    const points = guardedSeries(
      Array.from(
        { length: 12_000 },
        (_, index): BollingerPoint => ({
          time: index,
          middle: index,
          upper: index + 2,
          lower: index - 2
        })
      ),
      start,
      end
    );
    const ctx = context();

    drawBollinger(ctx, points, start, end, plot, scale, 5, { middle: "#fff", band: "#999" });

    expect(ctx.moveTo).toHaveBeenCalledTimes(3);
    expect(ctx.moveTo.mock.calls.map(([x]) => x)).toEqual([12.5, 12.5, 12.5]);
    expect(ctx.moveTo.mock.calls.map(([, y]) => y)).toEqual([start + 2, start - 2, start]);
    expect(ctx.lineTo).toHaveBeenCalledTimes((end - start - 1) * 3);
    expect(ctx.stroke).toHaveBeenCalledTimes(3);
  });

  it("keeps MACD, stochastic and oscillator passes inside the visible window", () => {
    const start = 8_000;
    const end = 8_016;
    const ctx = context();
    const macd = guardedSeries(
      Array.from(
        { length: 12_000 },
        (_, index): MacdPoint => ({
          time: index,
          macd: index % 7,
          signal: index % 5,
          histogram: (index % 3) - 1
        })
      ),
      start,
      end
    );
    const stochastic = guardedSeries(
      Array.from(
        { length: 12_000 },
        (_, index): StochasticPoint => ({
          time: index,
          k: index % 100,
          d: (index + 3) % 100
        })
      ),
      start,
      end
    );
    const oscillator = guardedSeries(
      Array.from({ length: 12_000 }, (_, index): SeriesPoint => ({ time: index, value: index % 50 })),
      start,
      end
    );

    drawMacdPanel(
      ctx,
      plot,
      macd,
      start,
      end,
      {
        macd: "#fff",
        signal: "#aaa",
        up: "#0f0",
        down: "#f00"
      },
      theme
    );
    drawStochasticPanel(ctx, plot, stochastic, start, end, { k: "#fff", d: "#aaa" }, theme);
    drawOscillatorPanel(ctx, plot, oscillator, start, end, "#fff", theme, "ATR");

    expect(ctx.fillRect).toHaveBeenCalledTimes(end - start);
    expect(ctx.stroke).toHaveBeenCalled();
  });
});

function guardedSeries<T>(values: T[], start: number, end: number): T[] {
  const fail = () => {
    throw new Error("renderer used a full-series array helper");
  };
  Object.defineProperties(values, {
    map: { value: fail },
    slice: { value: fail },
    flatMap: { value: fail },
    filter: { value: fail }
  });
  return new Proxy(values, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)) {
        const index = Number(property);
        if (index < start || index >= end) throw new Error(`renderer read hidden point ${index}`);
      }
      return Reflect.get(target, property, receiver);
    }
  });
}

function context() {
  const values: Record<PropertyKey, unknown> = {};
  return new Proxy(values, {
    get(target, property) {
      if (!(property in target)) target[property] = vi.fn();
      return target[property];
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    }
  }) as CanvasRenderingContext2D & {
    moveTo: ReturnType<typeof vi.fn>;
    lineTo: ReturnType<typeof vi.fn>;
    stroke: ReturnType<typeof vi.fn>;
    fillRect: ReturnType<typeof vi.fn>;
  };
}
