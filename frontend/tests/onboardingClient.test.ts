// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadOnboarding, OnboardingApiError, parseOnboarding, selectOnboardingGoal } from "../src/onboarding/client";
import type { OnboardingState } from "../src/onboarding/types";

const OWNER = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  document.cookie = "sbv2_csrf=onboarding-csrf; path=/";
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = "sbv2_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
});

describe("onboarding client", () => {
  it("loads only the expected authenticated owner with no-store transport", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ onboarding: onboardingState() }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadOnboarding(OWNER)).resolves.toMatchObject({
      status: "not_started",
      revision: 0
    });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/onboarding");
    expect(init.credentials).toBe("same-origin");
    expect(init.cache).toBe("no-store");
    const headers = new Headers(init.headers);
    expect(headers.get("X-SBV2-Expected-User")).toBe(OWNER);
    expect(headers.get("X-CSRF-Token")).toBeNull();
  });

  it("sends revision, CSRF and exact owner for goal mutations", async () => {
    const next = onboardingState({
      revision: 1,
      status: "in_progress",
      goal: "backtest",
      goalSelectedAt: "2026-07-16T20:00:00.000Z",
      createdAt: "2026-07-16T20:00:00.000Z",
      updatedAt: "2026-07-16T20:00:00.000Z"
    });
    const fetchMock = vi.fn().mockResolvedValue(json({ onboarding: next }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(selectOnboardingGoal(OWNER, onboardingState(), "backtest")).resolves.toMatchObject({ goal: "backtest", revision: 1 });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/onboarding/goal");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      revision: 0,
      goal: "backtest"
    });
    const headers = new Headers(init.headers);
    expect(headers.get("X-SBV2-Expected-User")).toBe(OWNER);
    expect(headers.get("X-CSRF-Token")).toBe("onboarding-csrf");
  });

  it("surfaces the authoritative state from a revision conflict", async () => {
    const current = onboardingState({
      revision: 2,
      status: "in_progress",
      goal: "monitoring",
      goalSelectedAt: "2026-07-16T20:00:00.000Z",
      createdAt: "2026-07-16T20:00:00.000Z",
      updatedAt: "2026-07-16T20:01:00.000Z"
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(
          {
            error: "Conflict",
            code: "onboarding_conflict",
            current
          },
          409
        )
      )
    );

    const error = await selectOnboardingGoal(OWNER, onboardingState(), "backtest").catch((cause) => cause);
    expect(error).toBeInstanceOf(OnboardingApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "onboarding_conflict",
      current: { revision: 2, goal: "monitoring" }
    });
  });

  it("rejects impossible completed and credential-bearing response shapes", () => {
    expect(() =>
      parseOnboarding(
        onboardingState({
          status: "completed",
          goal: "monitoring",
          completedAt: null
        })
      )
    ).toThrow(/completedAt/);
    expect(JSON.stringify(onboardingState())).not.toMatch(/api.?key|credential|exchange.?account/i);
  });
});

function onboardingState(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    schemaVersion: 1,
    revision: 0,
    status: "not_started",
    goal: null,
    goalSelectedAt: null,
    milestones: {
      chartReadyAt: null,
      priceAlertCreatedAt: null,
      backtestCompletedAt: null,
      paperBotCreatedAt: null
    },
    completedAt: null,
    dismissedAt: null,
    createdAt: null,
    updatedAt: null,
    ...overrides
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
