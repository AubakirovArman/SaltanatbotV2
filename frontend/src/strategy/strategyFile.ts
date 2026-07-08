// File-based portability for strategies: a small `.strategy` JSON envelope that
// mirrors the URL-hash sharing in share.ts, but travels as a downloadable file.
import type { StrategyArtifact } from "./library";

export const STRATEGY_FILE_FORMAT = "saltanatbotv2.strategy";
export const STRATEGY_FILE_VERSION = 1;

export interface StrategyFile {
  format: typeof STRATEGY_FILE_FORMAT;
  version: number;
  name: string;
  description: string;
  xml: string;
  exportedAt: number;
}

/** Serialize an artifact into the portable envelope JSON string. */
export function encodeStrategyFile(artifact: Pick<StrategyArtifact, "name" | "description" | "xml">): string {
  const file: StrategyFile = {
    format: STRATEGY_FILE_FORMAT,
    version: STRATEGY_FILE_VERSION,
    name: artifact.name,
    description: artifact.description ?? "",
    xml: artifact.xml,
    exportedAt: Date.now()
  };
  return JSON.stringify(file, null, 2);
}

/** Parse + validate a `.strategy` file's text. Returns null on any malformed input. */
export function parseStrategyFile(raw: string): StrategyFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Partial<StrategyFile>;
  if (value.format !== STRATEGY_FILE_FORMAT) return null;
  if (typeof value.xml !== "string" || !value.xml.includes("strategy_start")) return null;
  return {
    format: STRATEGY_FILE_FORMAT,
    version: typeof value.version === "number" ? value.version : STRATEGY_FILE_VERSION,
    name: typeof value.name === "string" && value.name.trim() ? value.name : "Imported strategy",
    description: typeof value.description === "string" ? value.description : "",
    xml: value.xml,
    exportedAt: typeof value.exportedAt === "number" ? value.exportedAt : Date.now()
  };
}

/** Trigger a browser download of the envelope as a `.strategy` file (no deps). */
export function downloadStrategyFile(artifact: Pick<StrategyArtifact, "name" | "description" | "xml">) {
  const json = encodeStrategyFile(artifact);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${slugify(artifact.name) || "strategy"}.strategy`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick so the click has committed to the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
