export const ONBOARDING_GOALS = ["monitoring", "price-alert", "backtest", "paper-robot"] as const;

export type OnboardingGoal = (typeof ONBOARDING_GOALS)[number];

export const ONBOARDING_MILESTONES = ["chart-ready", "price-alert-created", "backtest-completed", "paper-bot-created"] as const;

export type OnboardingMilestone = (typeof ONBOARDING_MILESTONES)[number];

export type OnboardingStatus = "not_started" | "in_progress" | "completed" | "dismissed";

export interface OnboardingState {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly status: OnboardingStatus;
  readonly goal: OnboardingGoal | null;
  readonly goalSelectedAt: string | null;
  readonly milestones: {
    readonly chartReadyAt: string | null;
    readonly priceAlertCreatedAt: string | null;
    readonly backtestCompletedAt: string | null;
    readonly paperBotCreatedAt: string | null;
  };
  readonly completedAt: string | null;
  readonly dismissedAt: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export function milestoneCompleted(state: OnboardingState, milestone: OnboardingMilestone): boolean {
  switch (milestone) {
    case "chart-ready":
      return state.milestones.chartReadyAt !== null;
    case "price-alert-created":
      return state.milestones.priceAlertCreatedAt !== null;
    case "backtest-completed":
      return state.milestones.backtestCompletedAt !== null;
    case "paper-bot-created":
      return state.milestones.paperBotCreatedAt !== null;
  }
}

export function milestoneForGoal(goal: OnboardingGoal): OnboardingMilestone {
  switch (goal) {
    case "monitoring":
      return "chart-ready";
    case "price-alert":
      return "price-alert-created";
    case "backtest":
      return "backtest-completed";
    case "paper-robot":
      return "paper-bot-created";
  }
}
