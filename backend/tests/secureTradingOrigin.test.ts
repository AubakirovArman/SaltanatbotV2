import type { Request } from "express";
import express from "express";
import { describe, expect, it } from "vitest";
import { configureTrustedProxy, isSecureTradingOrigin } from "../src/secureTradingOrigin.js";

function request(input: { remoteAddress?: string; secure?: boolean; headers?: Record<string, string> }): Request {
  return {
    secure: input.secure ?? false,
    headers: input.headers ?? {},
    socket: { remoteAddress: input.remoteAddress }
  } as unknown as Request;
}

describe("secure live-trading origin", () => {
  it("allows direct loopback and TLS requests", () => {
    expect(isSecureTradingOrigin(request({ remoteAddress: "127.0.0.1" }))).toBe(true);
    expect(isSecureTradingOrigin(request({ remoteAddress: "::ffff:127.0.0.1" }))).toBe(true);
    expect(isSecureTradingOrigin(request({ remoteAddress: "203.0.113.8", secure: true }))).toBe(true);
  });

  it("does not trust Host or forwarded HTTPS from an untrusted proxy", () => {
    expect(isSecureTradingOrigin(request({ remoteAddress: "203.0.113.8", headers: { host: "localhost" } }))).toBe(false);
    expect(isSecureTradingOrigin(request({ remoteAddress: "127.0.0.1", headers: { "x-forwarded-proto": "https" } }))).toBe(false);
  });

  it("honors an explicitly injected insecure-origin policy", () => {
    expect(isSecureTradingOrigin(request({ remoteAddress: "203.0.113.8" }), true)).toBe(true);
  });

  it("configures proxy trust only after an explicit environment setting", () => {
    const defaultApp = express();
    configureTrustedProxy(defaultApp, false);
    expect(defaultApp.get("trust proxy")).toBe(false);

    const configuredApp = express();
    configureTrustedProxy(configuredApp, "loopback");
    expect(configuredApp.get("trust proxy")).toBe("loopback");
  });
});
