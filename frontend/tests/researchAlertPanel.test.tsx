// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteResearchAlertPolicy, saveResearchAlertPolicy } from "../src/trading/researchAlertClient";
import { parseResearchAlertPolicyInput, parseResearchAlertState } from "../src/trading/researchAlertParser";
import { ResearchAlertPanel } from "../src/trading/components/research-alerts/ResearchAlertPanel";
import { ResearchAlertDeliveryTable } from "../src/trading/components/research-alerts/ResearchAlertTables";
import type { ResearchAlertPolicyInput, ResearchAlertState } from "../src/trading/researchAlertTypes";

const POLICY_ID = "11111111-1111-4111-8111-111111111111";
const DELIVERY_ID = "22222222-2222-4222-8222-222222222222";
const NOW = 2_000_000_000_000;
let root: Root | undefined;
let mountedNode: HTMLDivElement | undefined;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  mountedNode?.remove();
  mountedNode = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("protected research alert browser boundary", () => {
  it("parses the exact bounded research-only state and rejects unsafe or oversized data", () => {
    const parsed = parseResearchAlertState(stateFixture());
    expect(parsed).toMatchObject({ schemaVersion: 1, researchOnly: true, executionPermission: false });
    expect(parsed.policies[0]).toMatchObject({ id: POLICY_ID, minimumEvidenceQuality: "verified", cooldownSeconds: 300 });
    expect(parsed.deliveries[0]).toMatchObject({ id: DELIVERY_ID, status: "retrying", researchOnly: true, executionPermission: false });

    const executable = stateFixture();
    executable.executionPermission = true as false;
    expect(() => parseResearchAlertState(executable)).toThrow(/research-only safety envelope/);

    const credentialLeak = { ...stateFixture(), apiSecret: "must-never-render" };
    expect(() => parseResearchAlertState(credentialLeak)).toThrow(/missing or unknown fields/);

    const oversized = stateFixture();
    oversized.deliveries = Array.from({ length: 101 }, () => structuredClone(oversized.deliveries[0]!));
    expect(() => parseResearchAlertState(oversized)).toThrow(/at most 100 rows/);

    expect(() => parseResearchAlertPolicyInput({ ...policyInput(), families: ["basis", "basis"] })).toThrow(/duplicate families/);
    expect(() => parseResearchAlertPolicyInput({ ...policyInput(), maximumObservationAgeMs: 99 })).toThrow(/100/);
  });

  it("uses the internal cookie session and CSRF token for save and delete mutations", async () => {
    sessionStorage.setItem("sbv2:session", "1");
    sessionStorage.setItem("sbv2:csrf", "csrf-research-alert-test");
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.method === "DELETE"
        ? { schemaVersion: 1, researchOnly: true, executionPermission: false, policies: [] }
        : { schemaVersion: 1, researchOnly: true, executionPermission: false, policy: stateFixture().policies[0] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await saveResearchAlertPolicy(policyInput());
    await deleteResearchAlertPolicy(POLICY_ID);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [saveUrl, saveInit] = fetchMock.mock.calls[0]!;
    const saveHeaders = new Headers(saveInit?.headers);
    expect(saveUrl).toBe("/api/trade/arbitrage-alerts/research");
    expect(saveInit).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(saveHeaders.get("X-CSRF-Token")).toBe("csrf-research-alert-test");
    expect(saveHeaders.get("Authorization")).toBeNull();
    expect(JSON.parse(String(saveInit?.body))).toEqual(policyInput());

    const [deleteUrl, deleteInit] = fetchMock.mock.calls[1]!;
    const deleteHeaders = new Headers(deleteInit?.headers);
    expect(deleteUrl).toBe(`/api/trade/arbitrage-alerts/research/${POLICY_ID}`);
    expect(deleteInit).toMatchObject({ method: "DELETE", credentials: "same-origin" });
    expect(deleteHeaders.get("X-CSRF-Token")).toBe("csrf-research-alert-test");
  });

  it("renders EN/RU/KK safety copy, thresholds and outbox errors without any order or credential control", () => {
    const en = renderToStaticMarkup(<ResearchAlertPanel locale="en" />);
    const ru = renderToStaticMarkup(<ResearchAlertPanel locale="ru" />);
    const kk = renderToStaticMarkup(<ResearchAlertPanel locale="kk" />);
    expect(en).toContain("Research only · execution disabled");
    expect(ru).toContain("Только исследование · исполнение отключено");
    expect(kk).toContain("Тек зерттеу · орындау өшірулі");
    for (const markup of [en, ru, kk]) {
      expect(markup).toContain('action="/api/trade/arbitrage-alerts/research"');
      expect(markup).toContain('name="research-alert-minimum-profit"');
      expect(markup).toContain('name="research-alert-cooldown"');
      expect(markup).not.toContain("apiSecret");
      expect(markup).not.toContain("Place order");
    }

    const outbox = renderToStaticMarkup(<ResearchAlertDeliveryTable locale="ru" deliveries={parseResearchAlertState(stateFixture()).deliveries} />);
    expect(outbox).toContain("research-only-delivery-error");
    expect(outbox).toContain("Нет разрешения на исполнение");
    expect(outbox).toContain("рисковый капитал");
    expect(outbox).toContain("crypto:btc");
  });

  it("does not load or poll while hidden and resumes on visibility", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const load = vi.fn(async () => parseResearchAlertState(stateFixture()));
    mountedNode = document.createElement("div");
    document.body.append(mountedNode);
    root = createRoot(mountedNode);

    await act(async () => root?.render(<ResearchAlertPanel locale="en" pollIntervalMs={5_000} load={load} />));
    expect(load).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(load).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => {
      vi.advanceTimersByTime(20_000);
      await Promise.resolve();
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("edits through the bounded POST form and requires a second action before delete", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const value = parseResearchAlertState(stateFixture());
    const load = vi.fn(async () => value);
    const save = vi.fn(async (input: ResearchAlertPolicyInput) => ({ schemaVersion: 1 as const, researchOnly: true as const, executionPermission: false as const, policy: { ...value.policies[0]!, ...input, id: POLICY_ID, updatedAt: NOW } }));
    const remove = vi.fn(async () => ({ schemaVersion: 1 as const, researchOnly: true as const, executionPermission: false as const, policies: [] }));
    mountedNode = document.createElement("div");
    document.body.append(mountedNode);
    root = createRoot(mountedNode);

    await act(async () => {
      root?.render(<ResearchAlertPanel locale="en" load={load} save={save} remove={remove} />);
      await Promise.resolve();
    });
    const edit = [...mountedNode.querySelectorAll("button")].find((button) => button.textContent === "Edit");
    expect(edit).toBeTruthy();
    await act(async () => edit?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect((mountedNode.querySelector('input[name="research-alert-name"]') as HTMLInputElement).value).toBe("Verified BTC routes");

    const form = mountedNode.querySelector("form");
    await act(async () => {
      form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: POLICY_ID, cooldownSeconds: 300 }));

    const requestDelete = [...mountedNode.querySelectorAll("button")].find((button) => button.textContent === "Delete");
    await act(async () => requestDelete?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(remove).not.toHaveBeenCalled();
    const confirm = [...mountedNode.querySelectorAll("button")].find((button) => button.textContent === "Confirm deletion");
    await act(async () => {
      confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(remove).toHaveBeenCalledWith(POLICY_ID);
  });
});

function policyInput(): ResearchAlertPolicyInput {
  return {
    name: "Verified BTC routes",
    families: ["basis", "triangular", "n-leg"],
    economicAssetIds: ["crypto:btc"],
    minimumConservativeNetProfit: 25,
    minimumNetEdgeBps: 12,
    minimumCapacityValuation: 5_000,
    maximumRiskCapitalValuation: 20_000,
    minimumEvidenceQuality: "verified",
    maximumObservationAgeMs: 5_000,
    maximumEconomicsAgeMs: 7_500,
    maximumIdentityAgeMs: 86_400_000,
    cooldownSeconds: 300,
    enabled: true
  };
}

function stateFixture(): ResearchAlertState {
  const input = policyInput();
  return {
    schemaVersion: 1,
    researchOnly: true,
    executionPermission: false,
    policies: [{ ...input, id: POLICY_ID, createdAt: NOW - 10_000, updatedAt: NOW - 5_000 }],
    deliveries: [{
      id: DELIVERY_ID,
      policyId: POLICY_ID,
      dedupKey: "research-alert:crypto:btc:basis",
      routeId: "basis:btc:binance-bybit",
      family: "basis",
      economicAssetId: "crypto:btc",
      observationId: "observation:btc:42",
      conservativeNetProfit: 42.5,
      netEdgeBps: 18.25,
      riskCapitalValuation: 8_000,
      capacityValuation: 10_000,
      createdAt: NOW - 4_000,
      researchOnly: true,
      executionPermission: false,
      status: "retrying",
      attempts: 2,
      maxAttempts: 6,
      queuedAt: NOW - 4_000,
      lastAttemptAt: NOW - 2_000,
      nextAttemptAt: NOW + 2_000,
      lastError: "research-only-delivery-error"
    }],
    lastWorkerError: "notification channel unavailable"
  };
}
