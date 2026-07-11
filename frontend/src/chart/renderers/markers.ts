import type { ChartMarker, ChartTheme, Viewport } from "../types";

export function drawMarkers(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  markers: ChartMarker[],
  theme: ChartTheme
) {
  const { plot } = viewport;
  ctx.save();
  ctx.font = "600 10px Inter, system-ui, sans-serif";
  markers.forEach((marker) => {
    const x = viewport.timeToX(marker.time);
    const y = viewport.priceToY(marker.price);
    if (x < plot.left - 8 || x > plot.right + 8) return;
    const neutral = marker.kind === "marker";
    const pointUp = marker.kind === "buy";
    const color = marker.color ?? (marker.kind === "buy" ? theme.up : marker.kind === "sell" ? theme.down : theme.accent);
    const size = 6;
    const baseY = neutral || pointUp ? y + 10 : y - 10;

    ctx.fillStyle = color;
    ctx.beginPath();
    if (neutral) {
      ctx.moveTo(x, baseY - size);
      ctx.lineTo(x + size, baseY);
      ctx.lineTo(x, baseY + size);
      ctx.lineTo(x - size, baseY);
    } else if (pointUp) {
      ctx.moveTo(x, baseY - size);
      ctx.lineTo(x - size, baseY + size);
      ctx.lineTo(x + size, baseY + size);
    } else {
      ctx.moveTo(x, baseY + size);
      ctx.lineTo(x - size, baseY - size);
      ctx.lineTo(x + size, baseY - size);
    }
    ctx.closePath();
    ctx.fill();

    if (marker.label) {
      ctx.fillStyle = theme.text;
      ctx.textAlign = "center";
      ctx.textBaseline = neutral || pointUp ? "top" : "bottom";
      ctx.fillText(marker.label, x, neutral || pointUp ? baseY + size + 2 : baseY - size - 2);
    }
  });
  ctx.restore();
  ctx.textAlign = "left";
}
