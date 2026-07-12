// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { SharedWebSocketPool } from "../src/api/sharedWebSocketPool";

class FakeWebSocket {
  readyState = 0;
  closeCalls = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  message(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  disconnect() {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
  }
}

function setup() {
  const sockets: FakeWebSocket[] = [];
  const pool = new SharedWebSocketPool(() => {
    const socket = new FakeWebSocket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  return { pool, sockets };
}

describe("SharedWebSocketPool", () => {
  it("fans out one physical market connection to matching consumers", async () => {
    const { pool, sockets } = setup();
    const first = pool.connect("ws://local/stream?symbol=BTCUSDT");
    const second = pool.connect("ws://local/stream?symbol=BTCUSDT");
    const events: string[] = [];
    first.onopen = () => events.push("first-open");
    second.onopen = () => events.push("second-open");
    first.onmessage = (event) => events.push(`first:${event.data}`);
    second.onmessage = (event) => events.push(`second:${event.data}`);

    expect(sockets).toHaveLength(1);
    expect(pool.activeConnectionCount()).toBe(1);
    sockets[0].open();
    sockets[0].message("tick");
    expect(events).toEqual(["first-open", "second-open", "first:tick", "second:tick"]);

    const late = pool.connect("ws://local/stream?symbol=BTCUSDT");
    late.onopen = () => events.push("late-open");
    await Promise.resolve();
    expect(events.at(-1)).toBe("late-open");

    first.close();
    second.close();
    expect(sockets[0].closeCalls).toBe(0);
    late.close();
    expect(sockets[0].closeCalls).toBe(1);
    expect(pool.activeConnectionCount()).toBe(0);
  });

  it("separates market keys and replaces a disconnected resource", () => {
    const { pool, sockets } = setup();
    const btc = pool.connect("ws://local/stream?symbol=BTCUSDT");
    const eth = pool.connect("ws://local/stream?symbol=ETHUSDT");
    expect(sockets).toHaveLength(2);
    expect(pool.activeConnectionCount()).toBe(2);

    let closed = 0;
    btc.onclose = () => { closed += 1; };
    sockets[0].disconnect();
    expect(closed).toBe(1);
    const replacement = pool.connect("ws://local/stream?symbol=BTCUSDT");
    expect(sockets).toHaveLength(3);
    expect(pool.activeConnectionCount()).toBe(2);

    replacement.close();
    eth.close();
    pool.closeAll();
    expect(pool.activeConnectionCount()).toBe(0);
  });
});
