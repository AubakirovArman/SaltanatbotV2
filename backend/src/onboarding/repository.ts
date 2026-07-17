import type { Pool, PoolClient } from "pg";
import type { UserOnboardingDatabaseRow } from "../database/types.js";
import {
  OnboardingAuthorizationChangedError,
  OnboardingConflictError
} from "./errors.js";
import {
  emptyOnboardingState,
  type OnboardingGoal,
  type OnboardingMilestone,
  type OnboardingState
} from "./types.js";

const onboardingColumns = `
  owner_user_id,
  schema_version,
  revision::text,
  goal,
  goal_selected_at,
  first_chart_at,
  first_alert_at,
  first_backtest_at,
  first_paper_robot_at,
  completed_at,
  dismissed_at,
  created_at,
  updated_at
`;

export interface OnboardingRepositoryContract {
  get(ownerUserId: string): Promise<OnboardingState>;
  selectGoal(
    ownerUserId: string,
    expectedRevision: number,
    goal: OnboardingGoal,
    authorizationRevision: number
  ): Promise<OnboardingState>;
  recordMilestone(
    ownerUserId: string,
    expectedRevision: number,
    milestone: OnboardingMilestone,
    authorizationRevision: number
  ): Promise<OnboardingState>;
  dismiss(
    ownerUserId: string,
    expectedRevision: number,
    authorizationRevision: number
  ): Promise<OnboardingState>;
  restart(
    ownerUserId: string,
    expectedRevision: number,
    authorizationRevision: number
  ): Promise<OnboardingState>;
}

export class OnboardingRepository implements OnboardingRepositoryContract {
  constructor(private readonly pool: Pool) {}

  async get(ownerUserId: string): Promise<OnboardingState> {
    const result = await this.pool.query<UserOnboardingDatabaseRow>(
      `SELECT ${onboardingColumns}
       FROM user_onboarding
       WHERE owner_user_id = $1`,
      [ownerUserId]
    );
    return result.rows[0]
      ? mapOnboardingState(result.rows[0])
      : emptyOnboardingState();
  }

  async selectGoal(
    ownerUserId: string,
    expectedRevision: number,
    goal: OnboardingGoal,
    authorizationRevision: number
  ): Promise<OnboardingState> {
    return this.ownerMutation(
      ownerUserId,
      authorizationRevision,
      async (client) => {
        const row = await readForUpdate(client, ownerUserId);
        const current = stateFromRow(row);
        if (
          current.goal === goal &&
          current.dismissedAt === null &&
          current.goalSelectedAt !== null
        ) {
          return current;
        }
        assertExpectedRevision(current, expectedRevision);

        if (!row) {
          const inserted = await client.query<UserOnboardingDatabaseRow>(
            `INSERT INTO user_onboarding (
               owner_user_id,
               goal,
               goal_selected_at
             ) VALUES ($1, $2, statement_timestamp())
             RETURNING ${onboardingColumns}`,
            [ownerUserId, goal]
          );
          return mapRequiredRow(inserted.rows[0]);
        }

        const updated = await client.query<UserOnboardingDatabaseRow>(
          `UPDATE user_onboarding SET
             goal = $3,
             goal_selected_at = statement_timestamp(),
             completed_at = CASE $3
               WHEN 'monitoring' THEN
                 CASE WHEN first_chart_at IS NULL
                   THEN NULL ELSE statement_timestamp() END
               WHEN 'price-alert' THEN
                 CASE WHEN first_alert_at IS NULL
                   THEN NULL ELSE statement_timestamp() END
               WHEN 'backtest' THEN
                 CASE WHEN first_backtest_at IS NULL
                   THEN NULL ELSE statement_timestamp() END
               WHEN 'paper-robot' THEN
                 CASE WHEN first_paper_robot_at IS NULL
                   THEN NULL ELSE statement_timestamp() END
             END,
             dismissed_at = NULL,
             revision = revision + 1,
             updated_at = statement_timestamp()
           WHERE owner_user_id = $1 AND revision = $2
           RETURNING ${onboardingColumns}`,
          [ownerUserId, expectedRevision, goal]
        );
        return mapMutationRow(updated.rows[0], current);
      }
    );
  }

