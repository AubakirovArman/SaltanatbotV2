export const ONBOARDING_GOALS = [
  "monitoring",
  "price-alert",
  "backtest",
  "paper-robot"
] as const;

export type OnboardingGoal = (typeof ONBOARDING_GOALS)[number];

export const ONBOARDING_MILESTONES = [
  "chart-ready",
  "price-alert-created",
  "backtest-completed",
  "paper-bot-created"
] as const;

export type OnboardingMilestone = (typeof ONBOARDING_MILESTONES)[number];

export type OnboardingStatus =
  | "not_started"
  | "in_progress"
  | "completed"
  | "dismissed";

export interface OnboardingMilestones {
  chartReadyAt: string | null;
  priceAlertCreatedAt: string | null;
  backtestCompletedAt: string | null;
  paperBotCreatedAt: string | null;
}

export interface OnboardingState {
  schemaVersion: 1;
  revision: number;
  status: OnboardingStatus;
  goal: OnboardingGoal | null;
  goalSelectedAt: string | null;
  milestones: OnboardingMilestones;
  completedAt: string | null;
  dismissedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export function emptyOnboardingState(): OnboardingState {
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
    updatedAt: null
  };
}
