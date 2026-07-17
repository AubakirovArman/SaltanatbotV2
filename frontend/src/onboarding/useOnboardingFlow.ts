import { useCallback, useEffect, type Dispatch, type SetStateAction } from "react";
import type { AppMode, WorkspaceTemplateKind } from "../app/useAppShell";
import type { ConnectionState } from "../hooks/useMarketStream";
import { warmStrategyLab } from "../strategy/loadStrategyLab";
import type { OnboardingGoal } from "./types";
import type { OnboardingController } from "./useOnboarding";

interface OnboardingFlowOptions {
  readonly onboarding: OnboardingController;
  readonly mode: AppMode;
  readonly chartConnection: ConnectionState;
  readonly hasPrimaryCandles: boolean;
  readonly alerts: readonly { createdAt: number }[];
  readonly isMobile: boolean;
  readonly rightOpen: boolean;
  readonly setMode: Dispatch<SetStateAction<AppMode>>;
  readonly setMobilePanel: Dispatch<SetStateAction<"markets" | "instrument" | undefined>>;
  readonly setNewPaperBotRequest: Dispatch<SetStateAction<number>>;
  createWorkspaceTemplate(kind: WorkspaceTemplateKind): boolean;
  toggleRight(): void;
}

export function useOnboardingFlow({ onboarding, mode, chartConnection, hasPrimaryCandles, alerts, isMobile, rightOpen, setMode, setMobilePanel, setNewPaperBotRequest, createWorkspaceTemplate, toggleRight }: OnboardingFlowOptions) {
  useEffect(() => {
    const state = onboarding.state;
    if (onboarding.busy || onboarding.error || state?.status !== "in_progress" || state.goal !== "monitoring" || mode !== "chart" || !["connected", "fallback"].includes(chartConnection) || !hasPrimaryCandles) {
      return;
    }
    void onboarding.recordMilestone("chart-ready");
  }, [chartConnection, hasPrimaryCandles, mode, onboarding.busy, onboarding.error, onboarding.recordMilestone, onboarding.state]);

  useEffect(() => {
    const state = onboarding.state;
    if (onboarding.busy || onboarding.error || state?.status !== "in_progress" || state.goal !== "price-alert") {
      return;
    }
    if (alerts.length === 0) return;
    void onboarding.recordMilestone("price-alert-created");
  }, [alerts, onboarding.busy, onboarding.error, onboarding.recordMilestone, onboarding.state]);

  const navigate = useCallback(
    (goal: OnboardingGoal) => {
      if (goal === "monitoring") setMode("chart");
      if (goal === "price-alert") {
        setMode("chart");
        if (isMobile) setMobilePanel("instrument");
        else if (!rightOpen) toggleRight();
      }
      if (goal === "backtest") {
        setMode("strategy");
        warmStrategyLab();
      }
      if (goal === "paper-robot") {
        setMode("trade");
        setNewPaperBotRequest((request) => request + 1);
      }
    },
    [isMobile, rightOpen, setMobilePanel, setMode, setNewPaperBotRequest, toggleRight]
  );

  const selectGoal = useCallback(
    async (goal: OnboardingGoal) => {
      if (!(await onboarding.selectGoal(goal))) return;
      createWorkspaceTemplate(templateForGoal(goal));
      navigate(goal);
    },
    [createWorkspaceTemplate, navigate, onboarding.selectGoal]
  );

  const reopen = useCallback(async () => {
    const state = onboarding.state;
    if (onboarding.phase === "error" || !state) {
      onboarding.retry();
      return;
    }
    if (state.status === "completed" || state.status === "dismissed") {
      await onboarding.restart();
      return;
    }
    if (state.status === "in_progress" && state.goal) navigate(state.goal);
  }, [navigate, onboarding.phase, onboarding.restart, onboarding.retry, onboarding.state]);

  const onBacktestCompleted = useCallback(() => {
    if (onboarding.state?.status === "in_progress" && onboarding.state.goal === "backtest") {
      void onboarding.recordMilestone("backtest-completed");
    }
  }, [onboarding.recordMilestone, onboarding.state]);

  const onPaperBotCreated = useCallback(() => {
    if (onboarding.state?.status === "in_progress" && onboarding.state.goal === "paper-robot") {
      void onboarding.recordMilestone("paper-bot-created");
    }
  }, [onboarding.recordMilestone, onboarding.state]);

  return {
    selectGoal,
    reopen,
    onBacktestCompleted,
    onPaperBotCreated
  };
}

function templateForGoal(goal: OnboardingGoal): WorkspaceTemplateKind {
  if (goal === "backtest") return "backtest";
  if (goal === "paper-robot") return "paper-robot";
  return "monitoring";
}
