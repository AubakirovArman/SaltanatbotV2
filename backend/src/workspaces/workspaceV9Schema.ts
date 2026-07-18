import { z } from "zod";
import { parseChannelGeometryV1 } from "@saltanatbotv2/contracts";
import { workspaceV8Schema } from "./workspaceV8Schema.js";

/**
 * Workspace schema v9 composes the accepted v8 contract unchanged and adds the two chart
 * research tools: "text-note" (one anchor plus optional text/author/createdAt metadata) and
 * "parallel-channel" (three anchors whose derived geometry must satisfy the canonical
 * ChannelGeometryV1 contract). Every v9-only extension is validated here, then rewritten to an
 * equivalent v8-shaped drawing so the untouched v8 schema keeps enforcing everything else.
 */

export const WORKSPACE_V9_DRAWING_TOOLS = ["text-note", "parallel-channel"] as const;
export const MAX_TEXT_NOTE_LENGTH = 500;
export const MAX_TEXT_NOTE_AUTHOR_LENGTH = 64;

const V9_POINT_COUNTS: Record<V9Tool, number> = {
  "text-note": 1,
  "parallel-channel": 3
};
const V8_DRAWING_KEYS = ["id", "tool", "points", "style", "locked", "hidden"] as const;
const TEXT_NOTE_KEYS = [...V8_DRAWING_KEYS, "text", "author", "createdAt"] as const;

type V9Tool = (typeof WORKSPACE_V9_DRAWING_TOOLS)[number];
type IssuePath = Array<string | number>;

export const workspaceV9Schema = z
  .record(z.unknown())
  .superRefine((value, context) => {
    if (value.schemaVersion !== 9) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schemaVersion"],
        message: "Workspace schema version must be 9"
      });
      return;
    }
    const downgraded = downgradeWorkspaceToV8(value, context);
    const parsed = workspaceV8Schema.safeParse(downgraded);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: issue.path,
          message: issue.message
        });
      }
    }
  });

/** Validate v9 drawing extensions in place, returning a v8-shaped clone for composition. */
function downgradeWorkspaceToV8(
  payload: Record<string, unknown>,
  context: z.RefinementCtx
): Record<string, unknown> {
  const clone = structuredClone(payload);
  clone.schemaVersion = 8;
  downgradeScopes(clone.drawings, ["drawings"], context);
  if (Array.isArray(clone.history)) {
    clone.history.forEach((entry, index) => {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        downgradeScopes(
          (entry as Record<string, unknown>).drawings,
          ["history", index, "drawings"],
          context
        );
      }
    });
  }
  return clone;
}

function downgradeScopes(scopes: unknown, path: IssuePath, context: z.RefinementCtx): void {
  if (!Array.isArray(scopes)) return;
  scopes.forEach((scope, scopeIndex) => {
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) return;
    const drawings = (scope as Record<string, unknown>).drawings;
    if (!Array.isArray(drawings)) return;
    drawings.forEach((drawing, drawingIndex) => {
      const replaced = downgradeDrawing(
        drawing,
        [...path, scopeIndex, "drawings", drawingIndex],
        context
      );
      if (replaced !== undefined) drawings[drawingIndex] = replaced;
    });
  });
}

function downgradeDrawing(
  value: unknown,
  path: IssuePath,
  context: z.RefinementCtx
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const drawing = value as Record<string, unknown>;
  const tool = drawing.tool;
  if (tool !== "text-note" && tool !== "parallel-channel") return undefined;
  const allowed = new Set<string>(tool === "text-note" ? TEXT_NOTE_KEYS : V8_DRAWING_KEYS);
  for (const key of Object.keys(drawing)) {
    if (!allowed.has(key)) {
      issue(context, [...path, key], `Field ${key} is not allowed on ${tool} drawings`);
    }
  }
  const expected = V9_POINT_COUNTS[tool];
  const sourcePoints = Array.isArray(drawing.points) ? drawing.points : [];
  if (!Array.isArray(drawing.points) || sourcePoints.length !== expected) {
    issue(context, [...path, "points"], `Drawing ${tool} requires ${expected} points`);
  }
  if (tool === "text-note") {
    validateNoteText(drawing.text, [...path, "text"], context);
    validateNoteAuthor(drawing.author, [...path, "author"], context);
    validateNoteCreatedAt(drawing.createdAt, [...path, "createdAt"], context);
  } else {
    validateChannelGeometry(sourcePoints, [...path, "points"], context);
  }
  const points = sourcePoints.slice(0, expected);
  while (points.length < expected) points.push({ time: 1, price: 1 });
  const placeholder: Record<string, unknown> = {
    id: drawing.id,
    tool: tool === "text-note" ? "hline" : "long",
    points,
    style: drawing.style
  };
  if (drawing.locked !== undefined) placeholder.locked = drawing.locked;
  if (drawing.hidden !== undefined) placeholder.hidden = drawing.hidden;
  return placeholder;
}

/** Multiline note text: the newline is the only permitted control character. */
function validateNoteText(value: unknown, path: IssuePath, context: z.RefinementCtx): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_TEXT_NOTE_LENGTH) {
    issue(context, path, `text-note text must be a string of 1 to ${MAX_TEXT_NOTE_LENGTH} characters`);
    return;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 10) continue;
    if (code < 32 || code === 127) {
      issue(context, path, "text-note text allows newline as its only control character");
      return;
    }
  }
}

function validateNoteAuthor(value: unknown, path: IssuePath, context: z.RefinementCtx): void {
  if (value === undefined) return;
  const singleLine =
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_TEXT_NOTE_AUTHOR_LENGTH &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    });
  if (!singleLine) {
    issue(context, path, `text-note author must be a single line of 1 to ${MAX_TEXT_NOTE_AUTHOR_LENGTH} characters`);
  }
}

function validateNoteCreatedAt(value: unknown, path: IssuePath, context: z.RefinementCtx): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    issue(context, path, "text-note createdAt must be a positive epoch-millisecond integer");
  }
}

/**
 * Enforce the canonical channel contract on stored anchors [a, b, w]: the base line runs
 * through a and b, and the third anchor defines the signed width at its own time. Anchor
 * times are canonicalized to whole milliseconds for the shared parser; the width itself is
 * derived from the exact stored values.
 */
function validateChannelGeometry(points: unknown[], path: IssuePath, context: z.RefinementCtx): void {
  if (points.length !== 3) return;
  const [a, b, w] = points.map(asAnchor);
  if (!a || !b || !w) return;
  const spanTime = b.time - a.time;
  const width =
    spanTime === 0
      ? Number.NaN
      : w.price - (a.price + ((b.price - a.price) * (w.time - a.time)) / spanTime);
  try {
    parseChannelGeometryV1(
      {
        kind: "channel",
        a: { time: Math.round(a.time), price: a.price },
        b: { time: Math.round(b.time), price: b.price },
        width
      },
      "parallel-channel geometry"
    );
  } catch (error) {
    issue(context, path, error instanceof Error ? error.message : "Invalid parallel-channel geometry");
  }
}

function asAnchor(value: unknown): { time: number; price: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const point = value as Record<string, unknown>;
  const time = point.time;
  const price = point.price;
  if (typeof time !== "number" || !Number.isFinite(time)) return undefined;
  if (typeof price !== "number" || !Number.isFinite(price)) return undefined;
  return { time, price };
}

function issue(context: z.RefinementCtx, path: IssuePath, message: string): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}
