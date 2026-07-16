import { describe, expect, it } from "vitest";
import {
  assertLiveExecutionAllowed,
  PAPER_ONLY_MODE_CODE,
  resolveRuntimeProfile,
  runtimeProfilePublicState
} from "../src/runtimeProfile.js";

describe("runtime execution profile", () => {
  it("fails closed to public-http-paper when no profile is configured", () => {
    const policy = resolveRuntimeProfile({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
    expect(policy).toMatchObject({
      runtimeProfile: "public-http-paper",
      executionMode: "paper-only",
      liveBotConfigsAllowed: false,
      credentialWritesAllowed: false,
      privateExchangeReadsAllowed: false,
      privateExchangeMutationsAllowed: false,
      privateStreamsAllowed: false
    });
    expect(runtimeProfilePublicState(policy)).toEqual({
      runtimeProfile: "public-http-paper",
      executionMode: "paper-only",
      privateExchangeRequests: false,
      credentialWrites: false
    });
  });

  it("keeps DEMO_MODE=true as a deprecated paper-only alias", () => {
    expect(resolveRuntimeProfile({ DEMO_MODE: "true" } as NodeJS.ProcessEnv).runtimeProfile).toBe("public-http-paper");
  });

  it("requires an explicit valid profile for live-capable test/future deployments", () => {
    expect(resolveRuntimeProfile(privateLiveEnv())).toMatchObject({
      runtimeProfile: "private-live",
      executionMode: "live-capable",
      liveBotConfigsAllowed: true,
      credentialWritesAllowed: true
    });
  });

  it("rejects invalid, contradictory and accidentally armed configuration", () => {
    expect(() => resolveRuntimeProfile({ RUNTIME_PROFILE: "typo" } as NodeJS.ProcessEnv)).toThrow(/Invalid RUNTIME_PROFILE/);
    expect(() => resolveRuntimeProfile({ DEMO_MODE: "sometimes" } as NodeJS.ProcessEnv)).toThrow(/Invalid DEMO_MODE/);
    expect(() => resolveRuntimeProfile({ ...privateLiveEnv(), DEMO_MODE: "1" })).toThrow(/DEMO_MODE must be false/);
    expect(() => resolveRuntimeProfile({ RUNTIME_PROFILE: "public-http-paper", ALLOW_INSECURE_TRADING_MUTATIONS: "true" } as NodeJS.ProcessEnv)).toThrow(/conflicts/);
    expect(() => resolveRuntimeProfile({ ENABLE_LIVE_SPOT: "1" } as NodeJS.ProcessEnv)).toThrow(/conflicts/);
  });

  it("returns a stable error code and an immutable policy", () => {
    const policy = resolveRuntimeProfile({ RUNTIME_PROFILE: "public-http-paper" } as NodeJS.ProcessEnv);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(() => assertLiveExecutionAllowed("test live start", policy)).toThrowError(expect.objectContaining({ code: PAPER_ONLY_MODE_CODE }));
  });
});

function privateLiveEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    RUNTIME_PROFILE: "private-live",
    AUTH_MODE: "database",
    HOST: "127.0.0.1",
    COOKIE_SECURE: "1",
    PUBLIC_ORIGIN: "https://trade.example.test",
    ALLOWED_ORIGINS: "",
    TRUST_PROXY: "loopback"
  };
}
