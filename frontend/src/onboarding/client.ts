import { getCsrfToken } from "../auth/client";
import { ONBOARDING_GOALS, type OnboardingGoal, type OnboardingMilestone, type OnboardingState } from "./types";

export class OnboardingApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly current?: OnboardingState
  ) {
    super(message);
    this.name = "OnboardingApiError";
  }
}

export async function loadOnboarding(ownerUserId: string, signal?: AbortSignal): Promise<OnboardingState> {
  const body = await request("/api/onboarding", ownerUserId, { method: "GET", signal }, false);
  return parseOnboarding(envelopeState(body));
}

export async function selectOnboardingGoal(ownerUserId: string, state: OnboardingState, goal: OnboardingGoal, signal?: AbortSignal): Promise<OnboardingState> {
  return mutate(
    "/api/onboarding/goal",
    ownerUserId,
    {
      revision: state.revision,
      goal
    },
    signal,
    "PUT"
  );
}

export async function recordOnboardingMilestone(ownerUserId: string, state: OnboardingState, milestone: OnboardingMilestone, signal?: AbortSignal): Promise<OnboardingState> {
  return mutate(
    "/api/onboarding/milestones",
    ownerUserId,
    {
      revision: state.revision,
      milestone
    },
    signal
  );
}

export async function dismissOnboarding(ownerUserId: string, state: OnboardingState, signal?: AbortSignal): Promise<OnboardingState> {
  return mutate("/api/onboarding/dismiss", ownerUserId, { revision: state.revision }, signal);
}

export async function restartOnboarding(ownerUserId: string, state: OnboardingState, signal?: AbortSignal): Promise<OnboardingState> {
  return mutate("/api/onboarding/restart", ownerUserId, { revision: state.revision }, signal);
}

async function mutate(path: string, ownerUserId: string, body: Record<string, unknown>, signal?: AbortSignal, method = "POST"): Promise<OnboardingState> {
  const response = await request(
    path,
    ownerUserId,
    {
      method,
      body: JSON.stringify(body),
      signal
    },
    true
  );
  return parseOnboarding(envelopeState(response));
}

async function request(path: string, ownerUserId: string, init: RequestInit, csrf: boolean): Promise<Record<string, unknown>> {
  const headers = new Headers(init.headers);
  headers.set("X-SBV2-Expected-User", ownerUserId);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (csrf) {
    const token = getCsrfToken();
    if (token) headers.set("X-CSRF-Token", token);
  }
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
    cache: "no-store"
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const current = parseOptionalOnboarding(payload.current);
    throw new OnboardingApiError(response.status, stringValue(payload.code) ?? `http_${response.status}`, stringValue(payload.error) ?? `Onboarding request failed with status ${response.status}.`, current);
  }
  return payload;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
    return {};
  }
  const value: unknown = await response.json().catch(() => undefined);
  return objectValue(value) ?? {};
}

function envelopeState(body: Record<string, unknown>): unknown {
  return body.onboarding;
}

export function parseOnboarding(value: unknown): OnboardingState {
  const input = objectValue(value);
  const milestones = objectValue(input?.milestones);
  const goal = nullableString(input?.goal);
  const status = stringValue(input?.status);
  const state: OnboardingState = {
    schemaVersion: input?.schemaVersion === 1 ? 1 : invalid("schemaVersion"),
    revision: nonNegativeInteger(input?.revision) ?? invalid("revision"),
    status: status === "not_started" || status === "in_progress" || status === "completed" || status === "dismissed" ? status : invalid("status"),
    goal: goal === null ? null : ONBOARDING_GOALS.includes(goal as OnboardingGoal) ? (goal as OnboardingGoal) : invalid("goal"),
    goalSelectedAt: nullableDate(input?.goalSelectedAt),
    milestones: {
      chartReadyAt: nullableDate(milestones?.chartReadyAt),
      priceAlertCreatedAt: nullableDate(milestones?.priceAlertCreatedAt),
      backtestCompletedAt: nullableDate(milestones?.backtestCompletedAt),
      paperBotCreatedAt: nullableDate(milestones?.paperBotCreatedAt)
    },
    completedAt: nullableDate(input?.completedAt),
    dismissedAt: nullableDate(input?.dismissedAt),
    createdAt: nullableDate(input?.createdAt),
    updatedAt: nullableDate(input?.updatedAt)
  };
  if (state.status === "not_started" && state.goal !== null) {
    invalid("not_started goal");
  }
  if (state.status === "in_progress" && (state.goal === null || state.goalSelectedAt === null)) {
    invalid("in_progress goal");
  }
  if (state.status === "completed" && state.completedAt === null) {
    invalid("completedAt");
  }
  if (state.status === "dismissed" && state.dismissedAt === null) {
    invalid("dismissedAt");
  }
  return state;
}

function parseOptionalOnboarding(value: unknown): OnboardingState | undefined {
  try {
    return value === undefined ? undefined : parseOnboarding(value);
  } catch {
    return undefined;
  }
}

function invalid(field: string): never {
  throw new OnboardingApiError(500, "invalid_onboarding_response", `Invalid onboarding response field: ${field}.`);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : stringValue(value);
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function nullableDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || value.length > 64) {
    return invalid("timestamp");
  }
  return value;
}
