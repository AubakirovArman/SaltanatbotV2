import { browserPwaCapabilityEnvironment, pwaCapabilities, type PwaCapabilities, type PwaCapabilityEnvironment } from "./capabilities";

export type PwaInstallState = "unavailable" | "available" | "prompting" | "installed" | "error";
export type PwaUpdateState = "unavailable" | "idle" | "checking" | "waiting" | "error";

export interface PwaLifecycleSnapshot {
  readonly capabilities: PwaCapabilities;
  readonly install: PwaInstallState;
  readonly update: PwaUpdateState;
}

export interface DeferredInstallPromptEvent extends Event {
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform?: string;
  }>;
  prompt(): Promise<void>;
}

interface LifecycleWorker {
  readonly state: ServiceWorkerState;
  addEventListener(type: "statechange", listener: EventListener): void;
}

interface LifecycleRegistration {
  readonly waiting?: unknown;
  readonly installing?: LifecycleWorker | null;
  addEventListener(type: "updatefound", listener: EventListener): void;
  update(): Promise<void>;
}

interface LifecycleServiceWorkerContainer {
  readonly controller?: unknown;
  register(scriptURL: string, options: RegistrationOptions): Promise<LifecycleRegistration>;
}

interface LifecycleEventTarget {
  addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions | boolean): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface PwaLifecycleEnvironment {
  readonly capabilities: PwaCapabilityEnvironment;
  readonly serviceWorker?: LifecycleServiceWorkerContainer;
  readonly events: LifecycleEventTarget;
  readonly documentReadyState: () => DocumentReadyState;
  readonly standalone: () => boolean;
  readonly setTimeout: (callback: () => void, delayMs: number) => number;
  readonly firstRegistrationDelayMs?: number;
}

export interface PwaLifecycleController {
  getSnapshot(): PwaLifecycleSnapshot;
  subscribe(listener: () => void): () => void;
  start(): void;
  promptInstall(): Promise<"accepted" | "dismissed" | "unavailable" | "error">;
  checkForUpdate(): Promise<"ready" | "waiting" | "unavailable" | "error">;
}

export function createPwaLifecycleController(environment: PwaLifecycleEnvironment): PwaLifecycleController {
  const capabilities = pwaCapabilities(environment.capabilities);
  const listeners = new Set<() => void>();
  let installed = capabilities.serviceWorkerSupported && environment.standalone();
  let snapshot: PwaLifecycleSnapshot = Object.freeze({
    capabilities,
    install: capabilities.serviceWorkerSupported ? (installed ? "installed" : "unavailable") : "unavailable",
    update: "unavailable"
  });
  let started = false;
  let registration: LifecycleRegistration | undefined;
  let installPrompt: DeferredInstallPromptEvent | undefined;

  const publish = (patch: Partial<PwaLifecycleSnapshot>) => {
    snapshot = Object.freeze({ ...snapshot, ...patch });
    listeners.forEach((listener) => listener());
  };

  const onBeforeInstallPrompt: EventListener = (event) => {
    if (!capabilities.serviceWorkerSupported || installed) return;
    const prompt = event as DeferredInstallPromptEvent;
    if (typeof prompt.prompt !== "function" || !prompt.userChoice) return;
    prompt.preventDefault();
    installPrompt = prompt;
    publish({ install: "available" });
  };

  const onAppInstalled: EventListener = () => {
    installed = true;
    installPrompt = undefined;
    publish({ install: "installed" });
  };

  const observeInstalling = (worker?: LifecycleWorker | null) => {
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed" && environment.serviceWorker?.controller) {
        publish({ update: "waiting" });
      }
    });
  };

  const onUpdateFound: EventListener = () => {
    observeInstalling(registration?.installing);
  };

  const attachRegistration = (next: LifecycleRegistration) => {
    registration = next;
    registration.addEventListener("updatefound", onUpdateFound);
    observeInstalling(registration.installing);
    publish({
      update: registration.waiting ? "waiting" : "idle"
    });
  };

  const register = async () => {
    if (!capabilities.serviceWorkerSupported || !environment.serviceWorker) {
      return;
    }
    try {
      attachRegistration(
        await environment.serviceWorker.register("/service-worker.js", {
          scope: "/",
          updateViaCache: "none"
        })
      );
    } catch {
      publish({ update: "error" });
    }
  };

  const scheduleRegistration = () => {
    if (environment.serviceWorker?.controller) {
      void register();
      return;
    }
    environment.setTimeout(() => void register(), environment.firstRegistrationDelayMs ?? 5_000);
  };

  const onLoad: EventListener = () => scheduleRegistration();

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (started || !capabilities.serviceWorkerSupported) return;
      started = true;
      environment.events.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      environment.events.addEventListener("appinstalled", onAppInstalled);
      if (environment.documentReadyState() === "complete") {
        scheduleRegistration();
      } else {
        environment.events.addEventListener("load", onLoad, { once: true });
      }
    },
    async promptInstall() {
      const prompt = installPrompt;
      if (!prompt || installed) return "unavailable";
      installPrompt = undefined;
      publish({ install: "prompting" });
      try {
        await prompt.prompt();
        const choice = await prompt.userChoice;
        publish({ install: installed ? "installed" : "unavailable" });
        return choice.outcome;
      } catch {
        publish({ install: "error" });
        return "error";
      }
    },
    async checkForUpdate() {
      if (!capabilities.serviceWorkerSupported || !registration) {
        return "unavailable";
      }
      publish({ update: "checking" });
      try {
        await registration.update();
        const state = registration.waiting || snapshot.update === "waiting" ? "waiting" : "idle";
        publish({ update: state });
        return state === "waiting" ? "waiting" : "ready";
      } catch {
        publish({ update: "error" });
        return "error";
      }
    }
  };
}

export function browserPwaLifecycleEnvironment(): PwaLifecycleEnvironment {
  const browserNavigator = navigator as Navigator & {
    standalone?: boolean;
  };
  return {
    capabilities: browserPwaCapabilityEnvironment(),
    serviceWorker: "serviceWorker" in navigator ? (navigator.serviceWorker as unknown as LifecycleServiceWorkerContainer) : undefined,
    events: window,
    documentReadyState: () => document.readyState,
    standalone: () => browserNavigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches,
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs)
  };
}
