// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OnboardingController, useOnboarding } from "../src/onboarding/useOnboarding";

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("useOnboarding owner lifecycle", () => {
  it("aborts and ignores a stale response after the authenticated owner changes", async () => {
    const requests = new Map<
      string,
      {
        signal?: AbortSignal;
        resolve(response: Response): void;
      }
    >();
    vi.stubGlobal(
      "fetch",
      vi.fn((_path: string, init: RequestInit) => {
        const owner = new Headers(init.headers).get("X-SBV2-Expected-User")!;
        return new Promise<Response>((resolve) => {
          requests.set(owner, { signal: init.signal ?? undefined, resolve });
        });
      })
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<Harness owner={OWNER_A} />));
    await vi.waitFor(() => expect(requests.has(OWNER_A)).toBe(true));

    await act(async () => root.render(<Harness owner={OWNER_B} />));
    await vi.waitFor(() => expect(requests.has(OWNER_B)).toBe(true));
    expect(requests.get(OWNER_A)?.signal?.aborted).toBe(true);
    expect(container.textContent).toBe("loading:none:none");

    await act(async () => {
      requests.get(OWNER_B)?.resolve(
        json({
          onboarding: state({
            revision: 1,
            status: "in_progress",
            goal: "backtest",
            goalSelectedAt: "2026-07-16T20:00:00.000Z",
            createdAt: "2026-07-16T20:00:00.000Z",
            updatedAt: "2026-07-16T20:00:00.000Z"
          })
        })
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(container.textContent).toBe("ready:backtest:1"));

    await act(async () => {
      requests.get(OWNER_A)?.resolve(json({ onboarding: state() }));
      await Promise.resolve();
    });
    expect(container.textContent).toBe("ready:backtest:1");
    await act(async () => root.unmount());
  });

  it("allows only one mutation to start within the same render frame", async () => {
    let controller: OnboardingController | undefined;
    let resolveMutation: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((_path: string, init: RequestInit) => {
      if (init.method === "GET") {
        return Promise.resolve(json({ onboarding: state() }));
      }
      return new Promise<Response>((resolve) => {
        resolveMutation = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <Harness
          owner={OWNER_A}
          onController={(next) => {
            controller = next;
          }}
        />
      )
    );
    await vi.waitFor(() => expect(container.textContent).toBe("ready:none:0"));

    let first: Promise<boolean> | undefined;
    let duplicate: Promise<boolean> | undefined;
    await act(async () => {
      first = controller?.selectGoal("monitoring");
      duplicate = controller?.selectGoal("backtest");
      await Promise.resolve();
    });

    expect(fetchMock.mock.calls.filter(([, init]) => init.method !== "GET")).toHaveLength(1);
    await act(async () => {
      resolveMutation?.(
        json({
          onboarding: state({
            revision: 1,
            status: "in_progress",
            goal: "monitoring",
            goalSelectedAt: "2026-07-16T20:00:00.000Z",
            createdAt: "2026-07-16T20:00:00.000Z",
            updatedAt: "2026-07-16T20:00:00.000Z"
          })
        })
      );
      await expect(first).resolves.toBe(true);
      await expect(duplicate).resolves.toBe(false);
    });
    expect(container.textContent).toBe("ready:monitoring:1");
    await act(async () => root.unmount());
  });

  it("never blocks the application tree when loading fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<Harness owner={OWNER_A} />));
    await vi.waitFor(() => expect(container.textContent).toBe("error:none:none"));
    await act(async () => root.unmount());
  });
});

function Harness({
  owner,
  onController
}: {
  owner: string;
  onController?: (controller: OnboardingController) => void;
}) {
  const onboarding = useOnboarding(owner, true);
  onController?.(onboarding);
  return (
    <span>
      {onboarding.phase}:{onboarding.state?.goal ?? "none"}:{onboarding.state?.revision ?? "none"}
    </span>
  );
}

function state(overrides: Record<string, unknown> = {}) {
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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
