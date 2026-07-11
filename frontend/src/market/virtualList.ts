export interface VirtualWindow {
  start: number;
  end: number;
  paddingBefore: number;
  paddingAfter: number;
}

/** Fixed-row windowing for large watchlists; small lists stay fully accessible. */
export function calculateVirtualWindow(total: number, scrollTop: number, viewportHeight: number, rowHeight = 34, overscan = 6, threshold = 80): VirtualWindow {
  if (total <= threshold || viewportHeight <= 0) return { start: 0, end: total, paddingBefore: 0, paddingAfter: 0 };
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(total, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  return { start, end, paddingBefore: start * rowHeight, paddingAfter: (total - end) * rowHeight };
}
