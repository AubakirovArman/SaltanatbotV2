// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { installOfflineResearch, queryOfflineResearch, removeOfflineResearch } from "../src/pwa/offlineResearch";

afterEach(() => vi.unstubAllGlobals());

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
    vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve({ active: worker }), controller: worker } });

    expect(await queryOfflineResearch()).toMatchObject({ supported: true, installed: false, files: 18 });
    expect(await installOfflineResearch()).toMatchObject({ supported: true, installed: true, bytes: 1_500_000 });
    expect(await removeOfflineResearch()).toMatchObject({ supported: true, installed: false });
    expect(messages).toEqual([
      "saltanat:offline-research:status",
      "saltanat:offline-research:install",
      "saltanat:offline-research:remove"
    ]);
  });
});

class FakePort {
  onmessage?: (event: { data: unknown }) => void;
  peer?: FakePort;

  postMessage(data: unknown) {
    queueMicrotask(() => this.peer?.onmessage?.({ data }));
  }
}

class FakeMessageChannel {
  port1 = new FakePort();
  port2 = new FakePort();

  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}
