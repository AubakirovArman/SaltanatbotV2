import { createHash } from "node:crypto";
import type { Page, Route } from "@playwright/test";
import { installR52ScreenerFixture, R52_CSRF, R52_OWNER_ID, type R52ScreenerFixture } from "./r52ScreenerFixture";

export const R9C_OWNER_ID = R52_OWNER_ID;
export const R9C_CSRF = R52_CSRF;
export const R9C_ENTRY_ID = "40000000-0000-4000-8000-000000000131";
export const R9C_PUBLISHED_ID = "40000000-0000-4000-8000-000000000132";
export const R9C_ENTRY_TITLE = "Momentum breakout";
export const R9C_ENGINE_VERSION = "backtest-core-v1";
export const R9C_DATASET_FINGERPRINT = "d076618630cf584258a3d81c288db5d29d42c76329e1a27ab4373adf32001930";
export const R9C_PUBLISHED_AT = 1_752_800_000_000;

/** Imported IR travels through the real Blockly import boundary in the app. */
const FEED_IR = {
  name: "Gallery Momentum 42",
  inputs: [{ name: "period", value: 5 }],
  body: [
    { k: "entry", direction: "long", when: { k: "cross", dir: "above", a: { k: "price", field: "close" }, b: sma() } },
    { k: "exit", when: { k: "cross", dir: "below", a: { k: "price", field: "close" }, b: sma() } }
  ]
};

function sma(): Record<string, unknown> {
  return { k: "ma", kind: "sma", period: { k: "num", v: 5 }, source: { k: "price", field: "close" } };
}

export interface R9cGalleryRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  ownerHeader: string | null;
  csrfHeader: string | null;
  body?: Record<string, unknown>;
}

export interface R9cGalleryFixture {
  /** The underlying authenticated-shell fixture (auth, catalog, sockets, …). */
  readonly base: R52ScreenerFixture;
  readonly galleryRequests: R9cGalleryRequest[];
  readonly violations: string[];
  /** sha256 the browser must re-derive for the served feed bundle. */
  readonly feedArtifactHash: string;
}

/**
 * R9.3 fixture family extension: reuses the R5.2 authenticated browser
 * fixture for the whole shell, then registers the /api/gallery family LAST so
 * it wins over the base fixture's fail-closed 501 catch-all (Playwright
 * matches routes in reverse registration order). The feed serves ONE public
 * card whose import bundle carries a REAL sha256 over the canonical JSON of
 * the artifact — the client re-verifies the hash in the browser, so a fake
 * hash would fail the journey by design. Publish answers 201 with a frozen
 * owner record; nothing here ever reaches a database or starts a robot.
 */
