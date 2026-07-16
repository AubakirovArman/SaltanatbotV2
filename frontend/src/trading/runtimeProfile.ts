export interface TradingRuntimeDescriptor {
  /** Stable server deployment profile. Omitted by older backends. */
  runtimeProfile?: string;
  /** Execution policy advertised by the server. Omitted by older backends. */
  executionMode?: string;
  /** Whether authenticated routes may contact private exchange APIs. */
  privateExchangeRequests?: boolean;
  /** Whether exchange credentials may be created, rotated or deleted. */
  credentialWrites?: boolean;
  /** Legacy safe-mode flag retained for older backend responses. */
  demo?: boolean;
}

export interface TradingRuntimeCapabilities {
  paperOnly: boolean;
  privateExchangeRequests: boolean;
  credentialWrites: boolean;
}

/**
 * Resolve optional runtime fields fail-closed while preserving compatibility
 * with older responses that did not advertise a deployment profile.
 */
export function resolveTradingRuntime(value?: TradingRuntimeDescriptor | null): TradingRuntimeCapabilities {
  const paperOnly = value?.runtimeProfile === "public-http-paper"
    || value?.executionMode === "paper-only"
    || value?.privateExchangeRequests === false
    || value?.demo === true;

  return {
    paperOnly,
    privateExchangeRequests: !paperOnly && value?.privateExchangeRequests !== false,
    credentialWrites: !paperOnly && value?.credentialWrites !== false
  };
}
