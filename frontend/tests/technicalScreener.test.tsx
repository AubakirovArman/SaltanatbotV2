// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ScreenerRunResultV1 } from "@saltanatbotv2/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthContextValue } from "../src/auth/AuthRoot";
import { TechnicalScreener } from "../src/screener/TechnicalScreener";

const OWNER = "00000000-0000-4000-8000-000000000081";
const JOB_ID = "00000000-0000-4000-8000-000000000082";

let mountedRoot: Root | undefined;

beforeEach(() => {
  document.cookie = "sbv2_csrf=tech-csrf; path=/";
});

afterEach(async () => {
  if (mountedRoot) await act(async () => mountedRoot?.unmount());
  mountedRoot = undefined;
  vi.unstubAllGlobals();
  document.cookie = "sbv2_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
});

describe("technical screener workspace", () => {
  it("gates the server screener behind a registered owner without issuing requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const container = await renderScreener(vi.fn(), { withUser: false });

    expect(container.textContent).toContain("Sign in with a registered account");
    expect(container.querySelector(".tech-screener-form")).toBeNull();
    expect(container.textContent).toContain("Research-only screen");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adds an RSI filter, runs through the jobs API and opens rows with chart context", async () => {
    const fetchMock = mockScreenerFetch(runResult());
    vi.stubGlobal("fetch", fetchMock);
    const onOpenChart = vi.fn();
    const container = await renderScreener(onOpenChart);

    expect(container.querySelectorAll(".tech-screener-filter-row")).toHaveLength(1);
    await click(required(container.querySelector<HTMLButtonElement>(".tech-screener-add-filter button")));
    const rows = container.querySelectorAll(".tech-screener-filter-row");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.getAttribute("aria-label")).toContain("RSI");

    await submit(required(container.querySelector<HTMLFormElement>(".tech-screener-form")));

    const enqueue = fetchMock.mock.calls.find(([path, init]) => path === "/api/jobs" && init?.method === "POST");
    expect(enqueue).toBeDefined();
    const body = JSON.parse(String(enqueue?.[1]?.body)) as Record<string, any>;
    expect(body.kind).toBe("screener");
    expect(body.clientRequestId).toMatch(/^techrun-/);
    expect(body.request).toMatchObject({
      schemaVersion: "screener-run-request-v1",
      researchOnly: true,
      executionPermission: false
    });
    expect(body.request.definition.timeframe).toBe("1h");
    expect(body.request.definition.filters).toEqual([
      { kind: "quote-volume-24h", min: "1000000" },
      { kind: "rsi", period: 14, condition: "below", value: "30" }
    ]);
    const headers = new Headers(enqueue?.[1]?.headers);
    expect(headers.get("X-SBV2-Expected-User")).toBe(OWNER);
    expect(headers.get("X-CSRF-Token")).toBe("tech-csrf");

    const table = required(container.querySelector<HTMLTableElement>(".tech-screener-table"));
    expect(table.textContent).toContain("BTCUSDT");
    expect(table.textContent).toContain("28.4");
    expect(container.textContent).toContain("Matched");
    expect(container.querySelector("[role=status]")?.textContent ?? "").not.toContain("Unavailable symbols");

    await click(required(container.querySelector<HTMLButtonElement>('[aria-label="Open BTCUSDT chart with the screen timeframe and indicators"]')));
    expect(onOpenChart).toHaveBeenCalledWith({
      symbol: "BTCUSDT",
      exchange: "binance",
      marketType: "spot",
      priceType: "last",
      timeframe: "1h",
      indicators: [expect.objectContaining({ kind: "rsi", period: 14, enabled: true })]
    });
  });

  it("shows honest unavailable and truncated notices next to the results", async () => {
    vi.stubGlobal(
      "fetch",
      mockScreenerFetch(
        runResult({
          universe: { requested: 150, evaluated: 147, matched: 120, unavailable: 3 },
          unavailableReasons: { "indicator-warm-up": 2, "ticker-unavailable": 1 },
          rowsTruncated: true
        })
      )
    );
    const container = await renderScreener(vi.fn());

    await submit(required(container.querySelector<HTMLFormElement>(".tech-screener-form")));

    const notices = [...container.querySelectorAll('.arb-notice[role="status"]')].map((notice) => notice.textContent ?? "");
    expect(notices.some((text) => text.includes("Unavailable symbols (3)") && text.includes("indicator-warm-up × 2") && text.includes("ticker-unavailable × 1"))).toBe(true);
    expect(notices.some((text) => text.includes("Only the first 100 matches are shown"))).toBe(true);
    expect(container.querySelector(".tech-screener-table")?.textContent).toContain("BTCUSDT");
  });

  it("explains an empty match set without pretending unavailable data is zero", async () => {
    vi.stubGlobal("fetch", mockScreenerFetch(runResult({ universe: { requested: 100, evaluated: 100, matched: 0, unavailable: 0 }, rows: [] })));
    const container = await renderScreener(vi.fn());

    await submit(required(container.querySelector<HTMLFormElement>(".tech-screener-form")));

    const empty = required(container.querySelector(".arb-empty"));
    expect(empty.textContent).toContain("No symbols match this screen.");
    expect(empty.textContent).toContain("Unavailable data never counts as zero.");
    expect(container.querySelector(".tech-screener-table")).toBeNull();
  });

  it("promotes the current screen to a server alert with the exact rule envelope", async () => {
    const creates: Array<{ body: Record<string, any>; headers: Headers }> = [];
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (path === "/api/screener/presets" && (init?.method ?? "GET") === "GET") return Promise.resolve(json(presetList()));
      if (path === "/api/alerts" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, any>;
        creates.push({ body, headers: new Headers(init.headers) });
        return Promise.resolve(json({ rule: alertRuleRecord(body) }, 201));
      }
      return Promise.resolve(json({ code: "unexpected_mock_request", error: `${init?.method ?? "GET"} ${path}` }, 501));
    });
    vi.stubGlobal("fetch", fetchMock);
    const container = await renderScreener(vi.fn());

    await click(required(container.querySelector<HTMLButtonElement>('[aria-label="Create alert from this screen"]')));
    await act(async () => flushAsync());

    expect(creates).toHaveLength(1);
    const { body, headers } = creates[0]!;
    expect(Object.keys(body).sort()).toEqual(["clientId", "definition"]);
    expect(body.clientId).toMatch(/^screen-alert-/);
    // The promotion embeds the screen definition by value, so the alert keeps
    // this exact revision even if the form changes later.
    expect(body.definition).toEqual({
      schemaVersion: "alert-rule-v1",
      kind: "screener",
      name: "Momentum screen",
      enabled: true,
      cooldownSeconds: 3600,
      deliveryChannels: ["in-app"],
      screen: {
        schemaVersion: "screener-definition-v1",
        kind: "technical",
        name: "Momentum screen",
        exchange: "binance",
        marketType: "spot",
        priceType: "last",
        timeframe: "1h",
        universeLimit: 100,
        sort: { key: "quoteVolume24h", direction: "desc" },
        filters: [{ kind: "quote-volume-24h", min: "1000000" }],
        researchOnly: true,
        executionPermission: false
      },
      repeat: "on-change",
      researchOnly: true,
      executionPermission: false
    });
    expect(headers.get("X-SBV2-Expected-User")).toBe(OWNER);
    expect(headers.get("X-CSRF-Token")).toBe("tech-csrf");
    expect(headers.get("Content-Type")).toBe("application/json");

    const status = required(container.querySelector(".tech-screener-alert-created"));
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toContain("Server alert “Momentum screen” created");
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/jobs")).toBe(false);
  });

  it("surfaces the screen-alert quota as an actionable error without pretending success", async () => {
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (path === "/api/screener/presets" && (init?.method ?? "GET") === "GET") return Promise.resolve(json(presetList()));
      if (path === "/api/alerts" && init?.method === "POST") {
        return Promise.resolve(json({ code: "screener_alert_quota_exceeded", error: "Too many enabled screener alerts." }, 429));
      }
      return Promise.resolve(json({ code: "unexpected_mock_request", error: `${init?.method ?? "GET"} ${path}` }, 501));
    });
    vi.stubGlobal("fetch", fetchMock);
    const container = await renderScreener(vi.fn());

    await click(required(container.querySelector<HTMLButtonElement>('[aria-label="Create alert from this screen"]')));
    await act(async () => flushAsync());

    const alert = required(container.querySelector('[role="alert"]'));
    expect(alert.textContent).toContain("Screen alert limit reached. Disable or archive one first.");
    expect(container.querySelector(".tech-screener-alert-created")).toBeNull();
  });

  it("reports a network failure as service unavailability, not as an empty result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) => {
        if (path === "/api/screener/presets") return Promise.resolve(json(presetList()));
        return Promise.reject(new TypeError("Failed to fetch"));
      })
    );
    const container = await renderScreener(vi.fn());

    await submit(required(container.querySelector<HTMLFormElement>(".tech-screener-form")));

    const alert = required(container.querySelector('[role="alert"]'));
    expect(alert.textContent).toContain("The screener service is temporarily unavailable.");
    expect(container.querySelector(".tech-screener-table")).toBeNull();
    expect(container.querySelector(".arb-empty")).toBeNull();
  });
});

