import express from "express";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../src/database/migrations.js";
import { DATABASE_MIGRATIONS } from "../src/database/schema.js";
import { createWorkspaceRouter } from "../src/workspaces/routes.js";
import type { WorkspaceQuotaLimits } from "../src/workspaces/quotas.js";
import {
  WORKSPACE_DATABASE_PAYLOAD_BYTE_LIMIT,
  inspectWorkspaceJson
} from "../src/workspaces/workspaceLimits.js";
import { assertIsolatedTestDatabase } from "./support/postgresTestDatabase.js";

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
  status: "active" | "archived";
  archivedAt: string | null;
  updatedAt: string;
}

interface WorkspaceQuotaJson {
  activeCount: number;
  activeLimit: number;
  totalCount: number;
  totalLimit: number;
  payloadBytesUsed: number;
  payloadBytesLimit: number;
  maxDocumentBytes: number;
  maxRevisions: number;
}

interface ApiJson {
  [key: string]: unknown;
  workspace?: WorkspaceJson;
  workspaces?: WorkspaceJson[];
  revisions?: WorkspaceJson[];
  quota?: WorkspaceQuotaJson;
  attempted?: {
    activeCount?: number;
    totalCount?: number;
    payloadBytesUsed?: number;
    documentBytes?: number;
  };
  page?: {
    itemLimit: number;
    responseByteLimit: number;
    returnedItems: number;
    returnedPayloadBytes: number;
    responseBytes: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
}

interface ApiInput {
  method?: string;
  body?: unknown;
  expectedOwner?: string | null;
  authorizationRevision?: number;
}

describePostgres("workspaces against isolated PostgreSQL", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 8 });
    await assertIsolatedTestDatabase(pool, "WORKSPACES_TEST_DATABASE_URL");
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
    expect(await json(await api(OWNER_B, "/"))).toMatchObject({
      workspaces: [],
      quota: { activeCount: 0, totalCount: 0 }
    });
    expect(await json(await api(OWNER_B, `/${created.id}/revisions`))).toMatchObject({
      revisions: [],
      page: { returnedItems: 0, hasMore: false, nextCursor: null }
    });

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

  it("paginates workspace UUIDs without duplicates and reports the exact bounded response size", async () => {
    const limits: WorkspaceQuotaLimits = {
      maxActiveWorkspaces: 30,
      maxTotalWorkspaces: 30,
      maxRevisionsPerWorkspace: 20,
      maxDocumentBytes: 1_048_576,
      maxRetainedPayloadBytesPerOwner: 67_108_864
    };
    await withWorkspaceApi(pool, limits, async (url) => {
      const created: WorkspaceJson[] = [];
      for (let index = 0; index < 12; index += 1) {
        created.push(
          await createWorkspaceAt(
            url,
            OWNER_A,
            `page-${index}`,
            `Page ${index}`,
            { index }
          )
        );
      }
      const returned: WorkspaceJson[] = [];
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
        const response = await apiAt(
          url,
          OWNER_A,
          `/?status=all&limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
        );
        expect(response.status).toBe(200);
        const raw = await response.text();
        const body = JSON.parse(raw) as ApiJson;
        returned.push(...(body.workspaces ?? []));
        expect(body.page?.responseBytes).toBe(
          Buffer.byteLength(raw, "utf8")
        );
        expect(body.page?.responseBytes).toBeLessThanOrEqual(
          body.page?.responseByteLimit ?? 0
        );
        expect(body.quota).toMatchObject({ activeCount: 12, totalCount: 12 });
        if (!body.page?.hasMore) break;
        cursor = body.page.nextCursor ?? undefined;
      }
      expect(returned.map((workspace) => workspace.id)).toEqual(
        created.map((workspace) => workspace.id).sort()
      );
      expect(new Set(returned.map((workspace) => workspace.clientId)).size).toBe(
        12
      );
    });
  });

  it("upgrades existing v9 workspace rows additively and maintains exact payload-byte accounting", async () => {
    const schemaName = `workspace_legacy_v9_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE SCHEMA "${schemaName}" AUTHORIZATION CURRENT_USER`);
    const legacyPool = new Pool({
      connectionString,
      max: 4,
      options: `-c search_path=${schemaName}`
    });
    try {
      await migrateDatabase(legacyPool, {
        migrations: DATABASE_MIGRATIONS.slice(0, 9)
      });
      const ownerId = randomUUID();
      const workspaceId = randomUUID();
      await legacyPool.query(
        `INSERT INTO users (
           id, login, login_normalized, password_hash, status
         ) VALUES ($1, 'workspace-v9-owner', 'workspace-v9-owner', $2, 'active')`,
        [ownerId, "test-password-hash-placeholder"]
      );
      await legacyPool.query(
        `INSERT INTO workspaces (
           id, owner_user_id, client_id, name, schema_version, payload
         ) VALUES ($1,$2,'legacy-v9','Legacy v9',1,$3::jsonb)`,
        [workspaceId, ownerId, JSON.stringify({ legacy: true })]
      );
      await legacyPool.query(
        `INSERT INTO workspace_revisions (
           workspace_id, owner_user_id, revision, name, schema_version,
           payload, created_by_user_id
         ) VALUES ($1,$2,1,'Legacy v9',1,$3::jsonb,$2)`,
        [workspaceId, ownerId, JSON.stringify({ legacy: true })]
      );

      await expect(migrateDatabase(legacyPool)).resolves.toMatchObject({
        fromVersion: 9,
        toVersion: 17,
        applied: [
          { version: 10, name: "versioned_workspace_workflow" },
          {
            version: 11,
            name: "owner_onboarding_and_runtime_heartbeats"
          },
          {
            version: 12,
            name: "durable_executor_command_queue"
          },
          {
            version: 13,
            name: "durable_owner_alerts_and_notification_outbox"
          },
          {
            version: 14,
            name: "owner_screener_presets"
          },
          {
            version: 15,
            name: "telegram_notification_ingress"
          },
          {
            version: 16,
            name: "telegram_command_bridge"
          },
          {
            version: 17,
            name: "ga_evolution_lineage"
          }
        ]
      });
      const backfilled = await legacyPool.query<{
        payload_bytes: string;
        archived_at: Date | null;
        revision_payload_bytes: string;
      }>(
        `SELECT w.payload_bytes::text,
                w.archived_at,
                r.payload_bytes::text AS revision_payload_bytes
         FROM workspaces w
         JOIN workspace_revisions r ON r.workspace_id = w.id
         WHERE w.id = $1`,
        [workspaceId]
      );
      expect(Number(backfilled.rows[0]?.payload_bytes)).toBeGreaterThan(0);
      expect(Number(backfilled.rows[0]?.revision_payload_bytes)).toBeGreaterThan(0);
      expect(backfilled.rows[0]?.archived_at).toBeNull();

      await legacyPool.query(
        "UPDATE workspaces SET payload = $2::jsonb WHERE id = $1",
        [workspaceId, JSON.stringify({ legacy: true, expanded: "payload" })]
      );
      await legacyPool.query(
        `UPDATE workspace_revisions
         SET payload = $3::jsonb
         WHERE workspace_id = $1 AND revision = $2`,
        [
          workspaceId,
          1,
          JSON.stringify({ legacy: true, expanded: "revision-payload" })
        ]
      );
      const maintained = await legacyPool.query<{
        payload_bytes: string;
        expected_bytes: string;
        revision_payload_bytes: string;
        revision_expected_bytes: string;
      }>(
        `SELECT w.payload_bytes::text,
                octet_length(convert_to(w.payload::text, 'UTF8'))::text
                  AS expected_bytes,
                r.payload_bytes::text AS revision_payload_bytes,
                octet_length(convert_to(r.payload::text, 'UTF8'))::text
                  AS revision_expected_bytes
         FROM workspaces w
         JOIN workspace_revisions r ON r.workspace_id = w.id
         WHERE w.id = $1`,
        [workspaceId]
      );
      expect(maintained.rows[0]?.payload_bytes).toBe(
        maintained.rows[0]?.expected_bytes
      );
      expect(maintained.rows[0]?.revision_payload_bytes).toBe(
        maintained.rows[0]?.revision_expected_bytes
      );
      const indexes = await legacyPool.query<{ indexname: string }>(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = $1
           AND indexname IN (
             'workspaces_owner_archive_updated_index',
             'workspace_revisions_owner_workspace_recent_index'
           )
         ORDER BY indexname`,
        [schemaName]
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "workspace_revisions_owner_workspace_recent_index",
        "workspaces_owner_archive_updated_index"
      ]);
      const payloadBounds = await legacyPool.query<{ conname: string }>(
        `SELECT conname
         FROM pg_constraint
         WHERE connamespace = $1::regnamespace
           AND conname IN (
             'workspaces_payload_bytes_response_bound',
             'workspace_revisions_payload_bytes_response_bound'
           )
         ORDER BY conname`,
        [schemaName]
      );
      expect(payloadBounds.rows.map((row) => row.conname)).toEqual([
        "workspace_revisions_payload_bytes_response_bound",
        "workspaces_payload_bytes_response_bound"
      ]);
    } finally {
      await legacyPool.end();
      await pool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    }
  });

  it("keeps PostgreSQL jsonb text spacing and exponent expansion inside the proven byte bound", async () => {
    const spacing = await pool.query<{ rendered: string }>(
      `SELECT '{"a":1,"b":2}'::jsonb::text AS rendered`
    );
    expect(spacing.rows[0]?.rendered).toBe('{"a": 1, "b": 2}');

    const compact = JSON.stringify({ tiny: 5e-324, huge: 1.7976931348623157e308 });
    const expanded = await pool.query<{ rendered: string; bytes: string }>(
      `SELECT ($1::jsonb)::text AS rendered,
              octet_length(convert_to(($1::jsonb)::text, 'UTF8'))::text AS bytes`,
      [compact]
    );
    expect(expanded.rows[0]?.rendered).toContain(`0.${"0".repeat(323)}5`);
    expect(Number(expanded.rows[0]?.bytes)).toBeLessThanOrEqual(
      inspectWorkspaceJson({
        tiny: 5e-324,
        huge: 1.7976931348623157e308
      }).databaseBytesUpperBound
    );
  });

  it("fails the v10 preflight transactionally for an oversized legacy workspace", async () => {
    const schemaName = `workspace_oversized_v9_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE SCHEMA "${schemaName}" AUTHORIZATION CURRENT_USER`);
    const legacyPool = new Pool({
      connectionString,
      max: 4,
      options: `-c search_path=${schemaName}`
    });
    try {
      await migrateDatabase(legacyPool, {
        migrations: DATABASE_MIGRATIONS.slice(0, 9)
      });
      const ownerId = randomUUID();
      await legacyPool.query(
        `INSERT INTO users (
           id, login, login_normalized, password_hash, status
         ) VALUES ($1, 'oversized-v9-owner', 'oversized-v9-owner', $2, 'active')`,
        [ownerId, "test-password-hash-placeholder"]
      );
      await legacyPool.query(
        `INSERT INTO workspaces (
           id, owner_user_id, client_id, name, schema_version, payload
         ) VALUES ($1,$2,'oversized-v9','Oversized v9',1,$3::jsonb)`,
        [
          randomUUID(),
          ownerId,
          JSON.stringify({
            padding: "x".repeat(WORKSPACE_DATABASE_PAYLOAD_BYTE_LIMIT + 1)
          })
        ]
      );

      await expect(migrateDatabase(legacyPool)).rejects.toThrow(
        /schema v10 preflight failed/i
      );
      const version = await legacyPool.query<{ version: number }>(
        "SELECT max(version)::integer AS version FROM schema_migrations"
      );
      expect(version.rows[0]?.version).toBe(9);
      const v10Column = await legacyPool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = $1
             AND table_name = 'workspaces'
             AND column_name = 'archived_at'
         ) AS exists`,
        [schemaName]
      );
      expect(v10Column.rows[0]?.exists).toBe(false);
    } finally {
      await legacyPool.end();
      await pool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    }
  });

  it("rejects stale or missing expected-owner headers before reading or writing the cookie owner's workspaces", async () => {
    const created = await createWorkspace(OWNER_B, "owner-b-private", "Owner B private", { owner: "b" });

    const staleRead = await api(OWNER_B, "/", { expectedOwner: OWNER_A });
    expect(staleRead.status).toBe(409);
    expect(await json(staleRead)).toMatchObject({ code: "workspace_owner_mismatch" });

    const staleWrite = await api(OWNER_B, "/", {
      method: "POST",
      expectedOwner: OWNER_A,
      body: workspaceInput("stale-owner-a", "Must not be written", { owner: "a" })
    });
    expect(staleWrite.status).toBe(409);
    expect(await json(staleWrite)).toMatchObject({ code: "workspace_owner_mismatch" });

    const missingHeader = await api(OWNER_B, "/", { expectedOwner: null });
    expect(missingHeader.status).toBe(409);
    expect(await json(missingHeader)).toMatchObject({ code: "workspace_owner_mismatch" });

    expect(await json(await api(OWNER_B, "/"))).toMatchObject({
      workspaces: [{ id: created.id, clientId: "owner-b-private", payload: { owner: "b" } }]
    });
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

    const count = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM workspace_revisions WHERE workspace_id = $1", [created.id]);
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

    const beforeRollback = await allRevisions(OWNER_A, created.id);
    expect(beforeRollback).toHaveLength(20);
    expect(beforeRollback.map((workspace) => workspace.revision)).toEqual(Array.from({ length: 20 }, (_, index) => 26 - index));

    const rollbackResponse = await api(OWNER_A, `/${created.id}/rollback`, {
      method: "POST",
      body: { revision: 26, targetRevision: 7 }
    });
    expect(rollbackResponse.status).toBe(200);
    expect((await json(rollbackResponse)).workspace).toMatchObject({ revision: 27, name: "Revision 7", payload: { version: 7 } });

    const afterRollback = await allRevisions(OWNER_A, created.id);
    expect(afterRollback).toHaveLength(20);
    expect(afterRollback.map((workspace) => workspace.revision)).toEqual(Array.from({ length: 20 }, (_, index) => 27 - index));
    const count = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM workspace_revisions WHERE workspace_id = $1", [created.id]);
    expect(count.rows[0]?.count).toBe("20");
  });

  it("returns 409 for duplicate creates and keeps client IDs immutable on full update", async () => {
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
      current: { id: second.id, clientId: "second-client-id" }
    });
    expect((await json(await api(OWNER_A, `/${second.id}`))).workspace).toMatchObject({
      clientId: "second-client-id",
      name: "Second",
      revision: 1
    });
  });

  it("rejects cross-schema rollback deterministically without changing current state", async () => {
    const clientId = "cross-schema-rollback";
    const name = "Cross schema rollback";
    const createdResponse = await api(OWNER_A, "/", {
      method: "POST",
      body: {
        clientId,
        name,
        schemaVersion: 8,
        payload: versionedPayload(clientId, name, 4, [])
      }
    });
    const created = (await json(createdResponse)).workspace as WorkspaceJson;
    const downgradedResponse = await api(OWNER_A, `/${created.id}`, {
      method: "PUT",
      body: {
        clientId,
        name,
        schemaVersion: 1,
        payload: { schemaVersion: 1, id: clientId, name, state: "legacy" },
        revision: created.revision
      }
    });
    expect(downgradedResponse.status).toBe(200);
    const downgraded = (await json(downgradedResponse)).workspace as WorkspaceJson;
    expect(downgraded).toMatchObject({
      revision: 2,
      schemaVersion: 1,
      payload: { state: "legacy" }
    });

    const rollbackResponse = await api(OWNER_A, `/${created.id}/rollback`, {
      method: "POST",
      body: { revision: 2, targetRevision: 1 }
    });
    expect(rollbackResponse.status).toBe(400);
    expect(await json(rollbackResponse)).toMatchObject({
      code: "workspace_invalid_transition",
      currentMetadata: {
        id: created.id,
        revision: 2,
        schemaVersion: 1
      }
    });
    expect((await json(await api(OWNER_A, `/${created.id}`))).workspace).toMatchObject({
      revision: 2,
      schemaVersion: 1,
      payload: { state: "legacy" }
    });
    const revisions = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM workspace_revisions WHERE workspace_id = $1",
      [created.id]
    );
    expect(revisions.rows[0]?.count).toBe("2");
  });

  it("keeps wrapper and workflow revisions separate, archives through DELETE, and makes archived documents immutable until restore", async () => {
    const name = "Versioned workflow";
    const clientId = "versioned-workflow";
    const initialPayload = versionedPayload(clientId, name, 1, []);
    const createdResponse = await api(OWNER_A, "/", {
      method: "POST",
      body: {
        clientId,
        name,
        schemaVersion: 8,
        payload: initialPayload
      }
    });
    const created = (await json(createdResponse)).workspace as WorkspaceJson;

    const workflowPayload = versionedPayload(
      clientId,
      name,
      7,
      Array.from({ length: 6 }, (_, index) => index + 1)
    );
    const savedResponse = await api(OWNER_A, `/${created.id}`, {
      method: "PUT",
      body: {
        clientId,
        name,
        schemaVersion: 8,
        payload: workflowPayload,
        revision: created.revision
      }
    });
    expect(savedResponse.status).toBe(200);
    const saved = (await json(savedResponse)).workspace as WorkspaceJson;
    expect(saved.revision).toBe(2);
    expect(saved.payload).toEqual(workflowPayload);

    const archivedResponse = await api(OWNER_A, `/${created.id}?revision=2`, {
      method: "DELETE"
    });
    expect(archivedResponse.status).toBe(200);
    const archived = (await json(archivedResponse)).workspace as WorkspaceJson;
    expect(archived).toMatchObject({
      revision: 3,
      status: "archived",
      payload: workflowPayload
    });
    expect(archived.archivedAt).toEqual(expect.any(String));
    expect(await json(await api(OWNER_A, "/"))).toMatchObject({
      workspaces: [],
      quota: { activeCount: 0, totalCount: 1 }
    });
    expect(await json(await api(OWNER_A, "/?status=archived"))).toMatchObject({
      workspaces: [{ id: created.id, status: "archived" }]
    });
    expect(await json(await api(OWNER_A, "/?includeArchived=true"))).toMatchObject({
      workspaces: [{ id: created.id, status: "archived" }]
    });

    for (const response of [
      await api(OWNER_A, `/${created.id}`, {
        method: "PUT",
        body: {
          clientId,
          name,
          schemaVersion: 8,
          payload: workflowPayload,
          revision: 3
        }
      }),
      await api(OWNER_A, `/${created.id}/name`, {
        method: "PATCH",
        body: { revision: 3, name: "Cannot rename archived" }
      }),
      await api(OWNER_A, `/${created.id}/rollback`, {
        method: "POST",
        body: { revision: 3, targetRevision: 1 }
      })
    ]) {
      expect(response.status).toBe(409);
      expect(await json(response)).toMatchObject({
        code: "workspace_archived",
        currentMetadata: { id: created.id, revision: 3, status: "archived" }
      });
    }

    const duplicateResponse = await api(OWNER_A, `/${created.id}/duplicate`, {
      method: "POST",
      body: {
        revision: 3,
        clientId: "archived-copy",
        name: "Archived copy"
      }
    });
    expect(duplicateResponse.status).toBe(201);
    expect((await json(duplicateResponse)).workspace).toMatchObject({
      clientId: "archived-copy",
      name: "Archived copy",
      status: "active",
      revision: 1,
      payload: { id: "archived-copy", name: "Archived copy", revision: 1, history: [] }
    });

    const restoredResponse = await api(OWNER_A, `/${created.id}/restore`, {
      method: "POST",
      body: { revision: 3 }
    });
    expect(restoredResponse.status).toBe(200);
    expect((await json(restoredResponse)).workspace).toMatchObject({
      revision: 4,
      status: "active",
      archivedAt: null,
      payload: workflowPayload
    });

    const stored = await pool.query<{
      deleted_at: Date | null;
      archived_at: Date | null;
    }>(
      "SELECT deleted_at, archived_at FROM workspaces WHERE owner_user_id = $1 AND id = $2",
      [OWNER_A, created.id]
    );
    expect(stored.rows[0]).toEqual({ deleted_at: null, archived_at: null });
  });

  it("renames coherently and verifies owner-scoped checksum export/import", async () => {
    const clientId = "export-source";
    const initialName = "Export source";
    const createdResponse = await api(OWNER_A, "/", {
      method: "POST",
      body: {
        clientId,
        name: initialName,
        schemaVersion: 8,
        payload: versionedPayload(clientId, initialName, 4, [1, 2, 3])
      }
    });
    const created = (await json(createdResponse)).workspace as WorkspaceJson;
    const renamedResponse = await api(OWNER_A, `/${created.id}/name`, {
      method: "PATCH",
      body: { revision: 1, name: "Renamed export" }
    });
    expect(renamedResponse.status).toBe(200);
    const renamed = (await json(renamedResponse)).workspace as WorkspaceJson;
    expect(renamed).toMatchObject({
      name: "Renamed export",
      revision: 2,
      payload: { name: "Renamed export", revision: 5 }
    });

    const exportResponse = await api(OWNER_A, `/${created.id}/export`);
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get("content-disposition")).toContain(
      "renamed-export.saltanat-workspace.json"
    );
    const document = (await exportResponse.json()) as Record<string, unknown>;
    expect(document).toMatchObject({
      format: "saltanatbotv2.workspace",
      version: 1,
      algorithm: "SHA-256",
      checksum: expect.stringMatching(/^[0-9a-f]{64}$/)
    });

    expect((await api(OWNER_B, `/${created.id}/export`)).status).toBe(404);
    const importedResponse = await api(OWNER_A, "/import", {
      method: "POST",
      body: {
        document,
        clientId: "imported-workflow",
        name: "Imported workflow"
      }
    });
    expect(importedResponse.status).toBe(201);
    expect((await json(importedResponse)).workspace).toMatchObject({
      clientId: "imported-workflow",
      name: "Imported workflow",
      schemaVersion: 8,
      payload: {
        id: "imported-workflow",
        name: "Imported workflow",
        revision: 5
      }
    });

    const tampered = structuredClone(document) as {
      workspace: Record<string, unknown>;
    };
    tampered.workspace.symbol = "ETHUSDT";
    const tamperedResponse = await api(OWNER_A, "/import", {
      method: "POST",
      body: tampered
    });
    expect(tamperedResponse.status).toBe(400);
    expect(await json(tamperedResponse)).toMatchObject({
      code: "workspace_checksum_mismatch"
    });
  });

  it("keeps v8 content lineage monotonic across server rollback and rename while wrapper revisions diverge", async () => {
    const clientId = "cross-device-lineage";
    const name = "Cross-device lineage";
    const createdResponse = await api(OWNER_A, "/", {
      method: "POST",
      body: {
        clientId,
        name,
        schemaVersion: 8,
        payload: versionedPayload(clientId, name, 12, [])
      }
    });
    const created = (await json(createdResponse)).workspace as WorkspaceJson;
    expect(created).toMatchObject({
      revision: 1,
      payload: { revision: 12, theme: "dark" }
    });

    const remotePayload = {
      ...versionedPayload(clientId, name, 40, []),
      theme: "light"
    };
    const savedResponse = await api(OWNER_A, `/${created.id}`, {
      method: "PUT",
      body: {
        clientId,
        name,
        schemaVersion: 8,
        payload: remotePayload,
        revision: 1
      }
    });
    expect(savedResponse.status).toBe(200);
    const saved = (await json(savedResponse)).workspace as WorkspaceJson;
    expect(saved).toMatchObject({
      revision: 2,
      payload: { revision: 40, theme: "light" }
    });

    const beforeRollback = Date.now();
    const rollbackResponse = await api(OWNER_A, `/${created.id}/rollback`, {
      method: "POST",
      body: { revision: 2, targetRevision: 1 }
    });
    expect(rollbackResponse.status).toBe(200);
    const rolledBack = (await json(rollbackResponse)).workspace as WorkspaceJson;
    expect(rolledBack).toMatchObject({
      revision: 3,
      payload: { revision: 41, theme: "dark" }
    });
    expect(rolledBack.payload.savedAt).toBe(rolledBack.payload.updatedAt);
    expect(Number(rolledBack.payload.savedAt)).toBeGreaterThanOrEqual(
      beforeRollback
    );
    expect(rolledBack.revision).not.toBe(rolledBack.payload.revision);

    const renamedResponse = await api(OWNER_A, `/${created.id}/name`, {
      method: "PATCH",
      body: { revision: 3, name: "Renamed after rollback" }
    });
    expect(renamedResponse.status).toBe(200);
    const renamed = (await json(renamedResponse)).workspace as WorkspaceJson;
    expect(renamed).toMatchObject({
      revision: 4,
      name: "Renamed after rollback",
      payload: {
        revision: 42,
        name: "Renamed after rollback",
        theme: "dark"
      }
    });
    expect(renamed.payload.savedAt).toBe(renamed.payload.updatedAt);
    expect(Number(renamed.payload.savedAt)).toBeGreaterThanOrEqual(
      Number(rolledBack.payload.savedAt)
    );
    expect(renamed.revision).not.toBe(renamed.payload.revision);
  });

  it("preserves legacy content revision fields during server rollback and rename", async () => {
    const clientId = "legacy-lineage";
    const name = "Legacy lineage";
    const legacyPayload = {
      schemaVersion: 1,
      id: clientId,
      name,
      revision: 50,
      savedAt: 100,
      updatedAt: 100,
      state: "initial"
    };
    const createdResponse = await api(OWNER_A, "/", {
      method: "POST",
      body: {
        clientId,
        name,
        schemaVersion: 1,
        payload: legacyPayload
      }
    });
    const created = (await json(createdResponse)).workspace as WorkspaceJson;
    const savedResponse = await api(OWNER_A, `/${created.id}`, {
      method: "PUT",
      body: {
        clientId,
        name,
        schemaVersion: 1,
        payload: {
          ...legacyPayload,
          revision: 60,
          savedAt: 200,
          updatedAt: 200,
          state: "changed"
        },
        revision: 1
      }
    });
    expect(savedResponse.status).toBe(200);

    const rollbackResponse = await api(OWNER_A, `/${created.id}/rollback`, {
      method: "POST",
      body: { revision: 2, targetRevision: 1 }
    });
    const rolledBack = (await json(rollbackResponse)).workspace as WorkspaceJson;
    expect(rolledBack).toMatchObject({
      revision: 3,
      payload: {
        revision: 50,
        savedAt: 100,
        updatedAt: 100,
        state: "initial"
      }
    });

    const renamedResponse = await api(OWNER_A, `/${created.id}/name`, {
      method: "PATCH",
      body: { revision: 3, name: "Renamed legacy" }
    });
    expect((await json(renamedResponse)).workspace).toMatchObject({
      revision: 4,
      payload: {
        name: "Renamed legacy",
        revision: 50,
        savedAt: 100,
        updatedAt: 100
      }
    });
  });

  it("enforces active/total quotas atomically and serializes concurrent creates", async () => {
    const limits: WorkspaceQuotaLimits = {
      maxActiveWorkspaces: 2,
      maxTotalWorkspaces: 3,
      maxRevisionsPerWorkspace: 3,
      maxDocumentBytes: 2_048,
      maxRetainedPayloadBytesPerOwner: 65_536
    };
    await withWorkspaceApi(pool, limits, async (url) => {
      const first = await createWorkspaceAt(url, OWNER_A, "quota-first", "First", {
        slot: 1
      });
      const second = await createWorkspaceAt(url, OWNER_A, "quota-second", "Second", {
        slot: 2
      });
      const activeRejected = await apiAt(url, OWNER_A, "/", {
        method: "POST",
        body: workspaceInput("quota-third", "Third", { slot: 3 })
      });
      expect(activeRejected.status).toBe(429);
      expect(await json(activeRejected)).toMatchObject({
        code: "workspace_active_quota_exceeded",
        quota: { activeCount: 2, activeLimit: 2, totalCount: 2 },
        attempted: { activeCount: 3, totalCount: 3 }
      });

      expect(
        (
          await apiAt(url, OWNER_A, `/${first.id}?revision=${first.revision}`, {
            method: "DELETE"
          })
        ).status
      ).toBe(200);
      const third = await createWorkspaceAt(url, OWNER_A, "quota-third", "Third", {
        slot: 3
      });
      expect(
        (
          await apiAt(url, OWNER_A, `/${second.id}?revision=${second.revision}`, {
            method: "DELETE"
          })
        ).status
      ).toBe(200);

      const totalRejected = await apiAt(url, OWNER_A, "/", {
        method: "POST",
        body: workspaceInput("quota-fourth", "Fourth", { slot: 4 })
      });
      expect(totalRejected.status).toBe(429);
      expect(await json(totalRejected)).toMatchObject({
        code: "workspace_total_quota_exceeded",
        quota: { activeCount: 1, totalCount: 3, totalLimit: 3 },
        attempted: { activeCount: 2, totalCount: 4 }
      });
      const restoreFirst = await apiAt(url, OWNER_A, `/${first.id}/restore`, {
        method: "POST",
        body: { revision: 2 }
      });
      expect(restoreFirst.status).toBe(200);
      const restoreSecond = await apiAt(url, OWNER_A, `/${second.id}/restore`, {
        method: "POST",
        body: { revision: 2 }
      });
      expect(restoreSecond.status).toBe(429);
      expect(await json(restoreSecond)).toMatchObject({
        code: "workspace_active_quota_exceeded",
        quota: { activeCount: 2, totalCount: 3 },
        attempted: { activeCount: 3, totalCount: 3 }
      });
      expect((await json(await apiAt(url, OWNER_A, "/?status=archived"))).workspaces).toMatchObject([
        { id: second.id, revision: 2, status: "archived" }
      ]);
      expect(
        (
          await apiAt(
            url,
            OWNER_B,
            `/${second.id}/permanent?revision=2`,
            { method: "DELETE" }
          )
        ).status
      ).toBe(404);
      const activePurge = await apiAt(
        url,
        OWNER_A,
        `/${third.id}/permanent?revision=1`,
        { method: "DELETE" }
      );
      expect(activePurge.status).toBe(409);
      expect(await json(activePurge)).toMatchObject({
        code: "workspace_not_archived",
        currentMetadata: { id: third.id, status: "active" }
      });
      const purgeSecond = await apiAt(
        url,
        OWNER_A,
        `/${second.id}/permanent?revision=2`,
        { method: "DELETE" }
      );
      expect(purgeSecond.status).toBe(200);
      expect(await json(purgeSecond)).toMatchObject({
        ok: true,
        purged: { id: second.id, clientId: second.clientId, name: second.name },
        quota: { activeCount: 2, totalCount: 2 }
      });
      const archiveFirstAgain = await apiAt(
        url,
        OWNER_A,
        `/${first.id}?revision=3`,
        { method: "DELETE" }
      );
      expect(archiveFirstAgain.status).toBe(200);
      expect(
        (
          await apiAt(url, OWNER_A, "/", {
            method: "POST",
            body: workspaceInput("quota-fourth", "Fourth", { slot: 4 })
          })
        ).status
      ).toBe(201);

      for (let revision = 1; revision <= 5; revision += 1) {
        const current = (
          await json(await apiAt(url, OWNER_A, `/${third.id}`))
        ).workspace as WorkspaceJson;
        const updated = await apiAt(url, OWNER_A, `/${third.id}`, {
          method: "PUT",
          body: workspaceInput(
            third.clientId,
            third.name,
            { slot: 3, contentRevision: revision },
            current.revision
          )
        });
        expect(updated.status).toBe(200);
      }
      const retained = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM workspace_revisions WHERE workspace_id = $1",
        [third.id]
      );
      expect(retained.rows[0]?.count).toBe("3");
    });

    await pool.query("TRUNCATE workspace_revisions, workspaces");
    await withWorkspaceApi(
      pool,
      { ...limits, maxActiveWorkspaces: 1, maxTotalWorkspaces: 10 },
      async (url) => {
        const outcomes = await Promise.all([
          apiAt(url, OWNER_A, "/", {
            method: "POST",
            body: workspaceInput("concurrent-a", "Concurrent A", { slot: "a" })
          }),
          apiAt(url, OWNER_A, "/", {
            method: "POST",
            body: workspaceInput("concurrent-b", "Concurrent B", { slot: "b" })
          })
        ]);
        expect(outcomes.map((response) => response.status).sort()).toEqual([
          201, 429
        ]);
        const rejected = outcomes.find((response) => response.status === 429);
        expect(rejected).toBeDefined();
        expect(await json(rejected!)).toMatchObject({
          code: "workspace_active_quota_exceeded",
          quota: { activeCount: 1, totalCount: 1 },
          attempted: { activeCount: 2, totalCount: 2 }
        });
        const count = await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM workspaces WHERE owner_user_id = $1 AND deleted_at IS NULL",
          [OWNER_A]
        );
        expect(count.rows[0]?.count).toBe("1");
      }
    );
  });

  it("rejects oversized and retained-storage over-limit writes without partial rows or revisions", async () => {
    const limits: WorkspaceQuotaLimits = {
      maxActiveWorkspaces: 10,
      maxTotalWorkspaces: 10,
      maxRevisionsPerWorkspace: 3,
      maxDocumentBytes: 1_024,
      maxRetainedPayloadBytesPerOwner: 2_200
    };
    await withWorkspaceApi(pool, limits, async (url) => {
      const first = await createWorkspaceAt(url, OWNER_A, "storage-first", "First", {
        padding: "x".repeat(700)
      });
      const storageRejected = await apiAt(url, OWNER_A, "/", {
        method: "POST",
        body: workspaceInput("storage-second", "Second", {
          padding: "y".repeat(700)
        })
      });
      expect(storageRejected.status).toBe(429);
      const storageError = await json(storageRejected);
      expect(storageError).toMatchObject({
        code: "workspace_storage_quota_exceeded",
        quota: { activeCount: 1, totalCount: 1 },
        attempted: { activeCount: 2, totalCount: 2 }
      });
      expect(storageError.quota?.payloadBytesUsed).toBeLessThanOrEqual(
        limits.maxRetainedPayloadBytesPerOwner
      );
      expect(storageError.attempted?.payloadBytesUsed).toBeGreaterThan(
        limits.maxRetainedPayloadBytesPerOwner
      );
      const oversized = await apiAt(url, OWNER_A, "/", {
        method: "POST",
        body: workspaceInput("oversized", "Oversized", {
          padding: "z".repeat(1_100)
        })
      });
      expect(oversized.status).toBe(413);
      expect(await json(oversized)).toMatchObject({
        code: "workspace_document_too_large",
        quota: { activeCount: 1, totalCount: 1 },
        attempted: { documentBytes: expect.any(Number) }
      });

      const rows = await pool.query<{ id: string }>(
        "SELECT id::text FROM workspaces WHERE owner_user_id = $1 AND deleted_at IS NULL",
        [OWNER_A]
      );
      expect(rows.rows).toEqual([{ id: first.id }]);
      const revisions = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM workspace_revisions WHERE owner_user_id = $1",
        [OWNER_A]
      );
      expect(revisions.rows[0]?.count).toBe("1");

      const archived = await apiAt(
        url,
        OWNER_A,
        `/${first.id}?revision=${first.revision}`,
        { method: "DELETE" }
      );
      expect(archived.status).toBe(200);
      const purged = await apiAt(
        url,
        OWNER_A,
        `/${first.id}/permanent?revision=2`,
        { method: "DELETE" }
      );
      expect(purged.status).toBe(200);
      expect(await json(purged)).toMatchObject({
        ok: true,
        quota: { activeCount: 0, totalCount: 0, payloadBytesUsed: 0 }
      });
      expect(
        (
          await apiAt(url, OWNER_A, "/", {
            method: "POST",
            body: workspaceInput("storage-second", "Second", {
              padding: "y".repeat(700)
            })
          })
        ).status
      ).toBe(201);
    });
  });

  it("always permits archive and archived purge after limits are lowered below retained usage", async () => {
    const first = await createWorkspace(
      OWNER_A,
      "lowered-limit-first",
      "First",
      { padding: "x".repeat(256) }
    );
    const second = await createWorkspace(
      OWNER_A,
      "lowered-limit-second",
      "Second",
      { padding: "y".repeat(256) }
    );
    const lowered: WorkspaceQuotaLimits = {
      maxActiveWorkspaces: 1,
      maxTotalWorkspaces: 1,
      maxRevisionsPerWorkspace: 2,
      maxDocumentBytes: 1_024,
      maxRetainedPayloadBytesPerOwner: 1
    };

    await withWorkspaceApi(pool, lowered, async (url) => {
      const archived = await apiAt(
        url,
        OWNER_A,
        `/${first.id}?revision=1`,
        { method: "DELETE" }
      );
      expect(archived.status).toBe(200);
      expect(await json(archived)).toMatchObject({
        workspace: { id: first.id, status: "archived", revision: 2 },
        quota: {
          activeCount: 1,
          activeLimit: 1,
          totalCount: 2,
          totalLimit: 1,
          payloadBytesLimit: 1
        }
      });
      const purged = await apiAt(
        url,
        OWNER_A,
        `/${first.id}/permanent?revision=2`,
        { method: "DELETE" }
      );
      expect(purged.status).toBe(200);
      expect(await json(purged)).toMatchObject({
        ok: true,
        purged: { id: first.id },
        quota: { activeCount: 1, totalCount: 1 }
      });

      expect(
        (
          await apiAt(url, OWNER_A, `/${second.id}?revision=1`, {
            method: "DELETE"
          })
        ).status
      ).toBe(200);
      const finalPurge = await apiAt(
        url,
        OWNER_A,
        `/${second.id}/permanent?revision=2`,
        { method: "DELETE" }
      );
      expect(finalPurge.status).toBe(200);
      expect(await json(finalPurge)).toMatchObject({
        quota: { activeCount: 0, totalCount: 0, payloadBytesUsed: 0 }
      });
    });
  });

  it("fences a workspace mutation that waited behind a concurrent authorization revision change", async () => {
    const admin = await pool.connect();
    let transactionOpen = false;
    try {
      await admin.query("BEGIN");
      transactionOpen = true;
      await admin.query(
        `UPDATE users
         SET authorization_revision = authorization_revision + 1
         WHERE id = $1`,
        [OWNER_A]
      );
      const pendingMutation = api(OWNER_A, "/", {
        method: "POST",
        authorizationRevision: 1,
        body: workspaceInput("stale-authority", "Must not commit", {
          forbidden: true
        })
      });
      await waitForBlockedWorkspaceAuthority(pool);
      await admin.query("COMMIT");
      transactionOpen = false;

      const response = await pendingMutation;
      expect(response.status).toBe(409);
      expect(await json(response)).toEqual({
        error: "Workspace authorization changed. Reload before retrying.",
        code: "workspace_authorization_changed"
      });
      const count = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM workspaces
         WHERE owner_user_id = $1 AND client_id = 'stale-authority'`,
        [OWNER_A]
      );
      expect(count.rows[0]?.count).toBe("0");

      await pool.query(
        `UPDATE users
         SET status = 'disabled', authorization_revision = 3
         WHERE id = $1`,
        [OWNER_A]
      );
      const disabled = await api(OWNER_A, "/", {
        method: "POST",
        authorizationRevision: 3,
        body: workspaceInput("disabled-authority", "Must not commit", {
          forbidden: true
        })
      });
      expect(disabled.status).toBe(409);
      expect(await json(disabled)).toMatchObject({
        code: "workspace_authorization_changed"
      });
    } finally {
      if (transactionOpen) await admin.query("ROLLBACK");
      admin.release();
      await pool.query(
        `UPDATE users
         SET status = 'active', authorization_revision = 1
         WHERE id = $1`,
        [OWNER_A]
      );
    }
  });
});

