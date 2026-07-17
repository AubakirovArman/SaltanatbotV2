import { browserPwaCapabilityEnvironment, pwaCapabilities, type PwaCapabilityEnvironment } from "../pwa/capabilities";

const SHELL_CACHE_PREFIX = "saltanat-shell-";
const AUTOMATIC_RECOVERY_KEY = "sbv2:automatic-shell-recovery:v1";

export interface ApplicationShellRecoveryEnvironment {
  origin: string;
  pwa?: PwaCapabilityEnvironment;
  serviceWorker?: {
    getRegistrations(): Promise<
      ReadonlyArray<{
        scope: string;
        active?: { scriptURL: string } | null;
        waiting?: { scriptURL: string } | null;
        installing?: { scriptURL: string } | null;
        unregister(): Promise<boolean>;
      }>
    >;
  };
  cacheStorage?: {
    keys(): Promise<string[]>;
    delete(cacheName: string): Promise<boolean>;
  };
  session?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  reload(): void;
}

export function isRecoverableApplicationAssetError(error: unknown): boolean {
  const record = error && typeof error === "object" ? (error as { name?: unknown; message?: unknown }) : {};
  const detail = `${typeof record.name === "string" ? record.name : ""} ${typeof record.message === "string" ? record.message : String(error ?? "")}`;
  return /ChunkLoadError|Loading chunk .* failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(detail);
}

export function claimAutomaticApplicationShellRecovery(environment = browserRecoveryEnvironment()): boolean {
  try {
    if (!environment.session || environment.session.getItem(AUTOMATIC_RECOVERY_KEY)) return false;
    environment.session.setItem(AUTOMATIC_RECOVERY_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

export function markApplicationStartupHealthy(environment = browserRecoveryEnvironment()): void {
  try {
    environment.session?.removeItem(AUTOMATIC_RECOVERY_KEY);
  } catch {
    /* Recovery remains single-shot when storage is unavailable. */
  }
}

export function canManageApplicationShellFiles(environment = browserRecoveryEnvironment()): boolean {
  return pwaCapabilities(environment.pwa ?? inferredRecoveryPwaEnvironment(environment)).shellManagementSupported;
}

export async function clearApplicationShellFiles(environment = browserRecoveryEnvironment()): Promise<void> {
  if (!canManageApplicationShellFiles(environment)) return;
  const registrations = (await environment.serviceWorker?.getRegistrations().catch(() => [])) ?? [];
  await Promise.all(registrations.filter((registration) => isSaltanatWorker(registration, environment.origin)).map((registration) => registration.unregister().catch(() => false)));
  const cacheNames = (await environment.cacheStorage?.keys().catch(() => [])) ?? [];
  await Promise.all(cacheNames.filter((name) => name.startsWith(SHELL_CACHE_PREFIX)).map((name) => environment.cacheStorage?.delete(name).catch(() => false)));
}

export async function refreshApplicationFiles(environment = browserRecoveryEnvironment()): Promise<void> {
  try {
    await clearApplicationShellFiles(environment);
  } finally {
    environment.reload();
  }
}

function isSaltanatWorker(registration: { scope: string; active?: { scriptURL: string } | null; waiting?: { scriptURL: string } | null; installing?: { scriptURL: string } | null }, origin: string) {
  const scriptUrl = registration.active?.scriptURL ?? registration.waiting?.scriptURL ?? registration.installing?.scriptURL;
  if (scriptUrl) {
    try {
      const url = new URL(scriptUrl);
      return url.origin === origin && url.pathname.endsWith("/service-worker.js");
    } catch {
      return false;
    }
  }
  return registration.scope === `${origin}/`;
}

function browserRecoveryEnvironment(): ApplicationShellRecoveryEnvironment {
  return {
    origin: window.location.origin,
    pwa: browserPwaCapabilityEnvironment(),
    serviceWorker: "serviceWorker" in navigator ? navigator.serviceWorker : undefined,
    cacheStorage: "caches" in window ? window.caches : undefined,
    session: window.sessionStorage,
    reload: () => window.location.reload()
  };
}

function inferredRecoveryPwaEnvironment(environment: ApplicationShellRecoveryEnvironment): PwaCapabilityEnvironment {
  let protocol = "";
  let hostname = "";
  try {
    const url = new URL(environment.origin);
    protocol = url.protocol;
    hostname = url.hostname;
  } catch {
    // Invalid injected origins fail closed.
  }
  return {
    isSecureContext: protocol === "https:",
    hostname,
    serviceWorkerSupported: environment.serviceWorker !== undefined,
    cacheStorageSupported: environment.cacheStorage !== undefined,
    messageChannelSupported: false
  };
}
