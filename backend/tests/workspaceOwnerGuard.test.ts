import express from "express";
import type { Server } from "node:http";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceRouter } from "../src/workspaces/routes.js";

const OWNER_A = "00000000-0000-4000-8000-000000000031";
const OWNER_B = "00000000-0000-4000-8000-000000000032";
let server: Server;
let baseUrl: string;
const query = vi.fn().mockResolvedValue({ rows: [] });

describe("workspace expected-owner guard", () => {
  beforeAll(async () => {
    const app = express();
    app.use((request, response, next) => {
      response.locals.authMode = request.header("x-test-auth-mode") ?? "database";
      response.locals.authPrincipal = { user: { id: request.header("x-test-owner") } };
      next();
    });
    app.use("/api/workspaces", createWorkspaceRouter({ query } as unknown as Pool));
    app.use((_error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
      response.status(500).json({ code: "internal_error" });
    });
    server = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const port = (server.address() as { port: number }).port;
    baseUrl = `http://127.0.0.1:${port}/api/workspaces`;
  });

  beforeEach(() => {
    query.mockClear();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("rejects missing and mismatched expected owners in database auth mode", async () => {
    for (const expectedOwner of [undefined, OWNER_A]) {
      const response = await request(OWNER_B, expectedOwner);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "workspace_owner_mismatch" });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("accepts a matching database owner and preserves headerless legacy compatibility", async () => {
    expect((await request(OWNER_B, OWNER_B)).status).toBe(200);
    expect((await request(OWNER_B, undefined, "legacy")).status).toBe(200);
    expect(query).toHaveBeenCalledTimes(2);
  });
});

function request(owner: string, expectedOwner?: string, authMode = "database"): Promise<Response> {
  return fetch(baseUrl, {
    headers: {
      "x-test-owner": owner,
      "x-test-auth-mode": authMode,
      ...(expectedOwner ? { "x-sbv2-expected-user": expectedOwner } : {})
    }
  });
}
