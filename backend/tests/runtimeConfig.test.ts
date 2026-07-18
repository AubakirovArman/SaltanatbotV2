import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { initializeRuntimeConfig, loadRuntimeConfig, resetRuntimeConfigForTests, type RuntimeConfig, validateFuturePrivateLiveBoundary } from "../src/config/runtimeConfig.js";

const privateLiveEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  RUNTIME_PROFILE: "private-live",
  HOST: "127.0.0.1",
  PORT: "4180",
  AUTH_MODE: "database",
  COOKIE_SECURE: "1",
  PUBLIC_ORIGIN: "https://trade.example.test",
  ALLOWED_ORIGINS: "",
  TRUST_PROXY: "loopback",
  ALLOW_INSECURE_TRADING_MUTATIONS: "0"
};

afterEach(() => resetRuntimeConfigForTests());

describe("typed runtime configuration", () => {
  it("uses fail-closed defaults and deeply freezes the snapshot", () => {
    const config = loadRuntimeConfig({ NODE_ENV: "production" } as NodeJS.ProcessEnv);

    expect(config).toEqual({
      runtimeProfile: "public-http-paper",
      frontend: {
        distDir: path.resolve(import.meta.dirname, "../../frontend/dist")
      },
      server: {
        host: "127.0.0.1",
        port: 4180,
        publicOrigin: undefined,
        allowedOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
        trustProxy: false
      },
      auth: { mode: "database", cookieSecure: false },
      security: { allowInsecureTradingMutations: false },
      trading: { enableLiveSpot: false },
      operations: {
        recoveryStatusFile: undefined,
        admission: {
          maxActive: 128,
          reservedControlSlots: 16,
          maxQueued: 256,
          queueTimeoutMs: 2_000
        },
        readiness: {
          researchWorkerHeartbeatStaleMs: 90_000,
          requireNotificationWorker: false,
          resultTtlMs: 1_000,
          rateLimit: {
            refillPerSecond: 2,
            burst: 10,
            maxBuckets: 4_096
          },
          diskPath: path.resolve(import.meta.dirname, "../data"),
          diskSoftFreeBytes: 5 * 1_024 ** 3,
          diskHardFreeBytes: 2 * 1_024 ** 3,
          diskSoftFreePercent: 5,
          diskHardFreePercent: 2
        }
      }
    });
    expect(allRuntimeConfigObjects(config).every(Object.isFrozen)).toBe(true);
  });

  it("pins one normalized absolute frontend release directory without echoing invalid input", () => {
    const configured = path.resolve(import.meta.dirname, "../../protected-release/frontend/dist");
    expect(loadRuntimeConfig({ NODE_ENV: "production", FRONTEND_DIST_DIR: configured } as NodeJS.ProcessEnv).frontend.distDir).toBe(configured);

    const secretBearingPath = "relative/operator-secret/frontend";
    expect(() => loadRuntimeConfig({ NODE_ENV: "production", FRONTEND_DIST_DIR: secretBearingPath } as NodeJS.ProcessEnv)).toThrowError(expect.objectContaining({ message: expect.not.stringContaining("operator-secret") }));
    expect(() => loadRuntimeConfig({ NODE_ENV: "production", FRONTEND_DIST_DIR: `${configured}/../dist` } as NodeJS.ProcessEnv)).toThrow(/normalized absolute filesystem path/);
  });

  it("accepts only an optional normalized absolute recovery status file", () => {
    const configured = path.resolve(import.meta.dirname, "../data/recovery-status.json");
    expect(
      loadRuntimeConfig({
        NODE_ENV: "production",
        OPERATIONS_RECOVERY_STATUS_FILE: configured
      } as NodeJS.ProcessEnv).operations.recoveryStatusFile
    ).toBe(configured);
    expect(
      loadRuntimeConfig({
        NODE_ENV: "production",
        OPERATIONS_RECOVERY_STATUS_FILE: ""
      } as NodeJS.ProcessEnv).operations.recoveryStatusFile
    ).toBeUndefined();
  });

  it("does not let NODE_ENV select legacy authentication", () => {
    expect(loadRuntimeConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv).auth.mode).toBe("database");
    expect(loadRuntimeConfig({ NODE_ENV: "test", AUTH_MODE: "legacy" } as NodeJS.ProcessEnv).auth.mode).toBe("legacy");
    expect(loadRuntimeConfig({ DEMO_MODE: "1", AUTH_TOKEN: "explicit-demo-token" } as NodeJS.ProcessEnv).auth.mode).toBe("legacy");
    expect(loadRuntimeConfig({ DEMO_MODE: "1" } as NodeJS.ProcessEnv).auth.mode).toBe("database");
  });

  it("normalizes exact origins and parses a narrow proxy allowlist", () => {
    const config = loadRuntimeConfig({
      NODE_ENV: "production",
      PUBLIC_ORIGIN: "https://EXAMPLE.test:443/",
      ALLOWED_ORIGINS: "https://ui.example.test/,https://ui.example.test,https://other.example.test:8443",
      TRUST_PROXY: "127.0.0.1,10.20.0.0/16"
    } as NodeJS.ProcessEnv);

    expect(config.server.publicOrigin).toBe("https://example.test");
    expect(config.server.allowedOrigins).toEqual(["https://ui.example.test", "https://other.example.test:8443"]);
    expect(config.server.trustProxy).toEqual(["127.0.0.1", "10.20.0.0/16"]);
    expect(Object.isFrozen(config.server.trustProxy)).toBe(true);
  });

  it.each(["production", "development", "test"])("cannot activate private-live from %s environment", (nodeEnv) => {
    expect(() => loadRuntimeConfig({ ...privateLiveEnv, NODE_ENV: nodeEnv, ENABLE_LIVE_SPOT: "true" })).toThrow(/private-live is disabled in this pre-HTTPS release/);
  });

  it("retains a pure validator for the future private-live HTTPS boundary", () => {
    expect(() => validateFuturePrivateLiveBoundary({ ...privateLiveEnv, ENABLE_LIVE_SPOT: "true" })).not.toThrow();
    expect(() => validateFuturePrivateLiveBoundary({ RUNTIME_PROFILE: "public-http-paper" })).toThrow(/requires RUNTIME_PROFILE=private-live/);
  });

  it.each(["loopback", "127.0.0.1", "10.20.30.0/28", "fd00::/124"])("validates a bounded future private-live proxy identity: %s", (trustProxy) => {
    expect(() => validateFuturePrivateLiveBoundary({ ...privateLiveEnv, TRUST_PROXY: trustProxy })).not.toThrow();
  });

  it.each([
    ["RUNTIME_PROFILE", { RUNTIME_PROFILE: "live" }, /Invalid RUNTIME_PROFILE/],
    ["HOST", { HOST: "http://127.0.0.1" }, /Invalid HOST/],
    ["PORT fractional", { PORT: "4180.5" }, /Invalid PORT/],
    ["PORT range", { PORT: "65536" }, /Invalid PORT/],
    ["AUTH_MODE", { AUTH_MODE: "oauth" }, /Invalid AUTH_MODE/],
    ["COOKIE_SECURE", { COOKIE_SECURE: "yes" }, /Invalid COOKIE_SECURE/],
    ["PUBLIC_ORIGIN path", { PUBLIC_ORIGIN: "https://example.test/app" }, /Invalid PUBLIC_ORIGIN/],
    ["ALLOWED_ORIGINS wildcard", { ALLOWED_ORIGINS: "*" }, /Invalid ALLOWED_ORIGINS/],
    ["TRUST_PROXY global", { TRUST_PROXY: "true" }, /Invalid TRUST_PROXY=true/],
    ["TRUST_PROXY hostname", { TRUST_PROXY: "proxy.internal" }, /Invalid TRUST_PROXY/],
    ["live spot in paper mode", { ENABLE_LIVE_SPOT: "1" }, /conflicts with RUNTIME_PROFILE=public-http-paper/],
    ["insecure mutations in paper mode", { ALLOW_INSECURE_TRADING_MUTATIONS: "true" }, /conflicts with RUNTIME_PROFILE=public-http-paper/],
    ["admission active type", { GLOBAL_ADMISSION_MAX_ACTIVE: "16.5" }, /GLOBAL_ADMISSION_MAX_ACTIVE/],
    ["admission reserve range", { GLOBAL_ADMISSION_MAX_ACTIVE: "16", GLOBAL_ADMISSION_RESERVED_CONTROL: "16" }, /must be lower/],
    ["admission queue range", { GLOBAL_ADMISSION_MAX_QUEUED: "0" }, /GLOBAL_ADMISSION_MAX_QUEUED/],
    ["admission timeout range", { GLOBAL_ADMISSION_QUEUE_TIMEOUT_MS: "99" }, /GLOBAL_ADMISSION_QUEUE_TIMEOUT_MS/],
    ["worker heartbeat range", { RESEARCH_WORKER_HEARTBEAT_STALE_MS: "9999" }, /RESEARCH_WORKER_HEARTBEAT_STALE_MS/],
    ["readiness result TTL range", { READINESS_RESULT_TTL_MS: "99" }, /READINESS_RESULT_TTL_MS/],
    ["readiness refill type", { READINESS_RATE_REFILL_PER_SECOND: "1.5" }, /READINESS_RATE_REFILL_PER_SECOND/],
    ["readiness burst range", { READINESS_RATE_BURST: "0" }, /READINESS_RATE_BURST/],
    ["readiness bucket range", { READINESS_RATE_MAX_BUCKETS: "255" }, /READINESS_RATE_MAX_BUCKETS/],
    ["operations path", { OPERATIONS_DISK_PATH: "relative/data" }, /OPERATIONS_DISK_PATH/],
    ["recovery status path", { OPERATIONS_RECOVERY_STATUS_FILE: "relative/status.json" }, /OPERATIONS_RECOVERY_STATUS_FILE/],
    ["recovery status whitespace", { OPERATIONS_RECOVERY_STATUS_FILE: " /tmp/status.json" }, /OPERATIONS_RECOVERY_STATUS_FILE/],
    [
      "disk bytes ordering",
      {
        OPERATIONS_DISK_HARD_FREE_BYTES: String(6 * 1_024 ** 3),
        OPERATIONS_DISK_SOFT_FREE_BYTES: String(5 * 1_024 ** 3)
      },
      /HARD_FREE_BYTES must be lower/
    ],
    [
      "disk percent ordering",
      {
        OPERATIONS_DISK_HARD_FREE_PERCENT: "5",
        OPERATIONS_DISK_SOFT_FREE_PERCENT: "5"
      },
      /HARD_FREE_PERCENT must be lower/
    ]
  ])("rejects invalid %s configuration", (_label, overrides, expected) => {
    expect(() => loadRuntimeConfig({ NODE_ENV: "production", ...overrides } as NodeJS.ProcessEnv)).toThrow(expected);
  });

  it.each([
    ["database authentication", { AUTH_MODE: "legacy" }, /AUTH_MODE=database/],
    ["loopback binding", { HOST: "0.0.0.0" }, /HOST must bind to loopback/],
    ["public origin", { PUBLIC_ORIGIN: undefined }, /PUBLIC_ORIGIN must be an https origin/],
    ["HTTPS public origin", { PUBLIC_ORIGIN: "http://trade.example.test" }, /PUBLIC_ORIGIN must be an https origin/],
    ["secure cookies", { COOKIE_SECURE: "0" }, /COOKIE_SECURE=true/],
    ["named proxy", { TRUST_PROXY: "" }, /TRUST_PROXY must use loopback/],
    ["non-numeric proxy trust", { TRUST_PROXY: "1" }, /TRUST_PROXY must use loopback/],
    ["IPv4 trust-all CIDR", { TRUST_PROXY: "0.0.0.0/0" }, /CIDRs no broader than IPv4 \/28 or IPv6 \/124/],
    ["IPv6 trust-all CIDR", { TRUST_PROXY: "::/0" }, /CIDRs no broader than IPv4 \/28 or IPv6 \/124/],
    ["misleading loopback trust-all CIDR", { TRUST_PROXY: "127.0.0.1/0" }, /CIDRs no broader than IPv4 \/28 or IPv6 \/124/],
    ["link-local named range", { TRUST_PROXY: "linklocal" }, /CIDRs no broader than IPv4 \/28 or IPv6 \/124/],
    ["unique-local named range", { TRUST_PROXY: "uniquelocal" }, /CIDRs no broader than IPv4 \/28 or IPv6 \/124/],
    ["HTTPS CORS origins", { ALLOWED_ORIGINS: "http://localhost:5173" }, /ALLOWED_ORIGINS must be empty or contain only https/],
    ["no insecure override", { ALLOW_INSECURE_TRADING_MUTATIONS: "1" }, /ALLOW_INSECURE_TRADING_MUTATIONS must be false/],
    ["no demo alias", { DEMO_MODE: "1" }, /DEMO_MODE must be false/]
  ])("rejects private-live without %s", (_label, overrides, expected) => {
    expect(() => validateFuturePrivateLiveBoundary({ ...privateLiveEnv, ...overrides })).toThrow(expected);
  });

  it("pins one process snapshot and rejects attempted re-arming", () => {
    const first = initializeRuntimeConfig({ NODE_ENV: "production", PORT: "4180" } as NodeJS.ProcessEnv);
    expect(initializeRuntimeConfig({ NODE_ENV: "production", PORT: "4180" } as NodeJS.ProcessEnv)).toBe(first);
    expect(() => initializeRuntimeConfig({ NODE_ENV: "production", PORT: "4181" } as NodeJS.ProcessEnv)).toThrow(/already initialized/);
  });

  it("does not echo origin credentials in validation errors", () => {
    expect(() =>
      loadRuntimeConfig({
        NODE_ENV: "production",
        PUBLIC_ORIGIN: "https://operator:must-not-leak@example.test"
      } as NodeJS.ProcessEnv)
    ).toThrowError(expect.objectContaining({ message: expect.not.stringContaining("must-not-leak") }));
  });
});

function allRuntimeConfigObjects(config: RuntimeConfig): object[] {
  const trustProxy = config.server.trustProxy;
  return [config, config.frontend, config.server, config.server.allowedOrigins, config.auth, config.security, config.trading, config.operations, config.operations.admission, config.operations.readiness, config.operations.readiness.rateLimit, ...(Array.isArray(trustProxy) ? [trustProxy] : [])];
}
