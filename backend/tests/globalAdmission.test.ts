import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { classifyApiAdmissionLane, GlobalAdmissionController } from "../src/http/globalAdmission.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        })
    )
  );
});

describe("global admission controller", () => {
  it("reserves capacity for control traffic while ordinary work queues", async () => {
    const controller = new GlobalAdmissionController({
      maxActive: 3,
      reservedControlSlots: 1,
      maxQueued: 2,
      queueTimeoutMs: 500
    });
    const gates: Array<() => void> = [];
    const { origin } = await serve(controller, (request, response) => {
      if (request.path.startsWith("/api/auth/")) {
        response.json({ ok: true, lane: "control" });
        return;
      }
      void new Promise<void>((resolve) => gates.push(resolve)).then(() => {
        response.json({ ok: true, lane: "ordinary" });
      });
    });

    const first = fetch(`${origin}/api/work/1`);
    const second = fetch(`${origin}/api/work/2`);
    await waitFor(() => controller.snapshot().activeOrdinary === 2);
    const queued = fetch(`${origin}/api/work/3`);
    await waitFor(() => controller.snapshot().queued === 1);

    const control = await fetch(`${origin}/api/auth/me`);
    expect(control.status).toBe(200);
    expect(await control.json()).toEqual({ ok: true, lane: "control" });
    expect(controller.snapshot()).toMatchObject({
      activeOrdinary: 2,
      queued: 1,
      rejected: 0
    });

    gates.shift()?.();
    expect((await first).status).toBe(200);
    await waitFor(() => controller.snapshot().queued === 0);
    gates.splice(0).forEach((release) => release());
    expect((await second).status).toBe(200);
    expect((await queued).status).toBe(200);
  });

  it("rejects overflow and times out queued work with a stable response", async () => {
    const controller = new GlobalAdmissionController({
      maxActive: 2,
      reservedControlSlots: 1,
      maxQueued: 1,
      queueTimeoutMs: 100,
      retryAfterSeconds: 2
    });
    let release: (() => void) | undefined;
    const { origin } = await serve(controller, (_request, response) => {
      void new Promise<void>((resolve) => {
        release = resolve;
      }).then(() => response.json({ ok: true }));
    });

    const active = fetch(`${origin}/api/work/active`);
    await waitFor(() => controller.snapshot().activeOrdinary === 1);
    const queued = fetch(`${origin}/api/work/queued`);
    await waitFor(() => controller.snapshot().queued === 1);
    const overflow = await fetch(`${origin}/api/ready`);
    expect(overflow.status).toBe(503);
    expect(overflow.headers.get("cache-control")).toBe("no-store");
    expect(overflow.headers.get("retry-after")).toBe("2");
    expect(await overflow.json()).toMatchObject({
      code: "global_admission_exhausted",
      retryable: true
    });

    const timedOut = await queued;
    expect(timedOut.status).toBe(503);
    expect(await timedOut.json()).toMatchObject({
      code: "global_admission_exhausted"
    });
    expect(controller.snapshot()).toMatchObject({
      queued: 0,
      rejected: 2,
      timedOut: 1
    });

    release?.();
    expect((await active).status).toBe(200);
  });

  it("releases capacity after a disconnected queued request", async () => {
    const controller = new GlobalAdmissionController({
      maxActive: 2,
      reservedControlSlots: 1,
      maxQueued: 1,
      queueTimeoutMs: 1_000
    });
    let release: (() => void) | undefined;
    const { origin } = await serve(controller, (_request, response) => {
      void new Promise<void>((resolve) => {
        release = resolve;
      }).then(() => response.json({ ok: true }));
    });

    const active = fetch(`${origin}/api/work/active`);
    await waitFor(() => controller.snapshot().activeOrdinary === 1);
    const abort = new AbortController();
    const queued = fetch(`${origin}/api/work/queued`, { signal: abort.signal });
    await waitFor(() => controller.snapshot().queued === 1);
    abort.abort();
    await expect(queued).rejects.toThrow();
    await waitFor(() => controller.snapshot().queued === 0);
    expect(controller.snapshot().cancelledWhileQueued).toBe(1);

    release?.();
    expect((await active).status).toBe(200);
  });

  it("marks a queued readiness timeout no-store before its route runs", async () => {
    const controller = new GlobalAdmissionController({
      maxActive: 2,
      reservedControlSlots: 1,
      maxQueued: 1,
      queueTimeoutMs: 100
    });
    let release: (() => void) | undefined;
    const { origin } = await serve(controller, (_request, response) => {
      void new Promise<void>((resolve) => {
        release = resolve;
      }).then(() => response.json({ ok: true }));
    });

    const active = fetch(`${origin}/api/work/active`);
    await waitFor(() => controller.snapshot().activeOrdinary === 1);
    const readiness = fetch(`${origin}/api/ready`);
    await waitFor(() => controller.snapshot().queued === 1);

    const timedOut = await readiness;
    expect(timedOut.status).toBe(503);
    expect(timedOut.headers.get("cache-control")).toBe("no-store");
    expect(await timedOut.json()).toMatchObject({
      code: "global_admission_exhausted"
    });

    release?.();
    expect((await active).status).toBe(200);
  });

  it("classifies probes and recovery controls without broad method bypasses", () => {
    expect(classify("/api/health", "GET")).toBe("bypass");
    expect(classify("/api/ready", "GET")).toBe("ordinary");
    expect(classify("/api/auth/login", "POST")).toBe("control");
    expect(classify("/api/jobs/abc/cancel", "POST")).toBe("control");
    expect(classify("/api/trade/bots/abc/stop", "POST")).toBe("control");
    expect(classify("/api/trade/kill", "POST")).toBe("control");
    expect(classify("/api/jobs", "POST")).toBe("ordinary");
    expect(classify("/api/trade/bots/abc/start", "POST")).toBe("ordinary");
    expect(classify("/api/admin/users", "GET")).toBe("ordinary");
  });

  it("bounds readiness work while cheap liveness bypasses ordinary saturation", async () => {
    const controller = new GlobalAdmissionController({
      maxActive: 2,
      reservedControlSlots: 1,
      maxQueued: 1,
      queueTimeoutMs: 500
    });
    const gates: Array<() => void> = [];
    const { origin } = await serve(controller, (request, response) => {
      if (request.path === "/api/health") {
        response.json({ ok: true });
        return;
      }
      void new Promise<void>((resolve) => gates.push(resolve)).then(() => {
        response.json({ ok: true });
      });
    });

    const active = fetch(`${origin}/api/work`);
    await waitFor(() => controller.snapshot().activeOrdinary === 1);
    const readiness = fetch(`${origin}/api/ready`);
    await waitFor(() => controller.snapshot().queued === 1);

    const health = await fetch(`${origin}/api/health`);
    expect(health.status).toBe(200);
    expect(controller.snapshot()).toMatchObject({
      activeOrdinary: 1,
      queued: 1
    });

    gates.shift()?.();
    expect((await active).status).toBe(200);
    await waitFor(() => controller.snapshot().queued === 0);
    gates.shift()?.();
    const readinessResponse = await readiness;
    expect(readinessResponse.status).toBe(200);
    expect(readinessResponse.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects configurations that cannot preserve a control reserve", () => {
    expect(
      () =>
        new GlobalAdmissionController({
          maxActive: 16,
          reservedControlSlots: 16,
          maxQueued: 1,
          queueTimeoutMs: 100
        })
    ).toThrow(/reservedControlSlots/);
  });
});

async function serve(controller: GlobalAdmissionController, handler: express.RequestHandler): Promise<{ origin: string }> {
  const app = express();
  app.use(controller.middleware());
  app.use(handler);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return { origin: `http://127.0.0.1:${address.port}` };
}

function classify(path: string, method: string) {
  return classifyApiAdmissionLane({ path, originalUrl: path, method });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2_000) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
