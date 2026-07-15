import express from "express";
import type { Server } from "node:http";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../src/database/migrations.js";
import { createWorkspaceRouter } from "../src/workspaces/routes.js";

const connectionString = process.env.WORKSPACES_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const OWNER_A = "00000000-0000-4000-8000-000000000031";
const OWNER_B = "00000000-0000-4000-8000-000000000032";
let pool: Pool;
let server: Server;
let baseUrl: string;

interface WorkspaceJson {
  id: string;
  clientId: string;
  name: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
  revision: number;
}

interface ApiJson {
  [key: string]: unknown;
  workspace?: WorkspaceJson;
  workspaces?: WorkspaceJson[];
  revisions?: WorkspaceJson[];
}

describePostgres("workspaces against isolated PostgreSQL", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 8 });
    await migrateDatabase(pool);
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[OWNER_A, OWNER_B]]);
    await pool.query(
      `INSERT INTO users (id, login, login_normalized, password_hash, status)
       VALUES ($1, 'workspace-owner-a', 'workspace-owner-a', $3, 'active'),
              ($2, 'workspace-owner-b', 'workspace-owner-b', $3, 'active')`,
      [OWNER_A, OWNER_B, "test-password-hash-placeholder"]
    );
    ({ server, baseUrl } = await startWorkspaceApi(pool));
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE workspace_revisions, workspaces");
  });

  afterAll(async () => {
    if (server) await closeServer(server);
    if (pool) {
      await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[OWNER_A, OWNER_B]]);
      await pool.end();
    }
  });

  it("prevents owner-scoped IDOR reads, writes, deletes, revision reads, and rollbacks", async () => {
    const created = await createWorkspace(OWNER_A, "private-chart", "Private chart", { owner: "a" });

    expect((await api(OWNER_B, `/${created.id}`)).status).toBe(404);
    expect(await json(await api(OWNER_B, "/"))).toEqual({ workspaces: [] });
    expect(await json(await api(OWNER_B, `/${created.id}/revisions`))).toEqual({ revisions: [] });

    const foreignUpdate = await api(OWNER_B, `/${created.id}`, {
      method: "PUT",
      body: workspaceInput("private-chart", "Hijacked", { owner: "b" }, 1)
    });
    expect(foreignUpdate.status).toBe(409);
    expect(await json(foreignUpdate)).toEqual({ error: "Workspace revision conflict", code: "workspace_conflict" });

    expect((await api(OWNER_B, `/${created.id}?revision=1`, { method: "DELETE" })).status).toBe(404);
    const foreignRollback = await api(OWNER_B, `/${created.id}/rollback`, {
      method: "POST",
      body: { revision: 1, targetRevision: 1 }
    });
    expect(foreignRollback.status).toBe(404);
    expect(await json(foreignRollback)).toMatchObject({ code: "workspace_revision_not_found" });

    const ownerView = await api(OWNER_A, `/${created.id}`);
    expect(ownerView.status).toBe(200);
    expect((await json(ownerView)).workspace).toMatchObject({ name: "Private chart", payload: { owner: "a" }, revision: 1 });
  });

  it("returns the current document on stale update, delete, and rollback conflicts without adding revisions", async () => {
    const created = await createWorkspace(OWNER_A, "optimistic", "Revision one", { version: 1 });
    const updatedResponse = await api(OWNER_A, `/${created.id}`, {
      method: "PUT",
      body: workspaceInput("optimistic", "Revision two", { version: 2 }, 1)
    });
    expect(updatedResponse.status).toBe(200);
    const updated = (await json(updatedResponse)).workspace as WorkspaceJson;
    expect(updated.revision).toBe(2);

    for (const response of [
      await api(OWNER_A, `/${created.id}`, {
        method: "PUT",
        body: workspaceInput("optimistic", "Stale update", { version: 999 }, 1)
      }),
      await api(OWNER_A, `/${created.id}?revision=1`, { method: "DELETE" }),
      await api(OWNER_A, `/${created.id}/rollback`, {
        method: "POST",
        body: { revision: 1, targetRevision: 1 }
      })
    ]) {
      expect(response.status).toBe(409);
      expect(await json(response)).toMatchObject({
        code: "workspace_conflict",
        current: { id: created.id, revision: 2, name: "Revision two", payload: { version: 2 } }
      });
    }

    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM workspace_revisions WHERE workspace_id = $1",
      [created.id]
    );
    expect(count.rows[0]?.count).toBe("2");
  });

  it("retains only 20 revisions and keeps that cap after rollback", async () => {
    const created = await createWorkspace(OWNER_A, "revision-cap", "Revision 1", { version: 1 });
    let revision = created.revision;
    for (let nextRevision = 2; nextRevision <= 26; nextRevision += 1) {
      const response = await api(OWNER_A, `/${created.id}`, {
        method: "PUT",
        body: workspaceInput("revision-cap", `Revision ${nextRevision}`, { version: nextRevision }, revision)
      });
      expect(response.status).toBe(200);
      revision = ((await json(response)).workspace as WorkspaceJson).revision;
    }
    expect(revision).toBe(26);

    const beforeRollback = (await json(await api(OWNER_A, `/${created.id}/revisions`))).revisions as WorkspaceJson[];
    expect(beforeRollback).toHaveLength(20);
    expect(beforeRollback.map((workspace) => workspace.revision)).toEqual(Array.from({ length: 20 }, (_, index) => 26 - index));

    const rollbackResponse = await api(OWNER_A, `/${created.id}/rollback`, {
      method: "POST",
      body: { revision: 26, targetRevision: 7 }
    });
    expect(rollbackResponse.status).toBe(200);
    expect((await json(rollbackResponse)).workspace).toMatchObject({ revision: 27, name: "Revision 7", payload: { version: 7 } });

    const afterRollback = (await json(await api(OWNER_A, `/${created.id}/revisions`))).revisions as WorkspaceJson[];
    expect(afterRollback).toHaveLength(20);
    expect(afterRollback.map((workspace) => workspace.revision)).toEqual(Array.from({ length: 20 }, (_, index) => 27 - index));
    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM workspace_revisions WHERE workspace_id = $1",
      [created.id]
    );
    expect(count.rows[0]?.count).toBe("20");
  });

  it("returns 409 for duplicate client IDs on create and update while allowing different owners", async () => {
    const first = await createWorkspace(OWNER_A, "shared-client-id", "First", { slot: 1 });

    const duplicateCreate = await api(OWNER_A, "/", {
      method: "POST",
      body: workspaceInput("shared-client-id", "Duplicate", { slot: 2 })
    });
    expect(duplicateCreate.status).toBe(409);
    expect(await json(duplicateCreate)).toMatchObject({
      code: "workspace_conflict",
      current: { id: first.id, clientId: "shared-client-id", name: "First" }
    });

    const otherOwner = await createWorkspace(OWNER_B, "shared-client-id", "Other owner", { slot: "b" });
    expect(otherOwner.id).not.toBe(first.id);

    const second = await createWorkspace(OWNER_A, "second-client-id", "Second", { slot: 2 });
    const duplicateUpdate = await api(OWNER_A, `/${second.id}`, {
      method: "PUT",
      body: workspaceInput("shared-client-id", "Second renamed", { slot: 3 }, second.revision)
    });
    expect(duplicateUpdate.status).toBe(409);
    expect(await json(duplicateUpdate)).toMatchObject({
      code: "workspace_conflict",
      current: { id: first.id, clientId: "shared-client-id" }
    });
    expect((await json(await api(OWNER_A, `/${second.id}`))).workspace).toMatchObject({
      clientId: "second-client-id",
      name: "Second",
      revision: 1
    });
  });
});

