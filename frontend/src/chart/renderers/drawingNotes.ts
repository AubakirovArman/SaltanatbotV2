import type { DrawingObject, PixelPoint } from "../drawings";

/**
 * Text-note label rendering. The layout is deterministic and canvas-free (fixed character
 * metrics) so the hit test recomputes exactly the same box without touching a 2D context.
 */

export const NOTE_MAX_WIDTH = 240;
export const NOTE_MAX_LINES = 8;
const NOTE_PADDING = 8;
const NOTE_LINE_HEIGHT = 16;
const NOTE_CHAR_WIDTH = 6.6;
const NOTE_ANCHOR_OFFSET = 10;
const NOTE_CORNER_RADIUS = 6;
const NOTE_FONT = "500 12px Inter, system-ui, sans-serif";
const NOTE_PLACEHOLDER = "…";

export interface NoteLabelLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  lines: string[];
}

export interface NotePalette {
  panel: string;
  text: string;
}

const DARK_NOTE_PALETTE: NotePalette = { panel: "#101419", text: "#e5edf4" };

/** Word-wrap note text to the label width, capped at 8 lines with a trailing ellipsis. */
export function wrapNoteText(text: string): string[] {
  const source = text.length > 0 ? text : NOTE_PLACEHOLDER;
  const maxChars = Math.floor((NOTE_MAX_WIDTH - NOTE_PADDING * 2) / NOTE_CHAR_WIDTH);
  const lines: string[] = [];
  for (const paragraph of source.split("\n")) {
    let current = "";
    for (const word of paragraph.split(" ")) {
      let pending = word;
      while (pending.length > 0) {
        const candidate = current.length > 0 ? `${current} ${pending}` : pending;
        if (candidate.length <= maxChars) {
          current = candidate;
          pending = "";
        } else if (current.length > 0) {
          lines.push(current);
          current = "";
        } else {
          lines.push(pending.slice(0, maxChars));
          pending = pending.slice(maxChars);
        }
      }
    }
    lines.push(current);
  }
  if (lines.length <= NOTE_MAX_LINES) return lines;
  const clipped = lines.slice(0, NOTE_MAX_LINES);
  clipped[NOTE_MAX_LINES - 1] = `${clipped[NOTE_MAX_LINES - 1].slice(0, maxChars - 1)}…`;
  return clipped;
}

/** Deterministic label box shared by the renderer and the hit test. */
export function layoutNoteLabel(text: string | undefined, anchor: PixelPoint): NoteLabelLayout {
  const lines = wrapNoteText(text ?? "");
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 1);
  const width = Math.min(NOTE_MAX_WIDTH, longest * NOTE_CHAR_WIDTH + NOTE_PADDING * 2);
  const height = lines.length * NOTE_LINE_HEIGHT + NOTE_PADDING * 2;
  return { x: anchor.x + NOTE_ANCHOR_OFFSET, y: anchor.y - height - NOTE_ANCHOR_OFFSET, width, height, lines };
}

export function drawTextNote(
  ctx: CanvasRenderingContext2D,
  anchor: PixelPoint,
  drawing: DrawingObject,
  emphasized: boolean,
  palette: NotePalette = DARK_NOTE_PALETTE
) {
  const color = drawing.style.color;
  const layout = layoutNoteLabel(drawing.text, anchor);

  ctx.save();
  ctx.setLineDash([]);
  // Anchor dot plus a short leader to the label box.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(anchor.x, anchor.y, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.65;
  ctx.beginPath();
  ctx.moveTo(anchor.x, anchor.y);
  ctx.lineTo(layout.x, layout.y + layout.height);
  ctx.stroke();
  ctx.globalAlpha = 1;

  roundedRectPath(ctx, layout.x, layout.y, layout.width, layout.height, NOTE_CORNER_RADIUS);
  ctx.fillStyle = palette.panel;
  ctx.globalAlpha = 0.94;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = emphasized ? 2 : 1.2;
  ctx.stroke();
  if (emphasized) {
    roundedRectPath(ctx, layout.x - 3, layout.y - 3, layout.width + 6, layout.height + 6, NOTE_CORNER_RADIUS + 3);
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.beginPath();
  ctx.rect(layout.x, layout.y, layout.width, layout.height);
  ctx.clip();
  ctx.fillStyle = palette.text;
  ctx.font = NOTE_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  layout.lines.forEach((line, index) => {
    ctx.fillText(line, layout.x + NOTE_PADDING, layout.y + NOTE_PADDING + NOTE_LINE_HEIGHT * (index + 0.5));
  });
  ctx.restore();
}

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