async function renderScreener(onOpenChart: ReturnType<typeof vi.fn>, options: { withUser?: boolean } = {}): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  mountedRoot = createRoot(container);
  await act(async () => {
    mountedRoot?.render(
      <AuthContext.Provider value={authValue(options.withUser ?? true)}>
        <TechnicalScreener locale="en" onOpenChart={onOpenChart} />
      </AuthContext.Provider>
    );
    await flushAsync();
  });
  return container;
}

function authValue(withUser: boolean): AuthContextValue {
  return {
    authRequired: true,
    openAccount: () => undefined,
    refreshSession: async () => undefined,
    tradingRoleAssignmentsEnabled: false,
    tradingAvailable: false,
    ...(withUser
      ? {
          user: {
            id: OWNER,
            login: "screen-owner",
            status: "active" as const,
            appRole: "user" as const,
            tradingRole: "none" as const,
            mustChangePassword: false,
            authorizationRevision: 1
          }
        }
      : {})
  };
}

function mockScreenerFetch(result: ScreenerRunResultV1) {
  return vi.fn((path: string, init?: RequestInit) => {
    if (path === "/api/screener/presets" && (init?.method ?? "GET") === "GET") return Promise.resolve(json(presetList()));
    if (path === "/api/jobs" && init?.method === "POST") return Promise.resolve(json({ job: { id: JOB_ID, status: "completed", result } }));
    return Promise.resolve(json({ code: "unexpected_mock_request", error: `${init?.method ?? "GET"} ${path}` }, 501));
  });
}

