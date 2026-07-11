export type ChartDirtyLayer = "background" | "primary" | "indicators" | "overlays" | "interaction";

const LAYER_ORDER: ChartDirtyLayer[] = ["background", "primary", "indicators", "overlays", "interaction"];

interface FrameDriver {
  request(callback: FrameRequestCallback): number;
  cancel(id: number): void;
}

/** Coalesce rapid invalidations and always paint base before interaction. */
export function createChartLayerScheduler(driver: FrameDriver) {
  let frame: number | undefined;
  const draws = new Map<ChartDirtyLayer, () => void>();

  const flush = () => {
    frame = undefined;
    const pending = new Map(draws);
    draws.clear();
    for (const layer of LAYER_ORDER) pending.get(layer)?.();
  };

  return {
    schedule(layer: ChartDirtyLayer, draw: () => void) {
      draws.set(layer, draw);
      if (frame === undefined) frame = driver.request(flush);
    },
    dispose() {
      if (frame !== undefined) driver.cancel(frame);
      frame = undefined;
      draws.clear();
    }
  };
}
