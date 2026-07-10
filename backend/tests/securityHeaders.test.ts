import express from "express";
import http from "node:http";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { securityHeaders } from "../src/securityHeaders.js";

let base: string;
let server: Server;

beforeAll(async () => {
  const app = express();
  app.use(securityHeaders);
  app.get("/probe", (_req, res) => res.json({ ok: true }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server?.close();
});

describe("securityHeaders", () => {
  it("sets CSP and browser hardening headers", async () => {
    const res = await fetch(`${base}/probe`);

    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("content-security-policy")).not.toContain("upgrade-insecure-requests");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("permissions-policy")).toContain("camera=()");
  });

  it("does not send COOP on plain HTTP IP origins", async () => {
    const url = new URL(base);
    const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: Number(url.port), path: "/probe", headers: { Host: "203.0.113.10:4180" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.headers));
        }
      );
      req.on("error", reject);
      req.end();
    });

    expect(headers["cross-origin-opener-policy"]).toBeUndefined();
  });
});