function runResult(overrides: Partial<ScreenerRunResultV1> = {}): ScreenerRunResultV1 {
  return {
    schemaVersion: "screener-run-result-v1",
    definitionHash: "b".repeat(64),
    generatedAt: "2026-07-17T08:02:00.000Z",
    timeframe: "1h",
    closedBarTimeMin: 1_752_735_600_000,
    closedBarTimeMax: 1_752_739_200_000,
    universe: { requested: 100, evaluated: 100, matched: 1, unavailable: 0 },
    unavailableReasons: {},
    rows: [
      {
        symbol: "BTCUSDT",
        lastClose: "64703.52",
        closedBarTime: 1_752_739_200_000,
        change24hPercent: "2.15",
        quoteVolume24h: "1284000000",
        metrics: { rsi: "28.4" },
        matchedFilters: 2
      }
    ],
    rowsTruncated: false,
    researchOnly: true,
    executionPermission: false,
    ...overrides
  };
}

function alertRuleRecord(body: Record<string, any>) {
  return {
    schemaVersion: "alert-rule-record-v1" as const,
    id: "00000000-0000-4000-8000-000000000091",
    clientId: body.clientId as string,
    revision: 1,
    definition: body.definition as Record<string, unknown>,
    lifecycleState: "armed" as const,
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:00:00.000Z",
    researchOnly: true as const,
    executionPermission: false as const
  };
}

function presetList() {
  return {
    schemaVersion: "screener-preset-list-v1" as const,
    presets: [],
    generatedAt: "2026-07-17T08:00:00.000Z",
    researchOnly: true as const,
    executionPermission: false as const
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushAsync();
  });
}

/** Settles fetch mocks and their streamed body reads, which need macrotask turns. */
async function flushAsync(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected screener element is missing.");
  return value;
}
