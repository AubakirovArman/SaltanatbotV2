import type { ChartTheme, PlotArea, PriceScale } from "../types";
import type { VolumeProfile } from "../volumeProfile";

export function drawVolumeProfile(
  ctx: CanvasRenderingContext2D,
  plot: PlotArea,
  scale: PriceScale,
  profile: VolumeProfile,
  theme: ChartTheme
) {
  if (profile.maxVolume <= 0) return;
  const maxWidth = Math.max(76, Math.min(184, plot.width * 0.24));
  const right = plot.right - 1;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.left, plot.top, plot.width, plot.height);
  ctx.clip();

  for (const bin of profile.bins) {
    if (bin.total <= 0) continue;
    const top = scale.y(bin.high);
    const bottom = scale.y(bin.low);
    const y = Math.min(top, bottom) + 0.5;
    const height = Math.max(1, Math.abs(bottom - top) - 1);
    const width = maxWidth * bin.total / profile.maxVolume;
    const downWidth = width * bin.down / bin.total;
    const x = right - width;

    ctx.globalAlpha = bin.valueArea ? 0.32 : 0.17;
    ctx.fillStyle = theme.down;
    ctx.fillRect(x, y, downWidth, height);
    ctx.fillStyle = theme.up;
    ctx.fillRect(x + downWidth, y, width - downWidth, height);
  }

  const pocY = scale.y(profile.pocPrice);
  ctx.globalAlpha = 0.72;
  ctx.strokeStyle = theme.accent;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(right - maxWidth, pocY);
  ctx.lineTo(right, pocY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}
