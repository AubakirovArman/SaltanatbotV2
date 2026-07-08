/**
 * Distinct, high-contrast colors for compare-overlay lines. Chosen to stay
 * legible against the dark price pane and to differ from the base accent and
 * the up/down candle greens/reds. Assigned by slot index (max ~3 compares).
 */
const COMPARE_COLORS = ["#f5a623", "#bd7dff", "#4dd0e1", "#ff7ac6", "#9ccc65"];

/** Stable color for a compare symbol given its position in the list. */
export function compareColor(index: number): string {
  return COMPARE_COLORS[index % COMPARE_COLORS.length];
}
