import type { Candle } from "../../types";
import type { ChartTheme, PlotArea } from "../types";

export function drawVolume(
  ctx: CanvasRenderingContext2D,
  panel: PlotArea,
  candles: Candle[],
  step: number,
  theme: ChartTheme
) {
  if (candles.length === 0) return;
  const maxVol = Math.max(...candles.map((candle) => candle.volume), 1);
  const bodyWidth = Math.max(1, Math.min(14, step * 0.62));

  candles.forEach((candle, index) => {
    const x = panel.left + index * step + step / 2;
    const height = (candle.volume / maxVol) * panel.height;
    const y = panel.bottom - height;
    ctx.fillStyle = candle.close >= candle.open ? "rgba(35, 201, 122, 0.45)" : "rgba(239, 83, 80, 0.45)";
    ctx.fillRect(x - bodyWidth / 2, y, bodyWidth, Math.max(0.5, height));
  });

  ctx.fillStyle = theme.muted;
  ctx.font = "11px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("Vol", panel.left + 6, panel.top + 2);
}
