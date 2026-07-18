// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GalleryPanel } from "../src/strategy/components/GalleryPanel";
import type { GalleryImportDraft } from "../src/strategy/galleryImport";
import { galleryText } from "../src/strategy/galleryText";
import type { StrategyArtifact } from "../src/strategy/library";
import { starterStrategyXml } from "../src/strategy/starter";
import { canonicalStringify } from "../src/strategy/strategyFile";
import { CreateBotForm } from "../src/trading/components/CreateBotForm";

const OWNER = "00000000-0000-4000-8000-000000000091";
const ENTRY_ID = "00000000-0000-4000-8000-000000000092";

const CLEAN_IR = {
  name: "Gallery Momentum 42",
  inputs: [],
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
    markets: [{ symbol: "BTCUSDT", timeframe: "1h", inSample: { netProfitPct: 9.5 }, outOfSample: { netProfitPct: 4.2 } }],
    metrics: {
      source: "ga-oos",
      inSample: { netProfitPct: 9.5, maxDrawdownPct: 3.4 },
      outOfSample: { netProfitPct: 4.2, maxDrawdownPct: 2.1 },
      oos: { gapPct: { netProfitPct: 5.3 }, oosLossShare: 0, dispersion: 1.1, flags: { overfit: false, unstable: false } }
    },
    engineVersion: "backtest-core-v1",
    datasetFingerprint: "e".repeat(64),
    seed: 42,
    complexity: 300,
    limitations: "Backtest evidence only."
  };
}

function serverHash(artifact: unknown): string {
  return createHash("sha256").update(canonicalStringify(artifact)).digest("hex");
}

function feedCard(artifact: Record<string, unknown>): Record<string, unknown> {
  const { ir: _ir, ...artifactSummary } = artifact;
  return {
    id: ENTRY_ID,
    version: 1,
    title: "Momentum breakout",
    summary: "OOS-tested momentum entry",
    artifactSummary,
    artifactHash: serverHash(artifact),
    rating: {
      score: 62,
      components: { oosStability: 0.8, drawdown: 0.7, reproducibility: 1, complexity: 0.5, evidenceFreshness: 0.9 },
      evidenceAgeDays: 3,
      reproducibility: { datasetFingerprint: true, seed: true, engineVersion: true, generatorVersion: false }
    },
    publishedAt: 1_760_000_000_000,
    visibility: "public",
    status: "active"
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const starterArtifact: StrategyArtifact = {
  id: "strategy:price-cross-ema",
  kind: "strategy",
  name: "Price Cross EMA",
  description: "Starter",
  xml: starterStrategyXml,
  createdAt: 1,
  updatedAt: 1
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.cookie = "sbv2_csrf=gallery-csrf; path=/";
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    }
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    }
  });
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.cookie = "sbv2_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
});

function stubGalleryFetch(artifact: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/api/gallery/") && url.includes("/import")) {
      return json({ id: ENTRY_ID, version: 1, title: "Momentum breakout", summary: "OOS-tested momentum entry", artifact, artifactHash: serverHash(artifact) });
    }
    if (url.includes("/api/gallery/publish")) {
      return json({ artifact: { id: ENTRY_ID, version: 1, artifactHash: serverHash(artifact) } }, 201);
    }
    if (url.includes("/api/gallery")) {
      return json({ entries: [feedCard(artifact)] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

async function renderPanel(overrides: Partial<Parameters<typeof GalleryPanel>[0]> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <GalleryPanel
        locale="en"
        ownerUserId={OWNER}
        artifacts={[starterArtifact]}
        activeId={starterArtifact.id}
        onClose={() => {}}
        onImportGalleryStrategy={() => {}}
        {...overrides}
      />
    );
    await Promise.resolve();
  });
  return { container, root };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

function findButton(root: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === label);
}

async function unmount(root: Root): Promise<void> {
  await act(async () => root.unmount());
}

describe("gallery feed cards", () => {
  it("renders provenance, metric comparison and a rating breakdown that is never return-only", async () => {
    stubGalleryFetch(galleryArtifact());
    const { container, root } = await renderPanel();
    await waitFor(() => container.textContent?.includes("Momentum breakout") ?? false, "feed card");

    const card = container.querySelector(".gallery-server-card")!;
    expect(card.textContent).toContain("backtest-core-v1");
    expect(card.textContent).toContain("eeeeeeeeeeeeeeee");
    expect(card.textContent).toContain("Server-evaluated out-of-sample evidence");
    expect(card.textContent).toContain("BTCUSDT:1h");
    expect(card.textContent).toContain("In-sample");
    expect(card.textContent).toContain("Out-of-sample");
    // The composite is always accompanied by its component breakdown.
    expect(card.textContent).toContain("Rating: 62/100");
    expect(card.textContent).toContain("OOS stability");
    expect(card.textContent).toContain("Reproducibility");
    expect(card.textContent).toContain("never a net-profit-only ranking");
    expect(card.textContent).toContain("Backtest evidence only.");
    await unmount(root);
  });

  it("localizes the panel in Russian and Kazakh", async () => {
    for (const locale of ["ru", "kk"] as const) {
      stubGalleryFetch(galleryArtifact());
      const { container, root } = await renderPanel({ locale });
      await waitFor(() => container.textContent?.includes("Momentum breakout") ?? false, `${locale} feed`);
      expect(container.textContent).toContain(galleryText(locale, "title"));
      expect(container.textContent).toContain(galleryText(locale, "tabFeed"));
      expect(container.textContent).toContain(galleryText(locale, "ratingNote"));
      expect(container.textContent).toContain(galleryText(locale, "metricsGaOos"));
      await unmount(root);
      document.body.innerHTML = "";
    }
  });
});

