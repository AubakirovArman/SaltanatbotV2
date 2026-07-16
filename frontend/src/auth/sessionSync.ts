export const AUTH_SESSION_CHANNEL = "sbv2-auth-session-v1";
export const AUTH_SESSION_STORAGE_KEY = "sbv2:auth-session-event:v1";
export const AUTH_SESSION_CUSTOM_EVENT = "sbv2:auth-session-event:v1";
export const AUTH_SESSION_INVALIDATED_EVENT = "sbv2:auth-session-invalidated:v1";

export type AuthSessionChangeKind = "login" | "logout" | "password" | "session";

export interface AuthSessionChange {
  version: 1;
  id: string;
  source: string;
  kind: AuthSessionChangeKind;
  at: number;
}

const sourceId = randomId("tab");

/**
 * Notifies every open tab that the shared browser session may have changed.
 * The event intentionally contains no user or credential data; receivers
 * always resolve the authoritative session from the backend.
 */
export function publishAuthSessionChange(kind: AuthSessionChangeKind): AuthSessionChange {
  const change: AuthSessionChange = {
    version: 1,
    id: randomId("auth"),
    source: sourceId,
    kind,
    at: Date.now()
  };

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AUTH_SESSION_CUSTOM_EVENT, { detail: change }));
    window.dispatchEvent(new CustomEvent("sbv2:auth-changed", { detail: kind === "login" ? "login" : "logout" }));
    try {
      window.localStorage.setItem(AUTH_SESSION_STORAGE_KEY, JSON.stringify(change));
    } catch {
      // BroadcastChannel or the next foreground refresh remains available.
    }
  }

  if (typeof BroadcastChannel !== "undefined") {
    try {
      const channel = new BroadcastChannel(AUTH_SESSION_CHANNEL);
      channel.postMessage(change);
      queueMicrotask(() => channel.close());
    } catch {
      // localStorage is the compatibility fallback.
    }
  }

  return change;
}

/** Reconciles this tab immediately and asks sibling tabs to re-read the shared cookie. */
export function publishAuthSessionInvalidated(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AUTH_SESSION_INVALIDATED_EVENT));
  publishAuthSessionChange("session");
}

export function subscribeAuthSessionChanges(listener: (change: AuthSessionChange) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const seen = new Set<string>();
  const accept = (candidate: unknown) => {
    const change = parseAuthSessionChange(candidate);
    if (!change || change.source === sourceId || seen.has(change.id)) return;
    seen.add(change.id);
    if (seen.size > 64) seen.delete(seen.values().next().value as string);
    listener(change);
  };

  let channel: BroadcastChannel | undefined;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(AUTH_SESSION_CHANNEL);
      channel.addEventListener("message", (event) => accept(event.data));
    } catch {
      channel = undefined;
    }
  }

  const onStorage = (event: StorageEvent) => {
    if (event.key !== AUTH_SESSION_STORAGE_KEY || !event.newValue) return;
    try {
      accept(JSON.parse(event.newValue));
    } catch {
      // Ignore malformed events from unrelated or outdated clients.
    }
  };
  const onCustomEvent = (event: Event) => accept((event as CustomEvent<unknown>).detail);
  window.addEventListener("storage", onStorage);
  window.addEventListener(AUTH_SESSION_CUSTOM_EVENT, onCustomEvent);

  return () => {
    channel?.close();
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(AUTH_SESSION_CUSTOM_EVENT, onCustomEvent);
  };
}

function parseAuthSessionChange(value: unknown): AuthSessionChange | undefined {
  if (!value || typeof value !== "object") return undefined;
  const change = value as Partial<AuthSessionChange>;
  if (change.version !== 1 || typeof change.id !== "string" || change.id.length === 0 || change.id.length > 160 || typeof change.source !== "string" || change.source.length === 0 || change.source.length > 160 || !isChangeKind(change.kind) || typeof change.at !== "number" || !Number.isFinite(change.at)) {
    return undefined;
  }
  return change as AuthSessionChange;
}

function isChangeKind(value: unknown): value is AuthSessionChangeKind {
  return value === "login" || value === "logout" || value === "password" || value === "session";
}

function randomId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
