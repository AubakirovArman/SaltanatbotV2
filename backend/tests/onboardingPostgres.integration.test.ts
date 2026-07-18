import express from "express";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it
} from "vitest";
import { migrateDatabase } from "../src/database/migrations.js";
import { DATABASE_MIGRATIONS } from "../src/database/schema.js";
import { createOnboardingRouter } from "../src/onboarding/routes.js";
import { assertIsolatedTestDatabase } from "./support/postgresTestDatabase.js";

const configuredConnection =
  process.env.ONBOARDING_TEST_DATABASE_URL ??
  process.env.WORKSPACES_TEST_DATABASE_URL;
const configuredVariable = process.env.ONBOARDING_TEST_DATABASE_URL
  ? "ONBOARDING_TEST_DATABASE_URL"
  : "WORKSPACES_TEST_DATABASE_URL";
const describePostgres = configuredConnection ? describe : describe.skip;
const OWNER_A = "00000000-0000-4000-8000-000000000041";
const OWNER_B = "00000000-0000-4000-8000-000000000042";
const PASSWORD_HASH = "integration-password-hash-placeholder";
let pool: Pool;
let server: Server;
let baseUrl: string;
let initialized = false;

interface OnboardingJson {
  schemaVersion: 1;
  revision: number;
  status: "not_started" | "in_progress" | "completed" | "dismissed";
  goal: "monitoring" | "price-alert" | "backtest" | "paper-robot" | null;
  goalSelectedAt: string | null;
  milestones: {
    chartReadyAt: string | null;
    priceAlertCreatedAt: string | null;
    backtestCompletedAt: string | null;
    paperBotCreatedAt: string | null;
  };
  completedAt: string | null;
  dismissedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface ApiJson {
  code?: string;
  onboarding?: OnboardingJson;
  current?: OnboardingJson;
}

describePostgres("onboarding against isolated PostgreSQL", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: configuredConnection, max: 8 });
    await assertIsolatedTestDatabase(pool, configuredVariable);
    await migrateDatabase(pool);
    await seedOwners();
    initialized = true;
    ({ server, baseUrl } = await startOnboardingApi(pool));
  });

  beforeEach(async () => {
    await seedOwners();
    await pool.query(
      "DELETE FROM user_onboarding WHERE owner_user_id = ANY($1::uuid[])",
      [[OWNER_A, OWNER_B]]
    );
    await pool.query(
      `UPDATE users
       SET status = 'active', authorization_revision = 1
       WHERE id = ANY($1::uuid[])`,
      [[OWNER_A, OWNER_B]]
    );
  });

  afterAll(async () => {
    if (server) await closeServer(server);
    if (pool) {
      if (initialized) {
        await pool.query(
          "DELETE FROM users WHERE id = ANY($1::uuid[])",
          [[OWNER_A, OWNER_B]]
        );
      }
      await pool.end();
    }
  });

  it("persists only the authenticated owner's lifecycle with optimistic revisions", async () => {
    const initial = await api(OWNER_A, "/");
    expect(initial.status).toBe(200);
    expect(await json(initial)).toEqual({
      onboarding: {
        schemaVersion: 1,
        revision: 0,
        status: "not_started",
        goal: null,
        goalSelectedAt: null,
        milestones: {
          chartReadyAt: null,
          priceAlertCreatedAt: null,
          backtestCompletedAt: null,
          paperBotCreatedAt: null
        },
        completedAt: null,
        dismissedAt: null,
        createdAt: null,
        updatedAt: null
      }
    });

    const selected = await api(OWNER_A, "/goal", {
      method: "PUT",
      body: { revision: 0, goal: "monitoring" }
    });
    expect(selected.status).toBe(200);
    expect((await json(selected)).onboarding).toMatchObject({
      revision: 1,
      status: "in_progress",
      goal: "monitoring"
    });

    expect((await json(await api(OWNER_B, "/"))).onboarding).toMatchObject({
      revision: 0,
      status: "not_started",
      goal: null
    });

    const completed = await api(OWNER_A, "/milestones", {
      method: "POST",
      body: { revision: 1, milestone: "chart-ready" }
    });
    expect(completed.status).toBe(200);
    const completedState = (await json(completed)).onboarding!;
    expect(completedState).toMatchObject({
      revision: 2,
      status: "completed",
      goal: "monitoring"
    });
    expect(completedState.milestones.chartReadyAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T/
    );
    expect(completedState.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const stale = await api(OWNER_A, "/goal", {
      method: "PUT",
      body: { revision: 1, goal: "backtest" }
    });
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({
      code: "onboarding_conflict",
      current: { revision: 2, goal: "monitoring", status: "completed" }
    });
    expect(stale.headers.get("Cache-Control")).toBe("no-store");

    const dismissed = await api(OWNER_A, "/dismiss", {
      method: "POST",
      body: { revision: 2 }
    });
    expect((await json(dismissed)).onboarding).toMatchObject({
      revision: 3,
      status: "dismissed",
      completedAt: null
    });

    const restarted = await api(OWNER_A, "/restart", {
      method: "POST",
      body: { revision: 3 }
    });
    expect((await json(restarted)).onboarding).toMatchObject({
      revision: 4,
      status: "not_started",
      goal: null,
      dismissedAt: null,
      completedAt: null,
      milestones: {
        chartReadyAt: null,
        priceAlertCreatedAt: null,
        backtestCompletedAt: null,
        paperBotCreatedAt: null
      }
    });
  });

  it("makes concurrent milestone retries idempotent without duplicate progress", async () => {
    const selected = await api(OWNER_A, "/goal", {
      method: "PUT",
      body: { revision: 0, goal: "price-alert" }
    });
    expect((await json(selected)).onboarding?.revision).toBe(1);

    const [first, second] = await Promise.all([
      api(OWNER_A, "/milestones", {
        method: "POST",
        body: { revision: 1, milestone: "price-alert-created" }
      }),
      api(OWNER_A, "/milestones", {
        method: "POST",
        body: { revision: 1, milestone: "price-alert-created" }
      })
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    for (const response of [first, second]) {
      expect(await json(response)).toMatchObject({
        onboarding: {
          revision: 2,
          status: "completed",
          goal: "price-alert"
        }
      });
    }

    const persisted = await pool.query<{
      revision: string;
      first_alert_at: Date | null;
    }>(
      `SELECT revision::text, first_alert_at
       FROM user_onboarding
       WHERE owner_user_id = $1`,
      [OWNER_A]
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]?.revision).toBe("2");
    expect(persisted.rows[0]?.first_alert_at).toBeInstanceOf(Date);
  });

  it("does not expose another owner through query parameters or administrator role", async () => {
    await api(OWNER_A, "/goal", {
      method: "PUT",
      body: { revision: 0, goal: "monitoring" }
    });
    await api(OWNER_B, "/goal", {
      method: "PUT",
      body: { revision: 0, goal: "backtest" }
    });

    const attemptedAdminRead = await api(
      OWNER_A,
      `/?userId=${encodeURIComponent(OWNER_B)}`,
      { appRole: "admin" }
    );
    expect(attemptedAdminRead.status).toBe(200);
    expect((await json(attemptedAdminRead)).onboarding).toMatchObject({
      goal: "monitoring"
    });
    expect(JSON.stringify(await json(await api(OWNER_A, "/")))).not.toMatch(
      /apiKey|credential|private|liveOrder/i
    );
  });

  it("fences a mutation that waited behind an authorization revision change", async () => {
    const selected = await api(OWNER_A, "/goal", {
      method: "PUT",
      body: { revision: 0, goal: "monitoring" }
    });
    expect((await json(selected)).onboarding?.revision).toBe(1);

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
      const pendingMutation = api(OWNER_A, "/milestones", {
        method: "POST",
        authorizationRevision: 1,
        body: { revision: 1, milestone: "chart-ready" }
      });
      await waitForBlockedOnboardingAuthority(pool);
      await admin.query("COMMIT");
      transactionOpen = false;

      const response = await pendingMutation;
      expect(response.status).toBe(409);
      expect(await json(response)).toMatchObject({
        code: "onboarding_authorization_changed"
      });
      const persisted = await pool.query<{
        revision: string;
        first_chart_at: Date | null;
      }>(
        `SELECT revision::text, first_chart_at
         FROM user_onboarding
         WHERE owner_user_id = $1`,
        [OWNER_A]
      );
      expect(persisted.rows[0]).toEqual({
        revision: "1",
        first_chart_at: null
      });

      await pool.query(
        `UPDATE users
         SET status = 'disabled', authorization_revision = 3
         WHERE id = $1`,
        [OWNER_A]
      );
      const disabled = await api(OWNER_A, "/milestones", {
        method: "POST",
        authorizationRevision: 3,
        body: { revision: 1, milestone: "chart-ready" }
      });
      expect(disabled.status).toBe(409);
      expect(await json(disabled)).toMatchObject({
        code: "onboarding_authorization_changed"
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

  it("cascades onboarding state when its owner is deleted", async () => {
    const ownerId = randomUUID();
    await pool.query(
      `INSERT INTO users (
         id, login, login_normalized, password_hash, status
       ) VALUES ($1, $2, $2, $3, 'active')`,
      [ownerId, `onboarding-cascade-${ownerId}`, PASSWORD_HASH]
    );
    await pool.query(
      `INSERT INTO user_onboarding (
         owner_user_id, goal, goal_selected_at
       ) VALUES ($1, 'monitoring', statement_timestamp())`,
      [ownerId]
    );
    await pool.query("DELETE FROM users WHERE id = $1", [ownerId]);
    const count = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM user_onboarding
       WHERE owner_user_id = $1`,
      [ownerId]
    );
    expect(count.rows[0]?.count).toBe("0");
  });

  it("upgrades v10 additively, suppresses existing users, and leaves future users first-run", async () => {
    const schemaName = `onboarding_legacy_v10_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE SCHEMA "${schemaName}" AUTHORIZATION CURRENT_USER`);
    const legacyPool = new Pool({
      connectionString: configuredConnection,
      max: 4,
      options: `-c search_path=${schemaName}`
    });
    try {
      await migrateDatabase(legacyPool, {
        migrations: DATABASE_MIGRATIONS.slice(0, 10)
      });
      const existingUserId = randomUUID();
      const futureUserId = randomUUID();
      await legacyPool.query(
        `INSERT INTO users (
           id, login, login_normalized, password_hash, status
         ) VALUES ($1, 'onboarding-existing-v10', 'onboarding-existing-v10', $2, 'active')`,
        [existingUserId, PASSWORD_HASH]
      );

      await expect(migrateDatabase(legacyPool)).resolves.toMatchObject({
        fromVersion: 10,
        toVersion: 17,
        applied: [
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
      const suppressed = await legacyPool.query<{
        revision: string;
        goal: string | null;
        dismissed_at: Date | null;
      }>(
        `SELECT revision::text, goal, dismissed_at
         FROM user_onboarding
         WHERE owner_user_id = $1`,
        [existingUserId]
      );
      expect(suppressed.rows[0]).toMatchObject({
        revision: "1",
        goal: null,
        dismissed_at: expect.any(Date)
      });

      await legacyPool.query(
        `INSERT INTO users (
           id, login, login_normalized, password_hash, status
         ) VALUES ($1, 'onboarding-future-v11', 'onboarding-future-v11', $2, 'active')`,
        [futureUserId, PASSWORD_HASH]
      );
      const futureRow = await legacyPool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM user_onboarding
         WHERE owner_user_id = $1`,
        [futureUserId]
      );
      expect(futureRow.rows[0]?.count).toBe("0");

      await legacyPool.query(
        `INSERT INTO runtime_component_heartbeats (
           component,
           generation_id,
           status,
           started_at,
           heartbeat_at,
           release_commit,
           database_schema_version
         ) VALUES (
           'research-worker',
           $1,
           'ready',
           statement_timestamp(),
           statement_timestamp(),
           'abcdef0',
           11
         )`,
        [randomUUID()]
      );
      await expect(
        legacyPool.query(
          `INSERT INTO runtime_component_heartbeats (
             component,
             generation_id,
             status,
             started_at,
             heartbeat_at,
             database_schema_version
           ) VALUES (
             'private-exchange-worker',
             $1,
             'ready',
             statement_timestamp(),
             statement_timestamp(),
             11
           )`,
          [randomUUID()]
        )
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        legacyPool.query(
          `UPDATE runtime_component_heartbeats
           SET release_commit = 'not-a-commit'
           WHERE component = 'research-worker'`
        )
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await legacyPool.end();
      await pool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    }
  });
});

interface ApiInput {
  method?: string;
  body?: unknown;
  expectedOwner?: string;
  authorizationRevision?: number;
  appRole?: "user" | "admin";
}

async function seedOwners(): Promise<void> {
  await pool.query(
    `INSERT INTO users (
       id,
       login,
       login_normalized,
       password_hash,
       status,
       authorization_revision
     ) VALUES
       ($1, 'onboarding-owner-a', 'onboarding-owner-a', $3, 'active', 1),
       ($2, 'onboarding-owner-b', 'onboarding-owner-b', $3, 'active', 1)
     ON CONFLICT (id) DO UPDATE SET
       status = 'active',
       authorization_revision = 1`,
    [OWNER_A, OWNER_B, PASSWORD_HASH]
  );
}

function api(
  owner: string,
  path: string,
  input: ApiInput = {}
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: input.method,
    headers: {
      "content-type": "application/json",
      "x-test-owner": owner,
      "x-test-authorization-revision": String(
        input.authorizationRevision ?? 1
      ),
      "x-test-app-role": input.appRole ?? "user",
      "x-sbv2-expected-user": input.expectedOwner ?? owner
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body)
  });
}

async function json(response: Response): Promise<ApiJson> {
  return (await response.json()) as ApiJson;
}

async function startOnboardingApi(
  database: Pool
): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use((request, response, next) => {
    response.locals.authMode = "database";
    response.locals.authPrincipal = {
      user: {
        id: request.header("x-test-owner"),
        appRole: request.header("x-test-app-role") ?? "user",
        authorizationRevision: Number(
          request.header("x-test-authorization-revision") ?? 1
        )
      }
    };
    next();
  });
  app.use("/api/onboarding", createOnboardingRouter(database));
  app.use(
    (
      _error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction
    ) => {
      response.status(500).json({ code: "internal_error" });
    }
  );
  const running = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const port = (running.address() as { port: number }).port;
  return {
    server: running,
    baseUrl: `http://127.0.0.1:${port}/api/onboarding`
  };
}

function closeServer(instance: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    instance.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitForBlockedOnboardingAuthority(
  database: Pool
): Promise<void> {
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
  throw new Error("Onboarding mutation did not reach the authorization row lock");
}