function workspaceInput(clientId: string, name: string, payload: Record<string, unknown>, revision?: number): Record<string, unknown> {
  return {
    clientId,
    name,
    schemaVersion: 1,
    payload,
    ...(revision === undefined ? {} : { revision })
  };
}

async function createWorkspace(owner: string, clientId: string, name: string, payload: Record<string, unknown>): Promise<WorkspaceJson> {
  return createWorkspaceAt(baseUrl, owner, clientId, name, payload);
}

async function createWorkspaceAt(
  url: string,
  owner: string,
  clientId: string,
  name: string,
  payload: Record<string, unknown>
): Promise<WorkspaceJson> {
  const response = await apiAt(url, owner, "/", {
    method: "POST",
    body: workspaceInput(clientId, name, payload)
  });
  expect(response.status).toBe(201);
  return (await json(response)).workspace as WorkspaceJson;
}

async function api(
  owner: string,
  path: string,
  input: ApiInput = {}
): Promise<Response> {
  return apiAt(baseUrl, owner, path, input);
}

async function apiAt(
  url: string,
  owner: string,
  path: string,
  input: ApiInput = {}
): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: input.method,
    headers: {
      "x-test-owner": owner,
      "x-test-authorization-revision": String(
        input.authorizationRevision ?? 1
      ),
      ...(input.expectedOwner === null ? {} : { "x-sbv2-expected-user": input.expectedOwner ?? owner }),
      ...(input.body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) })
  });
}