export async function installR9cGalleryFixture(page: Page): Promise<R9cGalleryFixture> {
  const base = await installR52ScreenerFixture(page);
  const galleryRequests: R9cGalleryRequest[] = [];
  const violations: string[] = [];
  const feedBundle = feedArtifact();
  const feedHash = sha256Hex(canonicalStringify(feedBundle));

  const record = (route: Route): R9cGalleryRequest => {
    const request = route.request();
    const url = new URL(request.url());
    const entry: R9cGalleryRequest = {
      method: request.method(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      ownerHeader: request.headers()["x-sbv2-expected-user"] ?? null,
      csrfHeader: request.headers()["x-csrf-token"] ?? null,
      ...(parseBody(request.postData()) ? { body: parseBody(request.postData()) } : {})
    };
    galleryRequests.push(entry);
    if (entry.ownerHeader !== R9C_OWNER_ID) {
      violations.push(`${entry.method} ${entry.path}: owner ${entry.ownerHeader ?? "<missing>"}`);
    }
    if (entry.method === "POST" && entry.csrfHeader !== R9C_CSRF) {
      violations.push(`${entry.method} ${entry.path}: CSRF ${entry.csrfHeader ?? "<missing>"}`);
    }
    return entry;
  };

  await page.route("**/api/gallery**", (route) => {
    const entry = record(route);
    if (entry.method === "GET" && entry.path === "/api/gallery") {
      if (entry.query.scope === "own") return json(route, { entries: [] });
      return json(route, { entries: [feedCard(feedBundle, feedHash)] });
    }
    if (entry.method === "POST" && entry.path === "/api/gallery/publish") {
      const problem = publishProblem(entry.body);
      if (problem) {
        violations.push(`POST ${entry.path}: ${problem}`);
        return json(route, { code: "gallery_publish_invalid", error: problem }, 400);
      }
      return json(route, { artifact: publishedRecord(entry.body!) }, 201);
    }
    if (entry.method === "GET" && entry.path === `/api/gallery/${R9C_ENTRY_ID}/import`) {
      return json(route, {
        id: R9C_ENTRY_ID,
        version: 1,
        title: R9C_ENTRY_TITLE,
        summary: "OOS-tested momentum entry",
        publishedAt: R9C_PUBLISHED_AT,
        rating: feedRating(),
        artifact: feedBundle,
        artifactHash: feedHash
      });
    }
    violations.push(`unexpected gallery request: ${entry.method} ${entry.path}`);
    return json(route, { code: "unexpected_gallery_request", error: `${entry.method} ${entry.path}` }, 501);
  });

  return { base, galleryRequests, violations, feedArtifactHash: feedHash };
}

/** Reject envelopes the real route contract would refuse — the journey must send a valid one. */
function publishProblem(body: Record<string, unknown> | undefined): string | undefined {
  if (!body) return "missing body";
  const keys = Object.keys(body).sort();
  if (keys.join(",") !== "source,summary,title,visibility") return `keys ${keys.join(",")}`;
  const source = body.source as { type?: unknown; artifact?: { ir?: Record<string, unknown> } } | undefined;
  if (source?.type !== "library") return `source type ${String(source?.type)}`;
  if (!source.artifact || typeof source.artifact.ir !== "object" || source.artifact.ir === null) return "missing ir";
  if (typeof body.title !== "string" || body.title.length === 0) return "missing title";
  if (!["private", "unlisted", "public"].includes(String(body.visibility))) return `visibility ${String(body.visibility)}`;
  if (JSON.stringify(body).includes(R9C_OWNER_ID)) return "owner id leaked into the publish envelope";
  return undefined;
}

function publishedRecord(body: Record<string, unknown>): Record<string, unknown> {
  const source = body.source as { artifact: { ir: Record<string, unknown> } };
  const artifact = {
    schemaVersion: "gallery-artifact-v1",
    ir: source.artifact.ir,
    markets: [],
    metrics: { source: "self-reported" },
    engineVersion: R9C_ENGINE_VERSION,
    complexity: 512,
    limitations: "Metrics are self-reported by the publisher and were NOT verified by the server."
  };
  return {
    id: R9C_PUBLISHED_ID,
    version: 1,
    title: body.title,
    summary: body.summary,
    artifactSummary: withoutIr(artifact),
    artifactHash: sha256Hex(canonicalStringify(artifact)),
    rating: feedRating(),
    publishedAt: R9C_PUBLISHED_AT,
    visibility: body.visibility,
    status: "active",
    revokedAt: null,
    revokeReason: null,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
    artifact,
    owned: true
  };
}

function feedArtifact(): Record<string, unknown> {
  return {
    schemaVersion: "gallery-artifact-v1",
    ir: FEED_IR,
    markets: [
      { symbol: "BTCUSDT", timeframe: "1h", inSample: { netProfitPct: 9.5, maxDrawdownPct: 3.4, sharpe: 1.3 }, outOfSample: { netProfitPct: 4.2, maxDrawdownPct: 2.1, sharpe: 1.1 } }
    ],
    metrics: {
      source: "ga-oos",
      inSample: { netProfitPct: 9.5, maxDrawdownPct: 3.4, sharpe: 1.3 },
      outOfSample: { netProfitPct: 4.2, maxDrawdownPct: 2.1, sharpe: 1.1 },
      oos: { gapPct: { netProfitPct: 5.3 }, oosLossShare: 0, dispersion: 1.1, flags: { overfit: false, unstable: false } }
    },
    engineVersion: R9C_ENGINE_VERSION,
    generatorVersion: "bounded-grammar-v1",
    datasetFingerprint: R9C_DATASET_FINGERPRINT,
    seed: 42,
    complexity: 300,
    limitations: "Backtest evidence only: re-validate and backtest locally after import before any paper start."
  };
}

function feedCard(bundle: Record<string, unknown>, artifactHash: string): Record<string, unknown> {
  return {
    id: R9C_ENTRY_ID,
    version: 1,
    title: R9C_ENTRY_TITLE,
    summary: "OOS-tested momentum entry",
    artifactSummary: withoutIr(bundle),
    artifactHash,
    rating: feedRating(),
    publishedAt: R9C_PUBLISHED_AT,
    visibility: "public",
    status: "active"
  };
}

function feedRating(): Record<string, unknown> {
  return {
    score: 62,
    components: { oosStability: 0.8, drawdown: 0.7, reproducibility: 1, complexity: 0.5, evidenceFreshness: 0.9 },
    evidenceAgeDays: 3,
    reproducibility: { datasetFingerprint: true, seed: true, engineVersion: true, generatorVersion: true }
  };
}

function withoutIr(bundle: Record<string, unknown>): Record<string, unknown> {
  const { ir: _ir, ...summary } = bundle;
  return summary;
}

/** Canonical JSON (sorted keys, undefined dropped) — byte-identical to both hash sides. */
function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalStringify(member)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseBody(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(body)
  });
}
