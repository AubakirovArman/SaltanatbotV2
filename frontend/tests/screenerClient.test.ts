// @vitest-environment jsdom

import type { ScreenerDefinitionV1, ScreenerPresetListV1, ScreenerPresetV1, ScreenerRunRequestV1, ScreenerRunResultV1 } from "@saltanatbotv2/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveScreenerPreset,
  createScreenerPreset,
  listScreenerPresets,
  runScreener,
  SCREENER_API_MAX_ERROR_MESSAGE_LENGTH,
  SCREENER_API_MAX_RESPONSE_BYTES,
  SCREENER_API_TIMEOUT_MS,
  SCREENER_RUN_POLL_INTERVAL_MS,
  ScreenerApiError,
  updateScreenerPreset
} from "../src/screener/client";

const OWNER = "00000000-0000-4000-8000-000000000071";
const PRESET_ID = "00000000-0000-4000-8000-000000000072";
const JOB_ID = "00000000-0000-4000-8000-000000000073";
const CLIENT_REQUEST_ID = "browser.screen-run-0001";
const SIGNAL = new AbortController().signal;

beforeEach(() => {
  document.cookie = "sbv2_csrf=screener-csrf; path=/";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.cookie = "sbv2_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
});

describe("owner-scoped screener API client", () => {
  it("lists presets with no-store owner-bound transport and the shared parser", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(list()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listScreenerPresets(OWNER, SIGNAL)).resolves.toEqual(list());

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/screener/presets");
    expect(init).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store"
    });
    expect(init.signal).not.toBe(SIGNAL);
    expect(init.signal?.aborted).toBe(false);
    const headers = new Headers(init.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("X-SBV2-Expected-User")).toBe(OWNER);
    expect(headers.get("X-CSRF-Token")).toBeNull();
  });

  it("creates a preset with an exact envelope, CSRF token and shared record parsing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ preset: preset() }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createScreenerPreset(OWNER, { clientId: "browser.screen-01", definition }, SIGNAL)).resolves.toEqual(preset());

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/screener/presets");
    expect(init.method).toBe("POST");
    expect(init.signal).not.toBe(SIGNAL);
    expect(init.signal?.aborted).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({
      clientId: "browser.screen-01",
      definition
    });
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-SBV2-Expected-User")).toBe(OWNER);
    expect(headers.get("X-CSRF-Token")).toBe("screener-csrf");
  });

  it("uses exact update and archive routes with optimistic revisions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ preset: preset({ revision: 2 }) }))
      .mockResolvedValueOnce(json({ preset: preset({ revision: 3, archivedAt: "2026-07-17T08:03:00.000Z" }) }));
    vi.stubGlobal("fetch", fetchMock);

    await updateScreenerPreset(OWNER, PRESET_ID, { expectedRevision: 1, definition }, SIGNAL);
    await archiveScreenerPreset(OWNER, PRESET_ID, 2, SIGNAL);

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([`/api/screener/presets/${PRESET_ID}`, `/api/screener/presets/${PRESET_ID}/archive`]);
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(["PUT", "POST"]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      expectedRevision: 1,
      definition
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      expectedRevision: 2
    });
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.signal).not.toBe(SIGNAL);
      expect(init.signal?.aborted).toBe(false);
      expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("screener-csrf");
    }
  });

  it("enqueues a run through the jobs API and polls to a parsed completed result", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ job: { id: JOB_ID, status: "queued" } }, 202))
      .mockResolvedValueOnce(json({ job: { id: JOB_ID, status: "running" } }, 202))
      .mockResolvedValueOnce(json({ job: { id: JOB_ID, status: "completed", result: runResult() } }));
    vi.stubGlobal("fetch", fetchMock);

    const run = runScreener(OWNER, runRequest(), { clientRequestId: CLIENT_REQUEST_ID });
    const settled = expect(run).resolves.toEqual(runResult());
    await vi.advanceTimersByTimeAsync(SCREENER_RUN_POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(SCREENER_RUN_POLL_INTERVAL_MS);
    await settled;

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/jobs", `/api/jobs/${JOB_ID}`, `/api/jobs/${JOB_ID}`]);
    const [, enqueueInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(enqueueInit.method).toBe("POST");
    expect(JSON.parse(String(enqueueInit.body))).toEqual({
      kind: "screener",
      clientRequestId: CLIENT_REQUEST_ID,
      request: runRequest()
    });
    expect(new Headers(enqueueInit.headers).get("X-CSRF-Token")).toBe("screener-csrf");
    for (const [, init] of fetchMock.mock.calls.slice(1)) {
      expect(init).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store" });
      expect(new Headers(init.headers).get("X-SBV2-Expected-User")).toBe(OWNER);
      expect(new Headers(init.headers).get("X-CSRF-Token")).toBeNull();
    }
  });

  it("stops at the bounded run deadline and issues a best-effort cancel", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((path: string, init: RequestInit) =>
      Promise.resolve(init.method === "POST" && path.endsWith("/cancel") ? json({ job: { id: JOB_ID, status: "cancelled" } }) : json({ job: { id: JOB_ID, status: "queued" } }, 202))
    );
    vi.stubGlobal("fetch", fetchMock);

    const run = runScreener(OWNER, runRequest(), { clientRequestId: CLIENT_REQUEST_ID, pollIntervalMs: 250, timeoutMs: 1_000 });
    const settled = expect(run).rejects.toMatchObject({ status: 0, code: "run_timeout" });
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
    await vi.runAllTimersAsync();

    const paths = fetchMock.mock.calls.map(([path]) => path);
    expect(paths[0]).toBe("/api/jobs");
    expect(paths.at(-1)).toBe(`/api/jobs/${JOB_ID}/cancel`);
    expect(fetchMock.mock.calls.at(-1)?.[1]?.method).toBe("POST");
  });

  it("surfaces failed and cancelled jobs as typed errors instead of results", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ job: { id: JOB_ID, status: "failed", errorCode: "screener_run_failed", errorMessage: "Universe snapshot unavailable." } }))
        .mockResolvedValueOnce(json({ job: { id: JOB_ID, status: "cancelled" } }))
    );

    await expect(runScreener(OWNER, runRequest(), { clientRequestId: CLIENT_REQUEST_ID })).rejects.toMatchObject({
      status: 0,
      code: "screener_run_failed",
      message: "Universe snapshot unavailable."
    });
    await expect(runScreener(OWNER, runRequest(), { clientRequestId: CLIENT_REQUEST_ID })).rejects.toMatchObject({
      status: 0,
      code: "run_cancelled"
    });
  });

  it("fails closed when a completed job or a preset envelope bypasses the shared parsers", async () => {
    const malformedResult = { ...runResult(), executionPermission: true };
    const malformedPreset = { preset: { ...preset(), ownerUserId: OWNER } };
    const wrappedPreset = { preset: preset(), extra: true };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ job: { id: JOB_ID, status: "completed", result: malformedResult } }))
        .mockResolvedValueOnce(json(malformedPreset, 201))
        .mockResolvedValueOnce(json(wrappedPreset, 201))
    );

    await expect(runScreener(OWNER, runRequest(), { clientRequestId: CLIENT_REQUEST_ID })).rejects.toMatchObject({
      status: 0,
      code: "invalid_response"
    });
    await expect(createScreenerPreset(OWNER, { clientId: "browser.screen-01", definition })).rejects.toMatchObject({ status: 201, code: "invalid_response" });
    await expect(createScreenerPreset(OWNER, { clientId: "browser.screen-01", definition })).rejects.toMatchObject({ status: 201, code: "invalid_response" });
  });

  it("bounds streamed JSON before parsing and never reflects the oversized body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ padding: "x".repeat(SCREENER_API_MAX_RESPONSE_BYTES + 1) })));

    const error = await listScreenerPresets(OWNER).catch((cause) => cause);
    expect(error).toBeInstanceOf(ScreenerApiError);
    expect(error).toMatchObject({
      status: 200,
      code: "screener_response_too_large"
    });
    expect(error.message).not.toContain("xxxx");
  });

  it("normalizes and bounds server error envelopes deterministically", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(
          {
            code: "screener_preset_revision_conflict",
            error: `  reload\n${"x".repeat(2_000)}  `
          },
          409
        )
      )
    );

    const error = await archiveScreenerPreset(OWNER, PRESET_ID, 1).catch((cause) => cause);
    expect(error).toBeInstanceOf(ScreenerApiError);
    expect(error).toMatchObject({ status: 409, code: "screener_preset_revision_conflict" });
    expect(error.message.startsWith("reload ")).toBe(true);
    expect(error.message.length).toBe(SCREENER_API_MAX_ERROR_MESSAGE_LENGTH);

    const constructed = new ScreenerApiError(999, "INVALID CODE", "\n\t");
    expect(constructed).toMatchObject({
      status: 0,
      code: "screener_error",
      message: "Screener request failed."
    });
  });

  it("rejects malformed ownership, identifiers and revisions locally without issuing a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(listScreenerPresets("other-user")).rejects.toMatchObject({
      status: 0,
      code: "invalid_request"
    });
    expect(() => archiveScreenerPreset(OWNER, PRESET_ID, 0)).toThrowError(expect.objectContaining({ status: 0, code: "invalid_request" }));
    expect(() => updateScreenerPreset(OWNER, "not-a-uuid", { expectedRevision: 1, definition })).toThrowError(expect.objectContaining({ status: 0, code: "invalid_request" }));
    expect(() => createScreenerPreset(OWNER, { clientId: "нет", definition })).toThrowError(expect.objectContaining({ status: 0, code: "invalid_request" }));
    await expect(runScreener(OWNER, runRequest(), { clientRequestId: "short" })).rejects.toMatchObject({ status: 0, code: "invalid_request" });
    await expect(
      runScreener(OWNER, { ...runRequest(), presetId: PRESET_ID } as ScreenerRunRequestV1, { clientRequestId: CLIENT_REQUEST_ID })
    ).rejects.toMatchObject({ status: 0, code: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts a stalled request at the bounded client timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_path: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })));

    const request = expect(listScreenerPresets(OWNER)).rejects.toMatchObject({
      status: 0,
      code: "request_timeout"
    });
    await vi.advanceTimersByTimeAsync(SCREENER_API_TIMEOUT_MS);
    await request;
  });
});

