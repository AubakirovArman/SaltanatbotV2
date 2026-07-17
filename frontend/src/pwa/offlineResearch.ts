import { browserPwaCapabilities, type PwaCapabilities } from "./capabilities";

export type OfflineResearchStatus = {
  supported: boolean;
  installed: boolean;
  files: number;
  bytes: number;
};

type ResearchMessage = "status" | "install" | "remove";
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_MESSAGE_TIMEOUT_MS = 30_000;

interface OfflineResearchWorker {
  postMessage(message: { type: string }, transfer: Transferable[]): void;
}

interface OfflineResearchServiceWorker {
  readonly ready: Promise<{ active?: OfflineResearchWorker | null }>;
  readonly controller?: OfflineResearchWorker | null;
}

export interface OfflineResearchEnvironment {
  readonly capabilities: PwaCapabilities;
  readonly serviceWorker?: OfflineResearchServiceWorker;
  readonly createMessageChannel?: () => MessageChannel;
  readonly setTimeout: (callback: () => void, delayMs: number) => number;
  readonly clearTimeout: (timer: number) => void;
  readonly readyTimeoutMs?: number;
  readonly messageTimeoutMs?: number;
}

export async function queryOfflineResearch(): Promise<OfflineResearchStatus> {
  return sendResearchMessage("status", browserOfflineResearchEnvironment());
}

export async function installOfflineResearch(): Promise<OfflineResearchStatus> {
  return sendResearchMessage("install", browserOfflineResearchEnvironment());
}

export async function removeOfflineResearch(): Promise<OfflineResearchStatus> {
  return sendResearchMessage("remove", browserOfflineResearchEnvironment());
}

export async function sendOfflineResearchMessage(action: ResearchMessage, environment: OfflineResearchEnvironment): Promise<OfflineResearchStatus> {
  return sendResearchMessage(action, environment);
}

async function sendResearchMessage(action: ResearchMessage, environment: OfflineResearchEnvironment): Promise<OfflineResearchStatus> {
  if (!environment.capabilities.offlineResearchSupported || !environment.serviceWorker || !environment.createMessageChannel) {
    return unsupportedStatus();
  }
  try {
    const registration = await withTimeout(environment.serviceWorker.ready, environment.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, environment);
    const worker = environment.serviceWorker.controller ?? registration.active;
    if (!worker) return unsupportedStatus();
    const response = await new Promise<{ ok?: boolean; installed?: boolean; files?: number; bytes?: number }>((resolve, reject) => {
      const channel = environment.createMessageChannel!();
      const timeout = environment.setTimeout(() => {
        channel.port1.close();
        channel.port2.close();
        reject(new Error("offline_research_timeout"));
      }, environment.messageTimeoutMs ?? DEFAULT_MESSAGE_TIMEOUT_MS);
      channel.port1.onmessage = (event) => {
        environment.clearTimeout(timeout);
        channel.port1.close();
        channel.port2.close();
        resolve(event.data ?? {});
      };
      try {
        worker.postMessage({ type: `saltanat:offline-research:${action}` }, [channel.port2]);
      } catch (error) {
        environment.clearTimeout(timeout);
        channel.port1.close();
        channel.port2.close();
        reject(error);
      }
    });
    if (!response.ok) throw new Error("offline_research_failed");
    return { supported: true, installed: response.installed === true, files: response.files ?? 0, bytes: response.bytes ?? 0 };
  } catch {
    return unsupportedStatus();
  }
}

function unsupportedStatus(): OfflineResearchStatus {
  return { supported: false, installed: false, files: 0, bytes: 0 };
}

function browserOfflineResearchEnvironment(): OfflineResearchEnvironment {
  const supported = typeof navigator !== "undefined" && "serviceWorker" in navigator;
  return {
    capabilities: browserPwaCapabilities(),
    serviceWorker: supported ? (navigator.serviceWorker as unknown as OfflineResearchServiceWorker) : undefined,
    createMessageChannel: typeof MessageChannel === "undefined" ? undefined : () => new MessageChannel(),
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (timer) => window.clearTimeout(timer)
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, environment: Pick<OfflineResearchEnvironment, "setTimeout" | "clearTimeout">): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = environment.setTimeout(() => reject(new Error("offline_research_ready_timeout")), timeoutMs);
    promise.then(
      (value) => {
        environment.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        environment.clearTimeout(timer);
        reject(error);
      }
    );
  });
}
