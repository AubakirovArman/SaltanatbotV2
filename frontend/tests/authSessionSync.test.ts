// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_SESSION_CHANNEL, AUTH_SESSION_STORAGE_KEY, subscribeAuthSessionChanges, type AuthSessionChange } from "../src/auth/sessionSync";

describe("cross-tab authentication session sync", () => {
  beforeEach(() => {
    localStorage.clear();
    FakeBroadcastChannel.instances = [];
  });

  afterEach(() => vi.unstubAllGlobals());

  it("receives valid external changes over BroadcastChannel", () => {
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    const listener = vi.fn();
    const unsubscribe = subscribeAuthSessionChanges(listener);
    const change = externalChange("broadcast-change");

    expect(FakeBroadcastChannel.instances[0]?.name).toBe(AUTH_SESSION_CHANNEL);
    FakeBroadcastChannel.instances[0]?.receive(change);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(change);
    unsubscribe();
    expect(FakeBroadcastChannel.instances[0]?.closed).toBe(true);
  });

  it("uses the storage event fallback and deduplicates an event seen on both transports", () => {
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    const listener = vi.fn();
    const unsubscribe = subscribeAuthSessionChanges(listener);
    const change = externalChange("deduplicated-change");

    FakeBroadcastChannel.instances[0]?.receive(change);
    window.dispatchEvent(new StorageEvent("storage", { key: AUTH_SESSION_STORAGE_KEY, newValue: JSON.stringify(change) }));
    window.dispatchEvent(new StorageEvent("storage", { key: AUTH_SESSION_STORAGE_KEY, newValue: "not-json" }));

    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });
});

function externalChange(id: string): AuthSessionChange {
  return { version: 1, id, source: "another-browser-tab", kind: "session", at: 100 };
}

class FakeBroadcastChannel extends EventTarget {
  static instances: FakeBroadcastChannel[] = [];
  readonly name: string;
  closed = false;

  constructor(name: string) {
    super();
    this.name = name;
    FakeBroadcastChannel.instances.push(this);
  }

  postMessage(_message: unknown): void {}

  close(): void {
    this.closed = true;
  }

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}
