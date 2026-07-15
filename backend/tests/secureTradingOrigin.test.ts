import type { Request } from "express";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { configureTrustedProxy, isSecureTradingOrigin } from "../src/secureTradingOrigin.js";

const originalOverride = process.env.ALLOW_INSECURE_TRADING_MUTATIONS;
const originalTrustProxy = process.env.TRUST_PROXY;

afterEach(() => {
  if (originalOverride === undefined) Reflect.deleteProperty(process.env, "ALLOW_INSECURE_TRADING_MUTATIONS");
  else process.env.ALLOW_INSECURE_TRADING_MUTATIONS = originalOverride;
  if (originalTrustProxy === undefined) Reflect.deleteProperty(process.env, "TRUST_PROXY");
  else process.env.TRUST_PROXY = originalTrustProxy;
});

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

  it("supports the explicit development override", () => {
    process.env.ALLOW_INSECURE_TRADING_MUTATIONS = "true";
    expect(isSecureTradingOrigin(request({ remoteAddress: "203.0.113.8" }))).toBe(true);
  });

  it("configures proxy trust only after an explicit environment setting", () => {
    const defaultApp = express();
    configureTrustedProxy(defaultApp);
    expect(defaultApp.get("trust proxy")).toBe(false);

    process.env.TRUST_PROXY = "loopback";
    const configuredApp = express();
    configureTrustedProxy(configuredApp);
    expect(configuredApp.get("trust proxy")).toBe("loopback");
  });
});