async function json(response: Response): Promise<ApiJson> {
  return (await response.json()) as ApiJson;
}

async function allRevisions(
  owner: string,
  workspaceId: string
): Promise<WorkspaceJson[]> {
  const revisions: WorkspaceJson[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 32; pageNumber += 1) {
    const response = await api(
      owner,
      `/${workspaceId}/revisions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`
    );
    expect(response.status).toBe(200);
    const body = await json(response);
    revisions.push(...(body.revisions ?? []));
    expect(body.page?.responseBytes).toBeLessThanOrEqual(
      body.page?.responseByteLimit ?? 0
    );
    if (!body.page?.hasMore) return revisions;
    expect(body.page.nextCursor).toBeTruthy();
    cursor = body.page.nextCursor ?? undefined;
  }
  throw new Error("Revision pagination did not terminate");
}

async function startWorkspaceApi(
  database: Pool,
  limits?: WorkspaceQuotaLimits
): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use((request, response, next) => {
    response.locals.authPrincipal = {
      user: {
        id: request.header("x-test-owner"),
        authorizationRevision: Number(
          request.header("x-test-authorization-revision") ?? 1
        )
      }
    };
    response.locals.authMode = "database";
    next();
  });
  app.use("/api/workspaces", createWorkspaceRouter(database, { limits }));
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
  return new Promise((resolve, reject) => instance.close((error) => (error ? reject(error) : resolve())));
}

