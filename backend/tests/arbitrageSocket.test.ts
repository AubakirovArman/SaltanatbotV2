import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { ResilientPublicSocket } from "../src/arbitrage/upstream/socket.js";

class FakeSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING;
  readonly sent: string[] = [];
  terminated = false;

  send(payload: string) {
    this.sent.push(payload);
  }

  open() {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }

  terminate() {
    this.terminated = true;
    this.close();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("resilient arbitrage upstream socket", () => {
  it("becomes healthy only after a valid market-data event", () => {
    const socket = new FakeSocket();
    const statuses: Array<{ ok: boolean; message?: string }> = [];
    const feed = new ResilientPublicSocket({
      url: "wss://example.invalid",
      name: "fixture",
      createSocket: () => socket as unknown as WebSocket,
      onOpen: () => undefined,
      onMessage: (value) => (value as { type?: string }).type === "ticker",
      onStatus: (ok, message) => statuses.push({ ok, message })
    });

    feed.start();
    socket.open();
    socket.emit("message", Buffer.from(JSON.stringify({ type: "subscription_ack" })));
    expect(statuses.some((status) => status.ok)).toBe(false);

    socket.emit("message", Buffer.from(JSON.stringify({ type: "ticker" })));
    expect(statuses.at(-1)).toEqual({ ok: true, message: undefined });
    feed.stop();
  });

  it("fails closed and reconnects a silent open socket", () => {
    vi.useFakeTimers();
    let now = 0;
    const socket = new FakeSocket();
    const statuses: Array<{ ok: boolean; message?: string }> = [];
    const feed = new ResilientPublicSocket({
      url: "wss://example.invalid",
      name: "fixture",
      messageTimeoutMs: 1_000,
      now: () => now,
      random: () => 0.5,
      createSocket: () => socket as unknown as WebSocket,
      onOpen: () => undefined,
      onMessage: () => false,
      onStatus: (ok, message) => statuses.push({ ok, message })
    });

    feed.start();
    socket.open();
    now = 1_001;
    vi.advanceTimersByTime(1_000);

    expect(socket.terminated).toBe(true);
    expect(statuses.some((status) => status.message?.includes("timed out"))).toBe(true);
    expect(statuses.at(-1)?.message).toContain("reconnecting");
    feed.stop();
  });
});
