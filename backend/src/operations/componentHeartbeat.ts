import type { Pool, PoolClient } from "pg";

export const RUNTIME_COMPONENTS = [
  "research-worker",
  "notification-worker"
] as const;
export const RUNTIME_COMPONENT_STATUSES = [
  "starting",
  "ready",
  "draining",
  "stopped",
  "failed"
] as const;
const RUNTIME_COMPONENT_ACTIVE_STATUSES = ["starting", "ready"] as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELEASE_COMMIT_PATTERN = /^[0-9a-f]{7,64}$/;

export type RuntimeComponent = (typeof RUNTIME_COMPONENTS)[number];
export type RuntimeComponentStatus =
  (typeof RUNTIME_COMPONENT_STATUSES)[number];

export interface RuntimeComponentHeartbeat {
  readonly component: RuntimeComponent;
  readonly generationId: string;
  readonly status: RuntimeComponentStatus;
  readonly startedAt: Date;
  readonly heartbeatAt: Date;
  readonly releaseCommit?: string;
  readonly databaseSchemaVersion: number;
}

export interface StartRuntimeComponentHeartbeat {
  readonly component: RuntimeComponent;
  readonly generationId: string;
  readonly status?: Extract<RuntimeComponentStatus, "starting" | "ready">;
  readonly releaseCommit?: string;
  readonly databaseSchemaVersion: number;
}

interface HeartbeatRow {
  component: unknown;
  generation_id: unknown;
  status: unknown;
  started_at: unknown;
  heartbeat_at: unknown;
  release_commit: unknown;
  database_schema_version: unknown;
}

type Queryable = Pick<Pool | PoolClient, "query">;

export class RuntimeComponentHeartbeatRepository {
  constructor(private readonly database: Queryable) {}

  async start(
    input: StartRuntimeComponentHeartbeat
  ): Promise<RuntimeComponentHeartbeat> {
    assertStartInput(input);
    const result = await this.database.query<HeartbeatRow>(
      `
        INSERT INTO runtime_component_heartbeats (
          component,
          generation_id,
          status,
          started_at,
          heartbeat_at,
          release_commit,
          database_schema_version
        )
        VALUES ($1, $2::uuid, $3, statement_timestamp(), statement_timestamp(), $4, $5)
        ON CONFLICT (component) DO UPDATE SET
          generation_id = EXCLUDED.generation_id,
          status = EXCLUDED.status,
          started_at = EXCLUDED.started_at,
          heartbeat_at = EXCLUDED.heartbeat_at,
          release_commit = EXCLUDED.release_commit,
          database_schema_version = EXCLUDED.database_schema_version
        RETURNING
          component,
          generation_id,
          status,
          started_at,
          heartbeat_at,
          release_commit,
          database_schema_version
      `,
      [
        input.component,
        input.generationId,
        input.status ?? "starting",
        input.releaseCommit ?? null,
        input.databaseSchemaVersion
      ]
    );
    if (result.rows.length !== 1) {
      throw new Error(
        `Runtime component heartbeat start returned ${result.rows.length} rows`
      );
    }
    return fromRow(result.rows[0]!);
  }

  async pulse(
    component: RuntimeComponent,
    generationId: string,
    status: Extract<RuntimeComponentStatus, "starting" | "ready"> = "ready"
  ): Promise<boolean> {
    assertComponent(component);
    assertGenerationId(generationId);
    assertStatus(status, RUNTIME_COMPONENT_ACTIVE_STATUSES);
    const result = await this.database.query(
      `
        UPDATE runtime_component_heartbeats
        SET status = $3, heartbeat_at = clock_timestamp()
        WHERE component = $1 AND generation_id = $2::uuid
      `,
      [component, generationId, status]
    );
    return updatedExactlyOne(result.rowCount, "pulse");
  }