async function withWorkspaceApi(
  database: Pool,
  limits: WorkspaceQuotaLimits,
  operation: (url: string) => Promise<void>
): Promise<void> {
  const temporary = await startWorkspaceApi(database, limits);
  try {
    await operation(temporary.baseUrl);
  } finally {
    await closeServer(temporary.server);
  }
}

function versionedPayload(
  id: string,
  name: string,
  revision: number,
  history: number[]
): Record<string, unknown> {
  const snapshot = (snapshotRevision: number) => ({
    revision: snapshotRevision,
    savedAt: 1_752_640_000_000 + snapshotRevision,
    mode: "chart",
    symbol: "BTCUSDT",
    timeframe: "1m",
    chartType: "candles",
    cryptoExchange: "binance",
    enabledIndicators: [],
    indicators: [],
    compareOverlays: [],
    theme: "dark",
    layout: {
      preset: "single",
      leftOpen: true,
      rightOpen: true,
      leftSize: 260,
      rightSize: 280,
      panelsSwapped: false
    },
    charts: [
      {
        id: "chart-1",
        symbol: "BTCUSDT",
        timeframe: "1m",
        chartType: "candles",
        timeZone: "exchange",
        linkChartType: true,
        linkGroup: "primary",
        linkSymbol: true,
        linkTimeframe: true,
        linkCrosshair: true,
        linkTimeRange: true,
        linkIndicators: true,
        linkCompare: true
      }
    ],
    activeChartId: "chart-1",
    drawings: [{ chartId: "chart-1", symbol: "BTCUSDT", drawings: [] }]
  });
  return {
    schemaVersion: 8,
    id,
    name,
    createdAt: 1_752_640_000_000,
    updatedAt: 1_752_640_000_000 + revision,
    history: history.map(snapshot),
    ...snapshot(revision)
  };
}

async function waitForBlockedWorkspaceAuthority(database: Pool): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const blocked = await database.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'
           AND query LIKE '%authorization_revision::text%'
       ) AS blocked`
    );
    if (blocked.rows[0]?.blocked) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Workspace mutation did not reach the authorization row lock");
}
