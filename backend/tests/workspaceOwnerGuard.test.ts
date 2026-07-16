import express from "express";
import type { Server } from "node:http";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceRouter } from "../src/workspaces/routes.js";
import {
  DEFAULT_WORKSPACE_QUOTA_LIMITS,
  workspaceEnvelopeByteLimit
} from "../src/workspaces/quotas.js";

const OWNER_A = "00000000-0000-4000-8000-000000000031";
const OWNER_B = "00000000-0000-4000-8000-000000000032";
const TEST_LIMITS = {
  ...DEFAULT_WORKSPACE_QUOTA_LIMITS,
  maxDocumentBytes: 512,
  maxRetainedPayloadBytesPerOwner: 8_192
};
let server: Server;
let baseUrl: string;
const query = vi.fn().mockImplementation(async (text: string) => ({
  rows: text.includes("AS active_count")
    ? [{ active_count: "0", total_count: "0", payload_bytes_used: "0" }]
    : []
}));
const release = vi.fn();
const connect = vi.fn(async () => ({ query, release }));

describe("workspace expected-owner guard", () => {
  beforeAll(async () => {
    const app = express();
    app.use((request, response, next) => {
      response.locals.authMode = request.header("x-test-auth-mode") ?? "database";
      response.locals.authPrincipal = {
        user: {
          id: request.header("x-test-owner"),
          authorizationRevision: 1
        }
      };
      next();
    });
    app.use(
      "/api/workspaces",
      createWorkspaceRouter({ query, connect } as unknown as Pool, {
        limits: TEST_LIMITS
      })
    );
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
    connect.mockClear();
    release.mockClear();
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
    expect(connect).not.toHaveBeenCalled();
  });

  it("accepts a matching database owner and preserves headerless legacy compatibility", async () => {
    expect((await request(OWNER_B, OWNER_B)).status).toBe(200);
    expect((await request(OWNER_B, undefined, "legacy")).status).toBe(200);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(8);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("returns a stable no-store 400 for malformed workspace JSON", async () => {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-owner": OWNER_B,
        "x-sbv2-expected-user": OWNER_B
      },
      body: '{"clientId":'
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Workspace request body is not valid JSON.",
      code: "invalid_json"
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(query).not.toHaveBeenCalled();
  });

  it("returns a stable no-store 413 when the request envelope exceeds its bounded overhead", async () => {
    const envelopeLimit = workspaceEnvelopeByteLimit(TEST_LIMITS);
    const body = JSON.stringify({ padding: "x".repeat(envelopeLimit) });
    const envelopeBytes = Buffer.byteLength(body, "utf8");
    expect(envelopeBytes).toBeGreaterThan(envelopeLimit);

    const response = await fetch(`${baseUrl}/import`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-owner": OWNER_B,
        "x-sbv2-expected-user": OWNER_B
      },
      body
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: `Workspace request envelope exceeds ${envelopeLimit} bytes.`,
      code: "workspace_envelope_too_large",
      quota: {
        activeCount: 0,
        totalCount: 0,
        maxDocumentBytes: TEST_LIMITS.maxDocumentBytes
      },
      attempted: { envelopeBytes }
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe revisions and structurally invalid JSON before database access", async () => {
    for (const body of [
      {
        clientId: "unsafe-revision",
        name: "Unsafe revision",
        schemaVersion: 1,
        payload: {},
        revision: 1e100
      },
      {
        clientId: "nul-payload",
        name: "NUL payload",
        schemaVersion: 1,
        payload: { value: "NUL\u0000value" },
        revision: 1
      }
    ]) {
      const response = await fetch(
        `${baseUrl}/00000000-0000-4000-8000-000000000099`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-test-owner": OWNER_B,
            "x-sbv2-expected-user": OWNER_B
          },
          body: JSON.stringify(body)
        }
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    const invalidRename = await fetch(
      `${baseUrl}/00000000-0000-4000-8000-000000000099/name`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-test-owner": OWNER_B,
          "x-sbv2-expected-user": OWNER_B
        },
        body: JSON.stringify({ revision: 1, name: "NUL\u0000name" })
      }
    );
    expect(invalidRename.status).toBe(400);
    expect(await invalidRename.json()).toMatchObject({ code: "invalid_request" });
    expect(query).not.toHaveBeenCalled();
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
