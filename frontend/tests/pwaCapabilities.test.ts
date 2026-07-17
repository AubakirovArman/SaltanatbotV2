import { describe, expect, it } from "vitest";
import { isLocalPwaHostname, pwaCapabilities, type PwaCapabilityEnvironment } from "../src/pwa/capabilities";

describe("PWA capability boundary", () => {
  it.each(["localhost", "app.localhost", "127.0.0.1", "::1", "[::1]"])("accepts the explicit local hostname %s", (hostname) => {
    expect(isLocalPwaHostname(hostname)).toBe(true);
  });

  it.each(["89.106.235.4", "example.test", "127.0.0.2", "localhost.test"])("does not infer a secure origin from %s", (hostname) => {
    expect(isLocalPwaHostname(hostname)).toBe(false);
  });

  it("disables every PWA action on public HTTP even when browser APIs are exposed", () => {
    expect(pwaCapabilities(environment({ hostname: "89.106.235.4" }))).toEqual({
      originEligible: false,
      serviceWorkerSupported: false,
      shellManagementSupported: false,
      offlineResearchSupported: false
    });
  });

  it("allows service-worker and offline actions on localhost or a browser-reported secure context", () => {
    expect(pwaCapabilities(environment({ hostname: "localhost" }))).toMatchObject({
      originEligible: true,
      serviceWorkerSupported: true,
      offlineResearchSupported: true
    });
    expect(
      pwaCapabilities(
        environment({
          hostname: "terminal.example",
          isSecureContext: true
        })
      )
    ).toMatchObject({
      originEligible: true,
      serviceWorkerSupported: true,
      offlineResearchSupported: true
    });
  });

  it("keeps shell cleanup and offline research independently capability-gated", () => {
    expect(
      pwaCapabilities(
        environment({
          serviceWorkerSupported: false,
          messageChannelSupported: false
        })
      )
    ).toEqual({
      originEligible: true,
      serviceWorkerSupported: false,
      shellManagementSupported: true,
      offlineResearchSupported: false
    });
  });
});

function environment(overrides: Partial<PwaCapabilityEnvironment> = {}): PwaCapabilityEnvironment {
  return {
    isSecureContext: false,
    hostname: "127.0.0.1",
    serviceWorkerSupported: true,
    cacheStorageSupported: true,
    messageChannelSupported: true,
    ...overrides
  };
}
