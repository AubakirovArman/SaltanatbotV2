import { parseChannelGeometryV1, type ChannelGeometryV1 } from "@saltanatbotv2/contracts";
import type { Anchor } from "./drawings";

/**
 * Pure helpers over the canonical chart geometry contract. The canvas renderers, drag
 * interaction, and workspace validation all derive channel geometry through this module so the
 * client and the server-side v9 workspace schema enforce exactly the same shapes.
 */

/** Price on the infinite line through a and b at the given time (a.price when degenerate). */
export function lineValueAt(a: Anchor, b: Anchor, time: number): number {
  if (b.time === a.time) return a.price;
  return a.price + ((b.price - a.price) * (time - a.time)) / (b.time - a.time);
}

/**
 * Signed price offset of the width anchor from the a-b base line, measured at the anchor's own
 * time. NaN when the base line is vertical (a and b share one time).
 */
export function channelWidth(a: Anchor, b: Anchor, w: Anchor): number {
  if (b.time === a.time) return Number.NaN;
  return w.price - lineValueAt(a, b, w.time);
}

/**
 * Canonical channel geometry of stored anchors [a, b, w], or undefined when the shared contract
 * rejects them. Times are canonicalized to whole milliseconds exactly like the server does; the
 * width is derived from the exact stored values.
 */
export function channelGeometryOf(points: readonly Anchor[]): ChannelGeometryV1 | undefined {
  if (points.length !== 3) return undefined;
  const [a, b, w] = points;
  try {
    return parseChannelGeometryV1({
      kind: "channel",
      a: { time: Math.round(a.time), price: a.price },
      b: { time: Math.round(b.time), price: b.price },
      width: channelWidth(a, b, w)
    });
  } catch {
    return undefined;
  }
}
