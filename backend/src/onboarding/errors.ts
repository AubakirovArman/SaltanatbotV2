import type { OnboardingState } from "./types.js";

export class OnboardingConflictError extends Error {
  constructor(readonly current: OnboardingState) {
    super("Onboarding revision conflict. Reload the current progress before retrying.");
  }
}

export class OnboardingAuthorizationChangedError extends Error {
  constructor() {
    super("Onboarding authorization changed. Reload before retrying.");
  }
}
