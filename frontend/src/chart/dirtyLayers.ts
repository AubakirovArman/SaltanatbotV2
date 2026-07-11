export type ChartDirtyLayer = "base" | "interaction";

interface FrameDriver {
  request(callback: FrameRequestCallback): number;
  cancel(id: number): void;
}

/** Coalesce rapid invalidations and always paint base before interaction. */
export function createChartLayerScheduler(driver: FrameDriver) {
  let frame: number | undefined;
  let base: (() => void) | undefined;
  let interaction: (() => void) | undefined;

  const flush = () => {
    frame = undefined;
    const drawBase = base;
    const drawInteraction = interaction;
    base = undefined;
    interaction = undefined;
    drawBase?.();
    drawInteraction?.();
  };

  return {
    schedule(layer: ChartDirtyLayer, draw: () => void) {
      if (layer === "base") base = draw;
      else interaction = draw;
      if (frame === undefined) frame = driver.request(flush);
    },
    dispose() {
      if (frame !== undefined) driver.cancel(frame);
      frame = undefined;
      base = undefined;
      interaction = undefined;
    }
  };
}
