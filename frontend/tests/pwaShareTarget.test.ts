// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPwaShareTargetLaunch, discardPwaShareTarget, loadPwaShareTarget, parsePwaShareTargetLaunch } from "../src/pwa/shareTarget";

const token = "123e4567-e89b-42d3-a456-426614174000";

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("PWA Web Share Target client", () => {
  it("accepts one strict opaque token and rejects ambiguous or malformed launches", () => {
    expect(parsePwaShareTargetLaunch("")).toEqual({ kind: "none" });
    expect(parsePwaShareTargetLaunch(`?share=${token}`)).toEqual({ kind: "token", token });
    expect(parsePwaShareTargetLaunch(`?share=${token}&share=${token}`)).toEqual({ kind: "error" });
    expect(parsePwaShareTargetLaunch("?share=../../orders.json")).toEqual({ kind: "error" });
    expect(parsePwaShareTargetLaunch("?share_error=unavailable")).toEqual({ kind: "error" });
  });

  it("loads metadata through the bounded worker protocol without reading file contents", async () => {
    const file = new File(["//@version=6"], "shared.pine", { type: "text/plain" });
    const text = vi.fn(async () => "//@version=6");
    Object.defineProperty(file, "text", { value: text });
    const messages: Array<{ type: string; token: string }> = [];
    installWorker((message) => {
      messages.push(message);
      return {
        ok: true,
        files: [{ name: "shared.pine", file }],
        rejected: [
          { name: "orders.json", reason: "unsupported" },
          { name: "ignored.pine", reason: "not_a_reason" }
        ]
      };
    });

    const batch = await loadPwaShareTarget(token);

    expect(batch).toMatchObject({
      source: "share_target",
      files: [{ name: "shared.pine", kind: "pine", file }],
      rejected: [{ name: "orders.json", reason: "unsupported" }]
    });
    expect(text).not.toHaveBeenCalled();
    expect(messages).toEqual([{ type: "saltanat:share-target:load", token }]);
  });

  it("fails closed when storage is unavailable and explicitly discards reviewed payloads", async () => {
    installWorker((message) => ({ ok: message.type.endsWith(":discard") }));

    expect(await loadPwaShareTarget(token)).toMatchObject({
      source: "share_target",
      files: [],
      rejected: [{ reason: "expired" }]
    });
    expect(await discardPwaShareTarget(token)).toBe(true);
    expect(await discardPwaShareTarget("invalid")).toBe(false);
  });

  it("removes only private share handoff parameters from the current URL", () => {
    window.history.replaceState({ kept: true }, "", `/?view=strategy&share=${token}&other=1#section`);
    clearPwaShareTargetLaunch();
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe("/?view=strategy&other=1#section");
    expect(window.history.state).toEqual({ kept: true });
  });
});

function installWorker(respond: (message: { type: string; token: string }) => unknown) {
  const worker = {
    postMessage(message: { type: string; token: string }, ports: FakePort[]) {
      ports[0]?.postMessage(respond(message));
    }
  };
  vi.stubGlobal("MessageChannel", FakeMessageChannel);
  vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve({ active: worker }), controller: worker } });
}

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
