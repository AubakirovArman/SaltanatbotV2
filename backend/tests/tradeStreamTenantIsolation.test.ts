import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { TradeStreamHub } from "../src/trading/tradeStreamHub.js";

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  send(message: string): void { this.sent.push(message); }
  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

const socket = () => new FakeSocket() as unknown as WebSocket;

describe("private trade stream tenant isolation", () => {
  it("fans events only to their owner and removes server-only ownership fields", () => {
    const hub = new TradeStreamHub();
    const a = socket();
    const b = socket();
    hub.attach(a, "owner-a");
    hub.attach(b, "owner-b");

    hub.publish({
      ownerUserId: "owner-a",
      type: "bot",
      botId: "bot-a",
      bot: { id: "bot-a", ownerUserId: "owner-a" } as never
    });

    const aMessages = (a as unknown as FakeSocket).sent;
    expect(aMessages).toHaveLength(1);
    expect(JSON.parse(aMessages[0]!)).toMatchObject({ type: "bot", botId: "bot-a", bot: { id: "bot-a" } });
    expect(aMessages[0]).not.toContain("ownerUserId");
    expect((b as unknown as FakeSocket).sent).toEqual([]);
    hub.publish({ type: "log", botId: "ownerless" });
    expect(aMessages).toHaveLength(1);
  });

  it("disconnects slow and expired clients without affecting another owner", () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const hub = new TradeStreamHub({ maxBufferedBytes: 10, now: () => now + vi.getTimerCount() * 0 });
      const slow = socket();
      const expiring = socket();
      const healthy = socket();
      hub.attach(slow, "owner-a");
      hub.attach(expiring, "owner-a", now + 50);
      hub.attach(healthy, "owner-b");
      (slow as unknown as FakeSocket).bufferedAmount = 11;

      hub.publish({ ownerUserId: "owner-a", type: "log", botId: "bot-a" });
      expect((slow as unknown as FakeSocket).closes[0]?.code).toBe(1013);
      expect((healthy as unknown as FakeSocket).closes).toEqual([]);

      vi.advanceTimersByTime(50);
      expect((expiring as unknown as FakeSocket).closes[0]?.code).toBe(1008);
      expect(hub.clientCount("owner-a")).toBe(0);
      expect(hub.clientCount("owner-b")).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disconnects only sockets authenticated by the revoked session", () => {
    const hub = new TradeStreamHub();
    const first = socket();
    const second = socket();
    const otherOwner = socket();
    hub.attach(first, "owner-a", undefined, "session-a1");
    hub.attach(second, "owner-a", undefined, "session-a2");
    hub.attach(otherOwner, "owner-b", undefined, "session-b1");

    hub.disconnectSession("session-a1", "Session logout");

    expect((first as unknown as FakeSocket).closes).toEqual([{ code: 1008, reason: "Session logout" }]);
    expect((second as unknown as FakeSocket).closes).toEqual([]);
    expect((otherOwner as unknown as FakeSocket).closes).toEqual([]);
    expect(hub.clientCount("owner-a")).toBe(1);
    expect(hub.clientCount("owner-b")).toBe(1);
  });
});
