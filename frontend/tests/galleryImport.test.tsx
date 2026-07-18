// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { galleryArtifactHash, importGalleryArtifact, GalleryApiError, type GalleryImportBundle } from "../src/strategy/galleryClient";
import {
  completeGalleryRevalidation,
  galleryBundleToPortableArtifact,
  galleryIrDocument,
  galleryRevalidationPending
} from "../src/strategy/galleryImport";
import type { StrategyArtifact } from "../src/strategy/library";
import { canonicalStringify } from "../src/strategy/strategyFile";
import { useArtifactLibrary } from "../src/strategy/useArtifactLibrary";

// The library hook pre-warms the Strategy Lab chunk on import actions; the
// real dynamic import (Blockly + editor) can outlive this file's jsdom
// environment in a full-suite run, so stub the warmup boundary.
vi.mock("../src/strategy/loadStrategyLab", () => ({
  loadStrategyLab: vi.fn(async () => ({ default: () => null })),
  warmStrategyLab: vi.fn()
}));

const OWNER = "00000000-0000-4000-8000-0000000000aa";
const ENTRY_ID = "00000000-0000-4000-8000-0000000000ab";

/** Serializable through the real Blockly XML serializer (entry/exit + crossover). */
const CLEAN_IR = {
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

function galleryArtifact(): Record<string, unknown> {
  return {
    schemaVersion: "gallery-artifact-v1",
    ir: CLEAN_IR,
    markets: [{ symbol: "BTCUSDT", timeframe: "1h", outOfSample: { netProfitPct: 4.2 } }],
    metrics: { source: "ga-oos", outOfSample: { netProfitPct: 4.2, maxDrawdownPct: 2.1 } },
    engineVersion: "backtest-core-v1",
    datasetFingerprint: "e".repeat(64),
    seed: 42,
    complexity: 300,
    limitations: "Backtest evidence only."
  };
}

/** The server-side algorithm: sha256 over the canonical JSON. */
function serverHash(artifact: unknown): string {
  return createHash("sha256").update(canonicalStringify(artifact)).digest("hex");
}

function importEnvelope(artifact: Record<string, unknown>, artifactHash: string): Response {
  return new Response(
    JSON.stringify({ id: ENTRY_ID, version: 2, title: "Momentum breakout", summary: "OOS-tested", artifact, artifactHash }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  window.localStorage.clear();
});

describe("gallery IR document gate", () => {
  it("accepts a plausible StrategyIR and rejects structurally broken documents", () => {
    expect(galleryIrDocument(CLEAN_IR as unknown as Record<string, unknown>)).toBeDefined();
    expect(galleryIrDocument(undefined)).toBeUndefined();
    expect(galleryIrDocument({ inputs: [], body: [] })).toBeUndefined();
    expect(galleryIrDocument({ name: "x", inputs: {}, body: [] } as unknown as Record<string, unknown>)).toBeUndefined();
    expect(galleryIrDocument({ name: "x", inputs: [{ name: "p", value: Number.NaN }], body: [] })).toBeUndefined();
  });
});

describe("client/server hash parity and tamper refusal", () => {
  it("derives the same sha256 as the server-side canonical algorithm (stability golden)", async () => {
    const artifact = galleryArtifact();
    await expect(galleryArtifactHash(artifact)).resolves.toBe(serverHash(artifact));
    // Key order never changes the canonical hash.
    const reordered = Object.fromEntries(Object.entries(artifact).reverse());
    await expect(galleryArtifactHash(reordered)).resolves.toBe(serverHash(artifact));
  });

  it("imports a bundle whose declared hash matches the served content", async () => {
    const artifact = galleryArtifact();
    vi.stubGlobal("fetch", vi.fn(async () => importEnvelope(artifact, serverHash(artifact))));
    const bundle = await importGalleryArtifact(OWNER, ENTRY_ID);
    expect(bundle.artifactHash).toBe(serverHash(artifact));
    expect(bundle.version).toBe(2);
    expect(bundle.artifact.engineVersion).toBe("backtest-core-v1");
  });

  it("refuses a tampered bundle served with a stale hash (tamper simulation)", async () => {
    const artifact = galleryArtifact();
    const staleHash = serverHash(artifact);
    const tampered = { ...artifact, metrics: { source: "ga-oos", outOfSample: { netProfitPct: 400 } } };
    vi.stubGlobal("fetch", vi.fn(async () => importEnvelope(tampered, staleHash)));
    await expect(importGalleryArtifact(OWNER, ENTRY_ID)).rejects.toMatchObject({ code: "gallery_hash_mismatch" });
    await expect(importGalleryArtifact(OWNER, ENTRY_ID)).rejects.toBeInstanceOf(GalleryApiError);
  });
});

describe("gallery import copy model", () => {
  it("builds an independent portable copy with gallery provenance and carries the verified hash", async () => {
    const artifact = galleryArtifact();
    const bundle: GalleryImportBundle = {
      id: ENTRY_ID,
      version: 2,
      raw: artifact,
      artifact: (await importedView(artifact))!,
      artifactHash: serverHash(artifact)
    };
    const draft = galleryBundleToPortableArtifact(bundle, { title: "Momentum breakout", summary: "OOS-tested" });
    expect(draft.artifact.kind).toBe("strategy");
    expect(draft.artifact.name).toBe("Momentum breakout");
    expect(draft.artifact.xml).toContain("strategy_start");
    expect(draft.artifact.parameters).toEqual([{ name: "period", value: 5 }]);
    expect(draft.artifact.provenance).toEqual({ source: "gallery", exportedFromId: ENTRY_ID, parentHash: serverHash(artifact) });
    expect(draft.artifact.description).toContain(`sha256 ${serverHash(artifact)}`);
    expect(draft.artifact.description).toContain("Backtest evidence only.");
    expect(draft.gallery).toEqual({ id: ENTRY_ID, version: 2, artifactHash: serverHash(artifact), title: "Momentum breakout" });
  });

  it("completes the revalidation gate only when one is pending", () => {
    const gated: StrategyArtifact = {
      id: "strategy:gallery-1",
      kind: "strategy",
      name: "Copy",
      description: "",
      xml: "<xml/>",
      galleryImport: { galleryId: ENTRY_ID, artifactHash: "a".repeat(64), importedAt: 1, revalidationRequired: true },
      createdAt: 1,
      updatedAt: 1
    };
    expect(galleryRevalidationPending(gated)).toBe(true);
    const cleared = completeGalleryRevalidation(gated, 99);
    expect(cleared.galleryImport).toMatchObject({ revalidationRequired: false, revalidatedAt: 99 });
    expect(galleryRevalidationPending(cleared)).toBe(false);
    // Idempotent on a cleared or absent gate.
    expect(completeGalleryRevalidation(cleared, 120)).toBe(cleared);
    expect(completeGalleryRevalidation({ ...gated, galleryImport: undefined }, 120).galleryImport).toBeUndefined();
  });

  it("creates a revalidation-gated library copy through useArtifactLibrary and unlocks it on markArtifactRevalidated", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const artifact = galleryArtifact();
    const bundle: GalleryImportBundle = {
      id: ENTRY_ID,
      version: 1,
      raw: artifact,
      artifact: (await importedView(artifact))!,
      artifactHash: serverHash(artifact)
    };
    const draft = galleryBundleToPortableArtifact(bundle, { title: "Momentum breakout" });
    let library: ReturnType<typeof useArtifactLibrary> | undefined;
    function Probe() {
      library = useArtifactLibrary({ initialArtifacts: [], setIndicators: () => {}, openStrategyWorkspace: () => {} });
      return null;
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<Probe />));

    await act(async () => library!.importGalleryStrategy(draft));
    const copy = library!.artifacts[0]!;
    expect(copy.provenance?.source).toBe("gallery");
    expect(copy.galleryImport).toMatchObject({
      galleryId: ENTRY_ID,
      galleryVersion: 1,
      artifactHash: serverHash(artifact),
      revalidationRequired: true
    });

    await act(async () => library!.markArtifactRevalidated(copy.id));
    expect(library!.artifacts[0]!.galleryImport).toMatchObject({ revalidationRequired: false, revalidatedAt: expect.any(Number) });
    await act(async () => root.unmount());
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  });
});

async function importedView(artifact: Record<string, unknown>) {
  const { parseArtifactView } = await import("../src/strategy/galleryClient");
  return parseArtifactView(artifact);
}
