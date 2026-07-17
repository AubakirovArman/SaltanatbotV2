// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { installOfflineResearch, queryOfflineResearch, removeOfflineResearch, sendOfflineResearchMessage, type OfflineResearchEnvironment } from "../src/pwa/offlineResearch";
import { pwaCapabilities } from "../src/pwa/capabilities";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("offline research service-worker client", () => {
  it("degrades without service-worker messaging support", async () => {
    vi.stubGlobal("navigator", {});
    expect(await queryOfflineResearch()).toEqual({ supported: false, installed: false, files: 0, bytes: 0 });
  });

  it("uses a bounded message protocol for status, install and removal", async () => {
    const messages: string[] = [];
    const worker = {
      postMessage(message: { type: string }, ports: FakePort[]) {
        messages.push(message.type);
        ports[0]?.postMessage({ ok: true, installed: message.type.endsWith(":install"), files: 18, bytes: 1_500_000 });
      }
    };
    vi.stubGlobal("MessageChannel", FakeMessageChannel);
    vi.stubGlobal("caches", {});
    vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve({ active: worker }), controller: worker } });

    expect(await queryOfflineResearch()).toMatchObject({ supported: true, installed: false, files: 18 });
    expect(await installOfflineResearch()).toMatchObject({ supported: true, installed: true, bytes: 1_500_000 });
    expect(await removeOfflineResearch()).toMatchObject({ supported: true, installed: false });
    expect(messages).toEqual(["saltanat:offline-research:status", "saltanat:offline-research:install", "saltanat:offline-research:remove"]);
  });

  it("fails closed before messaging on public HTTP", async () => {
    const postMessage = vi.fn();
    await expect(
      sendOfflineResearchMessage(
        "install",
        offlineEnvironment({
          capabilities: pwaCapabilities({
            isSecureContext: false,
            hostname: "89.106.235.4",
            serviceWorkerSupported: true,
            cacheStorageSupported: true,
            messageChannelSupported: true
          }),
          serviceWorker: {
            ready: Promise.resolve({ active: { postMessage } }),
            controller: { postMessage }
          }
        })
      )
    ).resolves.toEqual({
      supported: false,
      installed: false,
      files: 0,
      bytes: 0
    });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("bounds a service-worker ready promise that never settles", async () => {
    vi.useFakeTimers();
    const result = sendOfflineResearchMessage(
      "status",
      offlineEnvironment({
        serviceWorker: { ready: new Promise(() => undefined) },
        readyTimeoutMs: 100
      })
    );
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toEqual({
      supported: false,
      installed: false,
      files: 0,
      bytes: 0
    });
  });
});

function offlineEnvironment(overrides: Partial<OfflineResearchEnvironment> = {}): OfflineResearchEnvironment {
  return {
    capabilities: pwaCapabilities({
      isSecureContext: false,
      hostname: "localhost",
      serviceWorkerSupported: true,
      cacheStorageSupported: true,
      messageChannelSupported: true
    }),
    serviceWorker: undefined,
    createMessageChannel: () => new FakeMessageChannel() as unknown as MessageChannel,
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (timer) => window.clearTimeout(timer),
    ...overrides
  };
}

class FakePort {
  onmessage?: (event: { data: unknown }) => void;
  peer?: FakePort;

  postMessage(data: unknown) {
    queueMicrotask(() => this.peer?.onmessage?.({ data }));
  }

  close() {}
}

class FakeMessageChannel {
  port1 = new FakePort();
  port2 = new FakePort();

  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}