describe("gallery import review flow", () => {
  it("verifies the hash, requires explicit review confirmation and creates a revalidation-gated draft", async () => {
    const artifact = galleryArtifact();
    stubGalleryFetch(artifact);
    const drafts: GalleryImportDraft[] = [];
    const { container, root } = await renderPanel({ onImportGalleryStrategy: (draft) => drafts.push(draft) });
    await waitFor(() => container.textContent?.includes("Momentum breakout") ?? false, "feed card");

    await click(findButton(container.querySelector(".gallery-server-card")!, "Import")!);
    await waitFor(() => container.textContent?.includes(galleryText("en", "importReviewTitle")) ?? false, "review dialog");
    expect(drafts).toHaveLength(0);
    const review = container.querySelector(".gallery-import-review-dialog")!;
    expect(review.textContent).toContain(serverHash(artifact));
    expect(review.textContent).toContain(galleryText("en", "importGateNote"));

    await click(findButton(review, galleryText("en", "importConfirm"))!);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.artifact.provenance.source).toBe("gallery");
    expect(drafts[0]!.gallery.artifactHash).toBe(serverHash(artifact));
    expect(container.textContent).toContain(galleryText("en", "imported"));
    await unmount(root);
  });

  it("refuses a tampered bundle with an explicit hash-mismatch error", async () => {
    const artifact = galleryArtifact();
    const staleHash = serverHash(artifact);
    const tampered = { ...artifact, metrics: { source: "ga-oos", outOfSample: { netProfitPct: 900 } } };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/import")) return json({ id: ENTRY_ID, version: 1, artifact: tampered, artifactHash: staleHash });
      return json({ entries: [feedCard(artifact)] });
    }));
    const drafts: GalleryImportDraft[] = [];
    const { container, root } = await renderPanel({ onImportGalleryStrategy: (draft) => drafts.push(draft) });
    await waitFor(() => container.textContent?.includes("Momentum breakout") ?? false, "feed card");

    await click(findButton(container.querySelector(".gallery-server-card")!, "Import")!);
    await waitFor(() => container.textContent?.includes(galleryText("en", "hashMismatch")) ?? false, "hash mismatch refusal");
    expect(drafts).toHaveLength(0);
    expect(container.querySelector(".gallery-import-review-dialog")).toBeNull();
    await unmount(root);
  });
});

describe("gallery publish dialog", () => {
  it("shows the exact sanitization preview and publishes only after explicit consent", async () => {
    const { calls } = stubGalleryFetch(galleryArtifact());
    const { container, root } = await renderPanel();
    await waitFor(() => container.textContent?.includes("Momentum breakout") ?? false, "feed card");

    await click(findButton(container, galleryText("en", "publish"))!);
    await waitFor(() => container.querySelector(".gallery-publish-dialog") !== null, "publish dialog");
    const dialog = container.querySelector<HTMLElement>(".gallery-publish-dialog")!;
    await waitFor(() => dialog.querySelector(".gallery-preview-canonical") !== null, "sanitization preview");

    const canonical = dialog.querySelector(".gallery-preview-canonical")!.textContent!;
    expect(canonical).toContain('"schemaVersion":"gallery-artifact-v1"');
    expect(canonical).toContain('"source":"self-reported"');
    expect(canonical).not.toContain(OWNER);

    const publishButton = findButton(dialog, galleryText("en", "publishAction"))!;
    expect(publishButton.disabled).toBe(true);

    const consent = dialog.querySelector<HTMLInputElement>('input[name="gallery-consent"]')!;
    await act(async () => {
      consent.click();
      await Promise.resolve();
    });
    expect(publishButton.disabled).toBe(false);

    await click(publishButton);
    await waitFor(() => calls.some((call) => call.url.includes("/api/gallery/publish")), "publish request");
    const publishCall = calls.find((call) => call.url.includes("/api/gallery/publish"))!;
    const body = JSON.parse(String(publishCall.init?.body));
    expect(body.source.type).toBe("library");
    expect(body.source.artifact.ir.name).toBe("Price Cross EMA");
    expect(body.visibility).toBe("private");
    expect(String(publishCall.init?.body)).not.toContain(OWNER);
    await waitFor(() => container.textContent?.includes(galleryText("en", "published")) ?? false, "publish status");
    await unmount(root);
  });
});

describe("paper start lock for gallery copies", () => {
  it("keeps bot creation locked until the copy's local validation + backtest completed", async () => {
    const gated: StrategyArtifact = {
      ...starterArtifact,
      id: "strategy:gallery-77",
      name: "Gallery copy",
      provenance: { source: "gallery", importedAt: 1 },
      galleryImport: { galleryId: ENTRY_ID, artifactHash: "a".repeat(64), importedAt: 1, revalidationRequired: true }
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<CreateBotForm strategies={[gated]} locale="en" onCreated={() => {}} />);
      await Promise.resolve();
    });
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    expect(container.textContent).toContain(galleryText("en", "paperStartLocked"));

    const revalidated: StrategyArtifact = {
      ...gated,
      galleryImport: { ...gated.galleryImport!, revalidationRequired: false, revalidatedAt: 2 }
    };
    await act(async () => {
      root.render(<CreateBotForm strategies={[revalidated]} locale="en" onCreated={() => {}} />);
      await Promise.resolve();
    });
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    expect(container.textContent).not.toContain(galleryText("en", "paperStartLocked"));
    await unmount(root);
  });
});
