export interface PwaCapabilityEnvironment {
  readonly isSecureContext: boolean;
  readonly hostname: string;
  readonly serviceWorkerSupported: boolean;
  readonly cacheStorageSupported: boolean;
  readonly messageChannelSupported: boolean;
}

export interface PwaCapabilities {
  readonly originEligible: boolean;
  readonly serviceWorkerSupported: boolean;
  readonly shellManagementSupported: boolean;
  readonly offlineResearchSupported: boolean;
}

export function isLocalPwaHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

export function pwaCapabilities(environment: PwaCapabilityEnvironment): PwaCapabilities {
  const originEligible = environment.isSecureContext || isLocalPwaHostname(environment.hostname);
  const serviceWorkerSupported = originEligible && environment.serviceWorkerSupported;
  return Object.freeze({
    originEligible,
    serviceWorkerSupported,
    shellManagementSupported: originEligible && (environment.serviceWorkerSupported || environment.cacheStorageSupported),
    offlineResearchSupported: serviceWorkerSupported && environment.cacheStorageSupported && environment.messageChannelSupported
  });
}

export function browserPwaCapabilityEnvironment(): PwaCapabilityEnvironment {
  const browserGlobal = globalThis as typeof globalThis & {
    isSecureContext?: boolean;
  };
  const hostname = typeof window === "undefined" ? "" : window.location.hostname;
  return {
    isSecureContext: browserGlobal.isSecureContext === true,
    hostname,
    serviceWorkerSupported: typeof navigator !== "undefined" && "serviceWorker" in navigator,
    cacheStorageSupported: typeof window !== "undefined" && "caches" in window,
    messageChannelSupported: typeof MessageChannel !== "undefined"
  };
}

export function browserPwaCapabilities(): PwaCapabilities {
  return pwaCapabilities(browserPwaCapabilityEnvironment());
}