  async recordMilestone(
    ownerUserId: string,
    expectedRevision: number,
    milestone: OnboardingMilestone,
    authorizationRevision: number
  ): Promise<OnboardingState> {
    const { column, field, goal } = milestoneDefinition(milestone);
    return this.ownerMutation(
      ownerUserId,
      authorizationRevision,
      async (client) => {
        const row = await readForUpdate(client, ownerUserId);
        const current = stateFromRow(row);
        if (current.milestones[field] !== null) return current;
        assertExpectedRevision(current, expectedRevision);

        if (!row) {
          const inserted = await client.query<UserOnboardingDatabaseRow>(
            `INSERT INTO user_onboarding (owner_user_id, ${column})
             VALUES ($1, statement_timestamp())
             RETURNING ${onboardingColumns}`,
            [ownerUserId]
          );
          return mapRequiredRow(inserted.rows[0]);
        }

        const updated = await client.query<UserOnboardingDatabaseRow>(
          `UPDATE user_onboarding SET
             ${column} = statement_timestamp(),
             completed_at = CASE
               WHEN dismissed_at IS NULL AND goal = $3
                 THEN COALESCE(completed_at, statement_timestamp())
               ELSE completed_at
             END,
             revision = revision + 1,
             updated_at = statement_timestamp()
           WHERE owner_user_id = $1 AND revision = $2
           RETURNING ${onboardingColumns}`,
          [ownerUserId, expectedRevision, goal]
        );
        return mapMutationRow(updated.rows[0], current);
      }
    );
  }

  async dismiss(
    ownerUserId: string,
    expectedRevision: number,
    authorizationRevision: number
  ): Promise<OnboardingState> {
    return this.ownerMutation(
      ownerUserId,
      authorizationRevision,
      async (client) => {
        const row = await readForUpdate(client, ownerUserId);
        const current = stateFromRow(row);
        if (current.dismissedAt !== null) return current;
        assertExpectedRevision(current, expectedRevision);

        if (!row) {
          const inserted = await client.query<UserOnboardingDatabaseRow>(
            `INSERT INTO user_onboarding (owner_user_id, dismissed_at)
             VALUES ($1, statement_timestamp())
             RETURNING ${onboardingColumns}`,
            [ownerUserId]
          );
          return mapRequiredRow(inserted.rows[0]);
        }

        const updated = await client.query<UserOnboardingDatabaseRow>(
          `UPDATE user_onboarding SET
             completed_at = NULL,
             dismissed_at = statement_timestamp(),
             revision = revision + 1,
             updated_at = statement_timestamp()
           WHERE owner_user_id = $1 AND revision = $2
           RETURNING ${onboardingColumns}`,
          [ownerUserId, expectedRevision]
        );
        return mapMutationRow(updated.rows[0], current);
      }
    );
  }

  async restart(
    ownerUserId: string,
    expectedRevision: number,
    authorizationRevision: number
  ): Promise<OnboardingState> {
    return this.ownerMutation(
      ownerUserId,
      authorizationRevision,
      async (client) => {
        const row = await readForUpdate(client, ownerUserId);
        const current = stateFromRow(row);
        if (isPristine(current)) return current;
        assertExpectedRevision(current, expectedRevision);
        if (!row) return current;

        const updated = await client.query<UserOnboardingDatabaseRow>(
          `UPDATE user_onboarding SET
             goal = NULL,
             goal_selected_at = NULL,
             first_chart_at = NULL,
             first_alert_at = NULL,
             first_backtest_at = NULL,
             first_paper_robot_at = NULL,
             completed_at = NULL,
             dismissed_at = NULL,
             revision = revision + 1,
             updated_at = statement_timestamp()
           WHERE owner_user_id = $1 AND revision = $2
           RETURNING ${onboardingColumns}`,
          [ownerUserId, expectedRevision]
        );
        return mapMutationRow(updated.rows[0], current);
      }
    );
  }

