import { describe, expect, it } from "vitest";
import { websocketOriginAllowed, type WebSocketOriginPolicy } from "../src/http/websocketOrigin.js";

const privatePolicy: WebSocketOriginPolicy = {
  publicOrigin: "https://trade.example.test",
  allowedOrigins: ["https://terminal.example.test"]
};

describe("WebSocket Origin boundary", () => {
  it("matches normalized exact PUBLIC_ORIGIN and ALLOWED_ORIGINS", () => {
    expect(websocketOriginAllowed("HTTPS://TRADE.EXAMPLE.TEST:443/", "untrusted-alias.test", privatePolicy)).toBe(true);
    expect(websocketOriginAllowed("https://terminal.example.test/", "untrusted-alias.test", privatePolicy)).toBe(true);
    expect(websocketOriginAllowed("https://other.example.test", "other.example.test", privatePolicy)).toBe(false);
  });

  it.each(["https://trade.example.test/app", "https://trade.example.test/.", "https://trade.example.test/%2e", "https://operator:password@trade.example.test", "ftp://trade.example.test", "null", " https://trade.example.test"])("rejects a non-origin browser value: %s", (origin) => {
    expect(websocketOriginAllowed(origin, "trade.example.test", privatePolicy)).toBe(false);
  });

  it("preserves exact same-host browser access when public paper omits PUBLIC_ORIGIN", () => {
    const paperPolicy: WebSocketOriginPolicy = { allowedOrigins: [] };
    expect(websocketOriginAllowed("http://89.106.235.4:4180", "89.106.235.4:4180", paperPolicy)).toBe(true);
    expect(websocketOriginAllowed("https://LOCALHOST:4180/", "localhost:4180", paperPolicy)).toBe(true);
    expect(websocketOriginAllowed("http://other.example.test", "trade.example.test", paperPolicy)).toBe(false);
    expect(websocketOriginAllowed("http://trade.example.test", "trade.example.test/path", paperPolicy)).toBe(false);
  });

  it("allows non-browser clients without Origin and leaves authentication to the target socket", () => {
    expect(websocketOriginAllowed(undefined, undefined, privatePolicy)).toBe(true);
  });
});