const definition: ScreenerDefinitionV1 = {
  schemaVersion: "screener-definition-v1",
  kind: "technical",
  name: "Momentum screen",
  exchange: "binance",
  marketType: "spot",
  priceType: "last",
  timeframe: "1h",
  universeLimit: 100,
  sort: { key: "quoteVolume24h", direction: "desc" },
  filters: [
    { kind: "quote-volume-24h", min: "1000000" },
    { kind: "rsi", period: 14, condition: "below", value: "30" }
  ],
  researchOnly: true,
  executionPermission: false
};

function runRequest(): ScreenerRunRequestV1 {
  return {
    schemaVersion: "screener-run-request-v1",
    definition,
    researchOnly: true,
    executionPermission: false
  };
}

function runResult(): ScreenerRunResultV1 {
  return {
    schemaVersion: "screener-run-result-v1",
    definitionHash: "a".repeat(64),
    generatedAt: "2026-07-17T08:02:00.000Z",
    timeframe: "1h",
    closedBarTimeMin: 1_752_735_600_000,
    closedBarTimeMax: 1_752_739_200_000,
    universe: { requested: 100, evaluated: 98, matched: 1, unavailable: 2 },
    unavailableReasons: { "indicator-warm-up": 2 },
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
    executionPermission: false
  };
}

function preset(overrides: Partial<ScreenerPresetV1> = {}): ScreenerPresetV1 {
  return {
    id: PRESET_ID,
    clientId: "browser.screen-01",
    revision: 1,
    definition,
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:01:00.000Z",
    researchOnly: true,
    executionPermission: false,
    ...overrides
  };
}

function list(): ScreenerPresetListV1 {
  return {
    schemaVersion: "screener-preset-list-v1",
    presets: [preset()],
    generatedAt: "2026-07-17T08:02:00.000Z",
    researchOnly: true,
    executionPermission: false
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