  private async ownerMutation<T>(
    ownerUserId: string,
    expectedAuthorizationRevision: number,
    operation: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{
        status: string;
        authorization_revision: string;
      }>(
        `SELECT status, authorization_revision::text
         FROM users
         WHERE id = $1
         FOR UPDATE`,
        [ownerUserId]
      );
      const authority = owner.rows[0];
      if (
        !authority ||
        authority.status !== "active" ||
        safeInteger(authority.authorization_revision, "authorization revision") !==
          expectedAuthorizationRevision
      ) {
        throw new OnboardingAuthorizationChangedError();
      }
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function readForUpdate(
  client: PoolClient,
  ownerUserId: string
): Promise<UserOnboardingDatabaseRow | undefined> {
  const result = await client.query<UserOnboardingDatabaseRow>(
    `SELECT ${onboardingColumns}
     FROM user_onboarding
     WHERE owner_user_id = $1
     FOR UPDATE`,
    [ownerUserId]
  );
  return result.rows[0];
}

function stateFromRow(
  row: UserOnboardingDatabaseRow | undefined
): OnboardingState {
  return row ? mapOnboardingState(row) : emptyOnboardingState();
}

function mapRequiredRow(
  row: UserOnboardingDatabaseRow | undefined
): OnboardingState {
  if (!row) throw new Error("Onboarding mutation did not return a row.");
  return mapOnboardingState(row);
}

function mapMutationRow(
  row: UserOnboardingDatabaseRow | undefined,
  current: OnboardingState
): OnboardingState {
  if (!row) throw new OnboardingConflictError(current);
  return mapOnboardingState(row);
}

function mapOnboardingState(row: UserOnboardingDatabaseRow): OnboardingState {
  if (row.schema_version !== 1) {
    throw new Error(`Unsupported onboarding schema version: ${row.schema_version}`);
  }
  const revision = safeInteger(row.revision, "onboarding revision");
  if (revision < 1) throw new Error("Onboarding revision must be positive.");
  const completedAt = isoTimestamp(row.completed_at);
  const dismissedAt = isoTimestamp(row.dismissed_at);
  return {
    schemaVersion: 1,
    revision,
    status: dismissedAt
      ? "dismissed"
      : completedAt
        ? "completed"
        : row.goal
          ? "in_progress"
          : "not_started",
    goal: row.goal,
    goalSelectedAt: isoTimestamp(row.goal_selected_at),
    milestones: {
      chartReadyAt: isoTimestamp(row.first_chart_at),
      priceAlertCreatedAt: isoTimestamp(row.first_alert_at),
      backtestCompletedAt: isoTimestamp(row.first_backtest_at),
      paperBotCreatedAt: isoTimestamp(row.first_paper_robot_at)
    },
    completedAt,
    dismissedAt,
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

function milestoneDefinition(milestone: OnboardingMilestone): {
  column:
    | "first_chart_at"
    | "first_alert_at"
    | "first_backtest_at"
    | "first_paper_robot_at";
  field: keyof OnboardingState["milestones"];
  goal: OnboardingGoal;
} {
  switch (milestone) {
    case "chart-ready":
      return {
        column: "first_chart_at",
        field: "chartReadyAt",
        goal: "monitoring"
      };
    case "price-alert-created":
      return {
        column: "first_alert_at",
        field: "priceAlertCreatedAt",
        goal: "price-alert"
      };
    case "backtest-completed":
      return {
        column: "first_backtest_at",
        field: "backtestCompletedAt",
        goal: "backtest"
      };
    case "paper-bot-created":
      return {
        column: "first_paper_robot_at",
        field: "paperBotCreatedAt",
        goal: "paper-robot"
      };
  }
}

function assertExpectedRevision(
  current: OnboardingState,
  expectedRevision: number
): void {
  if (current.revision !== expectedRevision) {
    throw new OnboardingConflictError(current);
  }
}

function isPristine(state: OnboardingState): boolean {
  return (
    state.goal === null &&
    state.goalSelectedAt === null &&
    state.milestones.chartReadyAt === null &&
    state.milestones.priceAlertCreatedAt === null &&
    state.milestones.backtestCompletedAt === null &&
    state.milestones.paperBotCreatedAt === null &&
    state.completedAt === null &&
    state.dismissedAt === null
  );
}

function isoTimestamp(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function safeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid ${label}.`);
  }
  return parsed;
}
