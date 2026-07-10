import { describe, expect, it } from "vitest";
import { getAuthToken, issueWsTicket, roleForToken, verifyWsToken } from "../src/auth.js";

describe("token roles", () => {
  it("maps configured tokens to permission roles", () => {
    process.env.AUTH_READONLY_TOKEN = "readonly-role-test";
    process.env.AUTH_PAPER_TRADE_TOKEN = "paper-role-test";
    process.env.AUTH_LIVE_TRADE_TOKEN = "live-role-test";

    expect(roleForToken(getAuthToken())).toBe("admin");
    expect(roleForToken("readonly-role-test")).toBe("read-only");
    expect(roleForToken("paper-role-test")).toBe("paper-trade");
    expect(roleForToken("live-role-test")).toBe("live-trade");
    expect(roleForToken("missing")).toBeUndefined();
  });
});

describe("websocket auth", () => {
  it("accepts one-time websocket tickets", () => {
    const { ticket } = issueWsTicket();
    const encoded = Buffer.from(ticket, "utf8").toString("base64url");

    expect(verifyWsToken(new URL("http://localhost/trade-stream"), `sbv2.ticket.${encoded}`)).toBe(true);
    expect(verifyWsToken(new URL("http://localhost/trade-stream"), `sbv2.ticket.${encoded}`)).toBe(false);
  });

  it("accepts the trading token via websocket subprotocol fallback", () => {
    const token = getAuthToken();
    const encoded = Buffer.from(token, "utf8").toString("base64url");

    expect(verifyWsToken(new URL("http://localhost/trade-stream"), `sbv2.auth.${encoded}`)).toBe(true);
    expect(verifyWsToken(new URL("http://localhost/trade-stream"), "sbv2.auth.invalid")).toBe(false);
  });

  it("rejects websocket tokens in the URL query", () => {
    const token = getAuthToken();
    expect(verifyWsToken(new URL(`http://localhost/trade-stream?token=${token}`))).toBe(false);
  });
});
