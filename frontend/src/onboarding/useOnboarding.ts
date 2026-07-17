import { useCallback, useEffect, useRef, useState } from "react";
import { dismissOnboarding, loadOnboarding, OnboardingApiError, recordOnboardingMilestone, restartOnboarding, selectOnboardingGoal } from "./client";
import { milestoneCompleted, type OnboardingGoal, type OnboardingMilestone, type OnboardingState } from "./types";

export type OnboardingLoadPhase = "disabled" | "loading" | "ready" | "error";

export interface OnboardingController {
  readonly phase: OnboardingLoadPhase;
  readonly state?: OnboardingState;
  readonly busy: boolean;
  readonly error?: string;
  retry(): void;
  selectGoal(goal: OnboardingGoal): Promise<boolean>;
  recordMilestone(milestone: OnboardingMilestone): Promise<boolean>;
  dismiss(): Promise<boolean>;
  restart(): Promise<boolean>;
}

export function useOnboarding(ownerUserId: string | undefined, enabled: boolean): OnboardingController {
  const [phase, setPhase] = useState<OnboardingLoadPhase>(enabled && ownerUserId ? "loading" : "disabled");
  const [state, setState] = useState<OnboardingState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [retryVersion, setRetryVersion] = useState(0);
  const generation = useRef(0);
  const mutationAbort = useRef<AbortController>();
  const mutationInFlight = useRef(false);
  const contextOwner = useRef<string>();
  const stateRef = useRef<OnboardingState>();
  const ownerMatches = enabled && ownerUserId !== undefined && contextOwner.current === ownerUserId;
  const visibleState = ownerMatches ? state : undefined;
  stateRef.current = visibleState;

  useEffect(() => {
    const currentGeneration = ++generation.current;
    mutationAbort.current?.abort();
    mutationAbort.current = undefined;
    mutationInFlight.current = false;
    const abort = new AbortController();
    setBusy(false);
    setError(undefined);
    if (!enabled || !ownerUserId) {
      contextOwner.current = undefined;
      stateRef.current = undefined;
      setState(undefined);
      setPhase("disabled");
      return () => abort.abort();
    }
    contextOwner.current = ownerUserId;
    stateRef.current = undefined;
    setState(undefined);
    setPhase("loading");
    void loadOnboarding(ownerUserId, abort.signal)
      .then((next) => {
        if (abort.signal.aborted || currentGeneration !== generation.current) {
          return;
        }
        stateRef.current = next;
        setState(next);
        setPhase("ready");
      })
      .catch((cause) => {
        if (abort.signal.aborted || currentGeneration !== generation.current) {
          return;
        }
        setError(messageOf(cause));
        setPhase("error");
      });
    return () => abort.abort();
  }, [enabled, ownerUserId, retryVersion]);

  const mutate = useCallback(
    async (operation: (owner: string, current: OnboardingState, signal: AbortSignal) => Promise<OnboardingState>): Promise<boolean> => {
      const current = stateRef.current;
      if (!enabled || !ownerUserId || !current || contextOwner.current !== ownerUserId || mutationInFlight.current) {
        return false;
      }
      const currentGeneration = generation.current;
      const abort = new AbortController();
      mutationInFlight.current = true;
      mutationAbort.current = abort;
      setBusy(true);
      setError(undefined);
      try {
        const next = await operation(ownerUserId, current, abort.signal);
        if (abort.signal.aborted || currentGeneration !== generation.current || contextOwner.current !== ownerUserId) {
          return false;
        }
        stateRef.current = next;
        setState(next);
        setPhase("ready");
        return true;
      } catch (cause) {
        if (abort.signal.aborted || currentGeneration !== generation.current || contextOwner.current !== ownerUserId) {
          return false;
        }
        if (cause instanceof OnboardingApiError && cause.current) {
          stateRef.current = cause.current;
          setState(cause.current);
          setPhase("ready");
        }
        setError(messageOf(cause));
        return false;
      } finally {
        if (mutationAbort.current === abort) {
          mutationAbort.current = undefined;
          mutationInFlight.current = false;
        }
        if (currentGeneration === generation.current && contextOwner.current === ownerUserId) {
          setBusy(false);
        }
      }
    },
    [enabled, ownerUserId]
  );

  const selectGoal = useCallback((goal: OnboardingGoal) => mutate((owner, current, signal) => selectOnboardingGoal(owner, current, goal, signal)), [mutate]);

  const recordMilestone = useCallback(
    async (milestone: OnboardingMilestone) => {
      const current = stateRef.current;
      if (!current || milestoneCompleted(current, milestone)) return true;
      return mutate((owner, latest, signal) => recordOnboardingMilestone(owner, latest, milestone, signal));
    },
    [mutate]
  );

  const dismiss = useCallback(() => mutate((owner, current, signal) => dismissOnboarding(owner, current, signal)), [mutate]);

  const restart = useCallback(() => mutate((owner, current, signal) => restartOnboarding(owner, current, signal)), [mutate]);

  const retry = useCallback(() => {
    ++generation.current;
    mutationAbort.current?.abort();
    mutationAbort.current = undefined;
    mutationInFlight.current = false;
    contextOwner.current = undefined;
    stateRef.current = undefined;
    setState(undefined);
    setBusy(false);
    setError(undefined);
    setPhase(enabled && ownerUserId ? "loading" : "disabled");
    setRetryVersion((current) => current + 1);
  }, [enabled, ownerUserId]);

  return {
    phase: !enabled || !ownerUserId ? "disabled" : ownerMatches ? phase : "loading",
    state: visibleState,
    busy: ownerMatches ? busy : false,
    error: ownerMatches ? error : undefined,
    retry,
    selectGoal,
    recordMilestone,
    dismiss,
    restart
  };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : "Onboarding is temporarily unavailable.";
}
