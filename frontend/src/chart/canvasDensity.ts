export interface CanvasPixelSize {
  cssWidth: number;
  cssHeight: number;
  pixelWidth: number;
  pixelHeight: number;
}

function runtimeDevicePixelRatio() {
  return typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
}

/** Resolve a crisp backing size even when emulated DPR misreports devicePixelContentBoxSize. */
export function canvasPixelSize(entry: ResizeObserverEntry, dpr = runtimeDevicePixelRatio()): CanvasPixelSize {
  const reported = entry.devicePixelContentBoxSize;
  const device = Array.isArray(reported) ? reported[0] : reported as unknown as ResizeObserverSize | undefined;
  const cssWidth = Math.max(1, entry.contentRect.width);
  const cssHeight = Math.max(1, entry.contentRect.height);
  return {
    cssWidth,
    cssHeight,
    pixelWidth: Math.max(1, Math.round(cssWidth * dpr), Math.round(device?.inlineSize ?? 0)),
    pixelHeight: Math.max(1, Math.round(cssHeight * dpr), Math.round(device?.blockSize ?? 0))
  };
}

export function resizeCanvasToEntry(canvas: HTMLCanvasElement, entry: ResizeObserverEntry, dpr = runtimeDevicePixelRatio()) {
  const size = canvasPixelSize(entry, dpr);
  if (canvas.width === size.pixelWidth && canvas.height === size.pixelHeight) return false;
  canvas.width = size.pixelWidth;
  canvas.height = size.pixelHeight;
  return true;
}

/** Set a HiDPI transform and return the logical CSS-pixel render surface. */
export function prepareCanvasContext(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width || canvas.clientWidth || canvas.width);
  const height = Math.max(1, rect.height || canvas.clientHeight || canvas.height);
  ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
  return { ctx, width, height };
}