function workspaceInput(
  clientId: string,
  name: string,
  payload: Record<string, unknown>,
  revision?: number
): Record<string, unknown> {
  return {
    clientId,
    name,
    schemaVersion: 1,
    payload,
    ...(revision === undefined ? {} : { revision })
  };
}

async function createWorkspace(
  owner: string,
  clientId: string,
  name: string,
  payload: Record<string, unknown>
): Promise<WorkspaceJson> {
  const response = await api(owner, "/", { method: "POST", body: workspaceInput(clientId, name, payload) });
  expect(response.status).toBe(201);
  return (await json(response)).workspace as WorkspaceJson;
}

async function api(
  owner: string,
  path: string,
  input: { method?: string; body?: unknown } = {}
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: input.method,
    headers: {
      "x-test-owner": owner,
      ...(input.body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) })
  });
}

async function json(response: Response): Promise<ApiJson> {
  return await response.json() as ApiJson;
}

async function startWorkspaceApi(database: Pool): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use((request, response, next) => {
    response.locals.authPrincipal = { user: { id: request.header("x-test-owner") } };
    next();
  });
  app.use("/api/workspaces", createWorkspaceRouter(database));
  app.use((_error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(500).json({ error: "Unexpected workspace error", code: "internal_error" });
  });
  const listening = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const port = (listening.address() as { port: number }).port;
  return { server: listening, baseUrl: `http://127.0.0.1:${port}/api/workspaces` };
}

function closeServer(instance: Server): Promise<void> {
  return new Promise((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
}