  async mark(
    component: RuntimeComponent,
    generationId: string,
    status: RuntimeComponentStatus
  ): Promise<boolean> {
    assertComponent(component);
    assertGenerationId(generationId);
    assertStatus(status, RUNTIME_COMPONENT_STATUSES);
    const result = await this.database.query(
      `
        UPDATE runtime_component_heartbeats
        SET status = $3, heartbeat_at = clock_timestamp()
        WHERE component = $1 AND generation_id = $2::uuid
      `,
      [component, generationId, status]
    );
    return updatedExactlyOne(result.rowCount, "mark");
  }

  async get(
    component: RuntimeComponent
  ): Promise<RuntimeComponentHeartbeat | undefined> {
    assertComponent(component);
    const result = await this.database.query<HeartbeatRow>(
      `
        SELECT
          component,
          generation_id,
          status,
          started_at,
          heartbeat_at,
          release_commit,
          database_schema_version
        FROM runtime_component_heartbeats
        WHERE component = $1
      `,
      [component]
    );
    if (result.rows.length > 1) {
      throw new Error(
        `Runtime component heartbeat lookup returned ${result.rows.length} rows`
      );
    }
    const row = result.rows[0];
    return row ? fromRow(row) : undefined;
  }
}

function assertStartInput(input: StartRuntimeComponentHeartbeat): void {
  assertComponent(input.component);
  assertGenerationId(input.generationId);
  assertStatus(
    input.status ?? "starting",
    RUNTIME_COMPONENT_ACTIVE_STATUSES
  );
  assertDatabaseSchemaVersion(input.databaseSchemaVersion);
  if (
    input.releaseCommit !== undefined &&
    (typeof input.releaseCommit !== "string" ||
      !RELEASE_COMMIT_PATTERN.test(input.releaseCommit))
  ) {
    throw new Error(
      "Runtime component release commit must be lowercase hexadecimal"
    );
  }
}

function assertComponent(value: unknown): asserts value is RuntimeComponent {
  if (
    typeof value !== "string" ||
    !RUNTIME_COMPONENTS.includes(value as RuntimeComponent)
  ) {
    throw new Error("Unsupported runtime component");
  }
}

function assertGenerationId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("Runtime component generation ID must be a UUID");
  }
}

function assertStatus<T extends RuntimeComponentStatus>(
  value: unknown,
  allowed: readonly T[]
): asserts value is T {
  if (
    typeof value !== "string" ||
    !allowed.includes(value as T)
  ) {
    throw new Error("Unsupported runtime component status");
  }
}

function assertDatabaseSchemaVersion(value: unknown): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 1
  ) {
    throw new Error(
      "Runtime component database schema version must be a positive safe integer"
    );
  }
}

function fromRow(row: HeartbeatRow): RuntimeComponentHeartbeat {
  assertComponent(row.component);
  assertGenerationId(row.generation_id);
  assertStatus(row.status, RUNTIME_COMPONENT_STATUSES);
  assertDatabaseSchemaVersion(row.database_schema_version);
  const startedAt = validDate(row.started_at, "started_at");
  const heartbeatAt = validDate(row.heartbeat_at, "heartbeat_at");
  if (heartbeatAt.getTime() < startedAt.getTime()) {
    throw new Error(
      "Runtime component heartbeat timestamp precedes its start timestamp"
    );
  }
  if (
    row.release_commit !== null &&
    (typeof row.release_commit !== "string" ||
      !RELEASE_COMMIT_PATTERN.test(row.release_commit))
  ) {
    throw new Error("Invalid runtime component release commit row");
  }
  return {
    component: row.component,
    generationId: row.generation_id,
    status: row.status,
    startedAt,
    heartbeatAt,
    releaseCommit: row.release_commit ?? undefined,
    databaseSchemaVersion: row.database_schema_version
  };
}

function validDate(value: unknown, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`Invalid runtime component ${field} timestamp`);
  }
  return new Date(value);
}

function updatedExactlyOne(
  rowCount: number | null,
  operation: string
): boolean {
  if (rowCount === 0) return false;
  if (rowCount === 1) return true;
  throw new Error(
    `Runtime component heartbeat ${operation} affected ${String(rowCount)} rows`
  );
}
