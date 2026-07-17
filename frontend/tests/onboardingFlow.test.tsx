// @vitest-environment jsdom

import { act, type Dispatch, type SetStateAction } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOnboardingFlow } from "../src/onboarding/useOnboardingFlow";
import type { OnboardingController } from "../src/onboarding/useOnboarding";
import type { OnboardingState } from "../src/onboarding/types";
import type { AppMode } from "../src/app/useAppShell";

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  document.body.innerHTML = "";
});

describe("onboarding application flow", () => {
  it("creates a workspace only for the initial goal selection", async () => {
    const createWorkspaceTemplate = vi.fn(() => true);
    const controller = onboardingController(state());
    let flow: ReturnType<typeof useOnboardingFlow> | undefined;
    const host = document.createElement("div");
    const root = createRoot(host);

    await act(async () =>
      root.render(
        <Harness
          onboarding={controller}
          createWorkspaceTemplate={createWorkspaceTemplate}
          onFlow={(next) => {
            flow = next;
          }}
        />
      )
    );
    await act(async () => {
      await flow?.selectGoal("backtest");
    });
    expect(createWorkspaceTemplate).toHaveBeenCalledTimes(1);
    expect(createWorkspaceTemplate).toHaveBeenCalledWith("backtest");

    const active = onboardingController(
      state({
        status: "in_progress",
        goal: "backtest",
        goalSelectedAt: "2026-07-16T20:00:00.000Z"
      })
    );
    await act(async () =>
      root.render(
        <Harness
          onboarding={active}
          createWorkspaceTemplate={createWorkspaceTemplate}
          onFlow={(next) => {
            flow = next;
          }}
        />
      )
    );
    await act(async () => {
      await flow?.reopen();
    });
    expect(createWorkspaceTemplate).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it("records a backtest milestone only for an active backtest goal", async () => {
    const backtest = onboardingController(
      state({
        status: "in_progress",
        goal: "backtest",
        goalSelectedAt: "2026-07-16T20:00:00.000Z"
      })
    );
    let flow: ReturnType<typeof useOnboardingFlow> | undefined;
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <Harness
          onboarding={backtest}
          createWorkspaceTemplate={vi.fn(() => true)}
          onFlow={(next) => {
            flow = next;
          }}
        />
      )
    );

    act(() => flow?.onBacktestCompleted());
    expect(backtest.recordMilestone).toHaveBeenCalledOnce();
    expect(backtest.recordMilestone).toHaveBeenCalledWith("backtest-completed");

    const monitoring = onboardingController(
      state({
        status: "in_progress",
        goal: "monitoring",
        goalSelectedAt: "2026-07-16T20:00:00.000Z"
      })
    );
    await act(async () =>
      root.render(
        <Harness
          onboarding={monitoring}
          createWorkspaceTemplate={vi.fn(() => true)}
          onFlow={(next) => {
            flow = next;
          }}
        />
      )
    );
    act(() => flow?.onBacktestCompleted());
    expect(monitoring.recordMilestone).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("records chart readiness only after both the connection and candle signal are ready", async () => {
    const monitoring = onboardingController(
      state({
        status: "in_progress",
        goal: "monitoring",
        goalSelectedAt: "2026-07-16T20:00:00.000Z"
      })
    );
    const host = document.createElement("div");
    const root = createRoot(host);

    await act(async () => root.render(<Harness onboarding={monitoring} chartConnection="connected" hasPrimaryCandles={false} createWorkspaceTemplate={vi.fn(() => true)} onFlow={() => undefined} />));
    expect(monitoring.recordMilestone).not.toHaveBeenCalled();

    await act(async () => root.render(<Harness onboarding={monitoring} chartConnection="connected" hasPrimaryCandles createWorkspaceTemplate={vi.fn(() => true)} onFlow={() => undefined} />));
    expect(monitoring.recordMilestone).toHaveBeenCalledOnce();
    expect(monitoring.recordMilestone).toHaveBeenCalledWith("chart-ready");
    await act(async () => root.unmount());
  });

  it("accepts an owner-scoped existing alert without comparing client and server clocks", async () => {
    const alertGoal = onboardingController(
      state({
        status: "in_progress",
        goal: "price-alert",
        goalSelectedAt: "2099-01-01T00:00:00.000Z"
      })
    );
    const host = document.createElement("div");
    const root = createRoot(host);

    await act(async () => root.render(<Harness onboarding={alertGoal} alerts={[{ createdAt: 1 }]} createWorkspaceTemplate={vi.fn(() => true)} onFlow={() => undefined} />));
    expect(alertGoal.recordMilestone).toHaveBeenCalledWith("price-alert-created");
    await act(async () => root.unmount());
  });
});

function Harness({
  onboarding,
  createWorkspaceTemplate,
  onFlow,
  chartConnection = "idle",
  hasPrimaryCandles = false,
  alerts = []
}: {
  onboarding: OnboardingController;
  createWorkspaceTemplate: (kind: "monitoring" | "research" | "backtest" | "paper-robot") => boolean;
  onFlow(flow: ReturnType<typeof useOnboardingFlow>): void;
  chartConnection?: "connecting" | "connected" | "fallback" | "idle";
  hasPrimaryCandles?: boolean;
  alerts?: readonly { createdAt: number }[];
}) {
  const flow = useOnboardingFlow({
    onboarding,
    mode: "chart",
    chartConnection,
    hasPrimaryCandles,
    alerts,
    isMobile: false,
    rightOpen: false,
    setMode: vi.fn() as Dispatch<SetStateAction<AppMode>>,
    setMobilePanel: vi.fn() as Dispatch<SetStateAction<"markets" | "instrument" | undefined>>,
    setNewPaperBotRequest: vi.fn() as Dispatch<SetStateAction<number>>,
    createWorkspaceTemplate,
    toggleRight: vi.fn()
  });
  onFlow(flow);
  return null;
}

function onboardingController(current: OnboardingState): OnboardingController {
  return {
    phase: "ready",
    state: current,
    busy: false,
    retry: vi.fn(),
    selectGoal: vi.fn().mockResolvedValue(true),
    recordMilestone: vi.fn().mockResolvedValue(true),
    dismiss: vi.fn().mockResolvedValue(true),
    restart: vi.fn().mockResolvedValue(true)
  };
}

function state(overrides: Partial<OnboardingState> = {}): OnboardingState {
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
