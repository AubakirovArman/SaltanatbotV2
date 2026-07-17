import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../hooks/useModalFocus";
import type { Locale } from "../i18n";
import { onboardingGoalText, onboardingText } from "../i18n/onboarding";
import { ONBOARDING_GOALS, type OnboardingGoal } from "./types";

export interface OnboardingDialogProps {
  readonly locale: Locale;
  readonly open: boolean;
  readonly busy: boolean;
  readonly error?: string;
  readonly canCreatePaperRobot: boolean;
  onSelect(goal: OnboardingGoal): void;
  onDismiss(): void;
  onRetry(): void;
}

export function OnboardingDialog({ locale, open, busy, error, canCreatePaperRobot, onSelect, onDismiss, onRetry }: OnboardingDialogProps) {
  const modal = useModalFocus<HTMLDivElement>(onDismiss, ".onboarding-goal:not(:disabled)", open);
  if (!open) return null;

  return createPortal(
    <div
      className="onboarding-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onDismiss();
      }}
    >
      <div ref={modal.dialogRef} tabIndex={-1} className="onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" aria-describedby="onboarding-intro" onKeyDown={modal.onKeyDown}>
        <header>
          <div>
            <span className="onboarding-kicker">Research / Paper</span>
            <h2 id="onboarding-title">{onboardingText(locale, "title")}</h2>
            <p id="onboarding-intro">{onboardingText(locale, "intro")}</p>
          </div>
          <button type="button" className="onboarding-close" disabled={busy} onClick={onDismiss} aria-label={onboardingText(locale, "later")}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        {error && (
          <div className="onboarding-error" role="alert">
            <span>{onboardingText(locale, "loadError")}</span>
            <button type="button" onClick={onRetry}>
              {onboardingText(locale, "retry")}
            </button>
          </div>
        )}

        <div className="onboarding-goals">
          {ONBOARDING_GOALS.map((goal, index) => {
            const denied = goal === "paper-robot" && !canCreatePaperRobot;
            return (
              <button
                type="button"
                className="onboarding-goal"
                key={goal}
                disabled={busy}
                aria-disabled={denied || undefined}
                onClick={() => {
                  if (!denied) onSelect(goal);
                }}
              >
                <span className="onboarding-goal-icon" aria-hidden="true">
                  {index + 1}
                </span>
                <span>
                  <strong>{onboardingGoalText(locale, goal, "title")}</strong>
                  <span>{denied ? onboardingText(locale, "paperDenied") : onboardingGoalText(locale, goal, "step")}</span>
                </span>
                <span className="onboarding-goal-action">{onboardingText(locale, denied ? "unavailable" : "choose")}</span>
              </button>
            );
          })}
        </div>

        <footer>
          <span>{onboardingText(locale, "boundary")}</span>
          <a className="onboarding-docs" href="https://github.com/AubakirovArman/SaltanatbotV2#documentation" target="_blank" rel="noreferrer">
            {onboardingText(locale, "documentation")}
          </a>
          <button type="button" className="onboarding-later" disabled={busy} onClick={onDismiss}>
            {onboardingText(locale, "later")}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}
