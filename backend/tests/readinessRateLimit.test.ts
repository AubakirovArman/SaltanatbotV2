import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../src/config/runtimeConfig.js";
import { GlobalAdmissionController } from "../src/http/globalAdmission.js";
import { ReadinessRateLimiter } from "../src/http/readinessRateLimit.js";
import type { IdentityRuntime } from "../src/identity/runtime.js";
import { registerIdentityServerRoutes } from "../src/identity/serverRoutes.js";
import { ApiMetrics } from "../src/operations/apiMetrics.js";
import { OperationalStatusService } from "../src/operations/statusService.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("public readiness rate limit", () => {
  it("limits only readiness by IP before its handler and exposes bounded counters", async () => {
    let now = 0;
    const limiter = new ReadinessRateLimiter({
      refillPerSecond: 2,
      burst: 2,
      maxBuckets: 8,
      now: () => now
    });
    const { origin } = await serveReadiness(limiter);

    expect((await fetch(`${origin}/api/ready`)).status).toBe(200);
    expect((await fetch(`${origin}/api/ready`)).status).toBe(200);
    const rejected = await fetch(`${origin}/api/ready`);
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("Cache-Control")).toBe("no-store");
    expect(rejected.headers.get("Retry-After")).toBe("1");
    expect(await rejected.json()).toMatchObject({
      code: "readiness_rate_limited",
      retryable: true
    });

    const authConfig = await fetch(`${origin}/api/auth/config`);
    expect(authConfig.status).toBe(200);
    expect(await authConfig.json()).toMatchObject({ mode: "legacy" });

    now += 500;
    expect((await fetch(`${origin}/api/ready`)).status).toBe(200);
    expect(limiter.snapshot()).toEqual({
      refillPerSecond: 2,
      burst: 2,
      maxBuckets: 8,
      buckets: 1,
      allowed: 3,
      rejected: 1
    });
  });

  it("fails closed for unseen IPs when the bounded bucket store is full", async () => {
    let now = 0;
    const limiter = new ReadinessRateLimiter({
      refillPerSecond: 1,
      burst: 1,
      maxBuckets: 1,
      now: () => now
    });
    const { origin } = await serveReadiness(limiter, true);

    expect(
      (
        await fetch(`${origin}/api/ready`, {
          headers: { "x-forwarded-for": "198.51.100.1" }
        })
      ).status
    ).toBe(200);
    const full = await fetch(`${origin}/api/ready`, {
      headers: { "x-forwarded-for": "198.51.100.2" }
    });
    expect(full.status).toBe(429);
    expect(full.headers.get("Retry-After")).toBe("60");
    expect(limiter.snapshot()).toMatchObject({
      buckets: 1,
      allowed: 1,
      rejected: 1
    });

    now += 30_000;
    const stillFull = await fetch(`${origin}/api/ready`, {
      headers: { "x-forwarded-for": "198.51.100.2" }
    });
    expect(stillFull.status).toBe(429);
    expect(stillFull.headers.get("Retry-After")).toBe("30");

    now += 30_000;
    expect(
      (
        await fetch(`${origin}/api/ready`, {
          headers: { "x-forwarded-for": "198.51.100.2" }
        })
      ).status
    ).toBe(200);
    expect(limiter.snapshot()).toMatchObject({
      buckets: 1,
      allowed: 2,
      rejected: 2
    });
  });
});

async function serveReadiness(limiter: ReadinessRateLimiter, trustProxy = false): Promise<{ origin: string }> {
  const runtimeConfig = loadRuntimeConfig({
    NODE_ENV: "test",
    AUTH_MODE: "legacy"
  } as NodeJS.ProcessEnv);
  const operations = new OperationalStatusService({
    runtimeConfig,
    admission: new GlobalAdmissionController(runtimeConfig.operations.admission),
    apiMetrics: new ApiMetrics(),
    readinessRateLimit: limiter,
    executorReady: () => true,
    now: () => 0,
    readDisk: async () => ({
      freeBytes: 100 * 1_024 ** 3,
      totalBytes: 1_000 * 1_024 ** 3
    })
  });
  const runtime: IdentityRuntime = {
    mode: "legacy",
    async close() {}
  };
  const app = express();
  app.set("trust proxy", trustProxy);
  registerIdentityServerRoutes(app, runtime, {
    operations,
    readinessRateLimit: limiter.middleware()
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${address.port}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}
