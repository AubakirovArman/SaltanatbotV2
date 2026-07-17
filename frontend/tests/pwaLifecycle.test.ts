import { describe, expect, it, vi } from "vitest";
import { createPwaLifecycleController, type DeferredInstallPromptEvent, type PwaLifecycleEnvironment } from "../src/pwa/lifecycle";
import type { PwaCapabilityEnvironment } from "../src/pwa/capabilities";

describe("PWA lifecycle controller", () => {
  it("does not attach events or register a worker on public HTTP", () => {
    const harness = lifecycleHarness({
      capabilities: capabilityEnvironment({
        hostname: "89.106.235.4"
      })
    });
    harness.controller.start();
    harness.runTimers();

    expect(harness.register).not.toHaveBeenCalled();
    expect(harness.events.listenerCount()).toBe(0);
    expect(harness.controller.getSnapshot()).toMatchObject({
      install: "unavailable",
      update: "unavailable"
    });
  });

  it("registers the exact production worker only after the bounded first-install delay", async () => {
    const harness = lifecycleHarness();
    harness.controller.start();

    expect(harness.controller.getSnapshot().update).toBe("unavailable");
    expect(harness.register).not.toHaveBeenCalled();
    harness.runTimers();
    await settle();

    expect(harness.register).toHaveBeenCalledWith("/service-worker.js", {
      scope: "/",
      updateViaCache: "none"
    });
    expect(harness.controller.getSnapshot()).toMatchObject({
      update: "idle"
    });
  });

  it("captures one install prompt and records accepted, dismissed and installed states", async () => {
    const accepted = lifecycleHarness();
    accepted.controller.start();
    const acceptedPrompt = installPrompt("accepted");
    accepted.events.dispatch("beforeinstallprompt", acceptedPrompt.event);

    expect(acceptedPrompt.preventDefault).toHaveBeenCalledOnce();
    expect(accepted.controller.getSnapshot().install).toBe("available");
    await expect(accepted.controller.promptInstall()).resolves.toBe("accepted");
    expect(acceptedPrompt.prompt).toHaveBeenCalledOnce();
    expect(accepted.controller.getSnapshot().install).toBe("unavailable");
    await expect(accepted.controller.promptInstall()).resolves.toBe("unavailable");

    const dismissed = lifecycleHarness();
    dismissed.controller.start();
    dismissed.events.dispatch("beforeinstallprompt", installPrompt("dismissed").event);
    await expect(dismissed.controller.promptInstall()).resolves.toBe("dismissed");
    dismissed.events.dispatch("appinstalled", new Event("appinstalled"));
    expect(dismissed.controller.getSnapshot().install).toBe("installed");
  });

  it("reports existing and newly installed waiting updates without forcing activation", async () => {
    const existing = lifecycleHarness({ waiting: {}, controlled: true });
    existing.controller.start();
    existing.runTimers();
    await settle();
    expect(existing.controller.getSnapshot().update).toBe("waiting");

    const discovered = lifecycleHarness({ controlled: true });
    discovered.controller.start();
    discovered.runTimers();
    await settle();
    discovered.worker.state = "installing";
    discovered.registration.installing = discovered.worker;
    discovered.registration.dispatch("updatefound", new Event("updatefound"));
    discovered.worker.state = "installed";
    discovered.worker.dispatch("statechange", new Event("statechange"));
    expect(discovered.controller.getSnapshot().update).toBe("waiting");
  });

  it("checks manually for an update and exposes bounded failure state", async () => {
    const waiting = lifecycleHarness();
    waiting.registration.update.mockImplementation(async () => {
      waiting.registration.waiting = {};
    });
    waiting.controller.start();
    waiting.runTimers();
    await settle();
    await expect(waiting.controller.checkForUpdate()).resolves.toBe("waiting");
    expect(waiting.controller.getSnapshot().update).toBe("waiting");

    const failed = lifecycleHarness();
    failed.registration.update.mockRejectedValue(new Error("offline"));
    failed.controller.start();
    failed.runTimers();
    await settle();
    await expect(failed.controller.checkForUpdate()).resolves.toBe("error");
    expect(failed.controller.getSnapshot().update).toBe("error");
  });
});

function lifecycleHarness(
  options: {
    capabilities?: PwaCapabilityEnvironment;
    waiting?: unknown;
    controlled?: boolean;
  } = {}
) {
  const events = new FakeEventTarget();
  const worker = new FakeWorker();
  const registration = new FakeRegistration();
  registration.waiting = options.waiting;
  const register = vi.fn(async () => registration);
  const timers: Array<() => void> = [];
  const environment: PwaLifecycleEnvironment = {
    capabilities: options.capabilities ?? capabilityEnvironment(),
    serviceWorker: {
      controller: options.controlled ? {} : undefined,
      register
    },
    events,
    documentReadyState: () => "complete",
    standalone: () => false,
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
    },
    firstRegistrationDelayMs: 5
  };
  return {
    controller: createPwaLifecycleController(environment),
    events,
    worker,
    registration,
    register,
    runTimers() {
      timers.splice(0).forEach((callback) => callback());
    }
  };
}

function capabilityEnvironment(overrides: Partial<PwaCapabilityEnvironment> = {}): PwaCapabilityEnvironment {
  return {
    isSecureContext: false,
    hostname: "localhost",
    serviceWorkerSupported: true,
    cacheStorageSupported: true,
    messageChannelSupported: true,
    ...overrides
  };
}

function installPrompt(outcome: "accepted" | "dismissed") {
  const preventDefault = vi.fn();
  const prompt = vi.fn(async () => undefined);
  const event = {
    preventDefault,
    prompt,
    userChoice: Promise.resolve({ outcome })
  } as unknown as DeferredInstallPromptEvent;
  return { event, preventDefault, prompt };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

class FakeEventTarget {
  private listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: Event) {
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  listenerCount() {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }
}

class FakeWorker extends FakeEventTarget {
  state: ServiceWorkerState = "parsed";
}

class FakeRegistration extends FakeEventTarget {
  waiting?: unknown;
  installing?: FakeWorker | null;
  update = vi.fn(async () => undefined);
}
