import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AlertEventV1, AlertRuleDocumentV1, NotificationOutboxItemV1 } from "@saltanatbotv2/contracts";
import { timeframeMs } from "../market/timeframes.js";
import { priceThresholdAlertScopeKey } from "./priceEvaluator.js";
import { completePriceEvaluation as completePriceEvaluationTransaction } from "./repositoryCompletion.js";
import { mapAlertEvent, mapAlertRule, mapClaimedPriceAlert, mapNotificationOutbox, parseAndHashAlertDefinition, positiveSafeInteger, selectAlertRuleSql, sha256, type AlertEventRow, type AlertRuleRow, type ClaimedPriceAlertRow, type NotificationOutboxRow } from "./repositoryRows.js";
import {
  ALERT_REPOSITORY_DEFAULT_LIST_LIMIT,
  ALERT_REPOSITORY_MAX_LIST_LIMIT,
  AlertCapacityError,
  AlertEvaluationConflictError,
  AlertIdempotencyConflictError,
  AlertNotFoundError,
  AlertQuotaError,
  AlertRevisionConflictError,
  MAX_ENABLED_ALERT_RULES_PER_OWNER,
  MAX_ACTIVE_ALERT_RULES_GLOBAL,
  MAX_RETAINED_ALERT_RULES_PER_OWNER,
  MAX_TOTAL_ALERT_RULE_HISTORY_PER_OWNER,
  type AlertRuleRecord,
  type ArchiveAlertRuleInput,
  type ClaimedPriceAlertRule,
  type ClaimPriceAlertInput,
  type CompletePriceEvaluationInput,
  type CompletePriceEvaluationResult,
  type CreateAlertRuleInput,
  type DeferPriceEvaluationInput,
  type FailPriceEvaluationInput,
  type RearmAlertRuleInput,
  type RecoverExpiredLeasesResult,
  type UpdateAlertRuleInput
} from "./repositoryTypes.js";

export {
  AlertCapacityError,
  AlertClaimLostError,
  AlertEvaluationConflictError,
  AlertIdempotencyConflictError,
  AlertNotFoundError,
  AlertQuotaError,
  AlertRevisionConflictError
} from "./repositoryTypes.js";

const ALERT_ADVISORY_LOCK_NAMESPACE = 1_895_696_368;
const ALERT_GLOBAL_CAPACITY_LOCK = 1_895_696_370;
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ERROR_CODE = /^[a-z][a-z0-9._-]{0,95}$/;

export class AlertRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateAlertRuleInput): Promise<AlertRuleRecord> {
    assertSelfActor(input.ownerUserId, input.actorUserId);
    assertAuthorizationRevision(input.authorizationRevision);
    if (!CLIENT_ID.test(input.clientId)) throw new Error("Alert client ID is invalid.");
    const parsed = parseAndHashAlertDefinition(input.definition);
    const interval = evaluationIntervalSeconds(parsed.definition, input.evaluationIntervalSeconds);
    return this.transaction(async (client) => {
      await this.lockOwner(client, input.ownerUserId);
      await assertActiveOwner(client, input.ownerUserId, input.authorizationRevision);
      const existing = await client.query<AlertRuleRow>(`${selectAlertRuleSql()} WHERE r.owner_user_id = $1 AND r.client_id = $2 LIMIT 1`, [input.ownerUserId, input.clientId]);
      if (existing.rows[0]) {
        if (existing.rows[0].definition_hash !== parsed.hash) throw new AlertIdempotencyConflictError("The client ID is already associated with a different alert definition.");
        return mapAlertRule(existing.rows[0]);
      }
      if (parsed.definition.enabled) await assertGlobalActiveCapacity(client);
      const quota = await client.query<{ enabled: string; retained: string; total: string }>(
        `SELECT count(*) FILTER (WHERE status = 'active')::text AS enabled,
           count(*) FILTER (WHERE status <> 'archived')::text AS retained,
           count(*)::text AS total
         FROM alert_rules WHERE owner_user_id = $1`,
        [input.ownerUserId]
      );
      if (Number(quota.rows[0]?.total ?? 0) >= MAX_TOTAL_ALERT_RULE_HISTORY_PER_OWNER) throw new AlertQuotaError(`At most ${MAX_TOTAL_ALERT_RULE_HISTORY_PER_OWNER} total alert rule records may be retained per owner while bounded history retention catches up.`);
      if (Number(quota.rows[0]?.retained ?? 0) >= MAX_RETAINED_ALERT_RULES_PER_OWNER) throw new AlertQuotaError(`At most ${MAX_RETAINED_ALERT_RULES_PER_OWNER} non-archived alert rules may be retained per owner.`);
      if (parsed.definition.enabled && Number(quota.rows[0]?.enabled ?? 0) >= MAX_ENABLED_ALERT_RULES_PER_OWNER) throw new AlertQuotaError(`At most ${MAX_ENABLED_ALERT_RULES_PER_OWNER} alert rules may be enabled per owner.`);
      const id = randomUUID();
      await client.query(
        `INSERT INTO alert_rules (id, owner_user_id, client_id, rule_kind, status, current_revision, authorization_revision, evaluation_interval_seconds, next_evaluation_at, created_by_user_id, updated_by_user_id)
         VALUES ($1,$2,$3,$4,$5::varchar,1,$6,$7,CASE WHEN $5::varchar = 'active' THEN clock_timestamp() ELSE NULL END,$2,$2)`,
        [id, input.ownerUserId, input.clientId, parsed.definition.kind, parsed.definition.enabled ? "active" : "disabled", input.authorizationRevision, interval]
      );
      await insertRevision(client, { ownerUserId: input.ownerUserId, ruleId: id, revision: 1, actorUserId: input.actorUserId, definition: parsed.definition, serialized: parsed.serialized, hash: parsed.hash });
      return requireRule(await readRule(client, input.ownerUserId, id));
    });
  }

  async list(ownerUserId: string, limit = ALERT_REPOSITORY_DEFAULT_LIST_LIMIT): Promise<AlertRuleRecord[]> {
    const result = await this.pool.query<AlertRuleRow>(`${selectAlertRuleSql()} WHERE r.owner_user_id = $1 ORDER BY CASE WHEN r.status = 'archived' THEN 1 ELSE 0 END, r.updated_at DESC, r.id DESC LIMIT $2`, [ownerUserId, boundedLimit(limit)]);
    return result.rows.map(mapAlertRule);
  }

  async get(ownerUserId: string, ruleId: string): Promise<AlertRuleRecord | undefined> {
    const result = await this.pool.query<AlertRuleRow>(`${selectAlertRuleSql()} WHERE r.owner_user_id = $1 AND r.id = $2 LIMIT 1`, [ownerUserId, ruleId]);
    return result.rows[0] && mapAlertRule(result.rows[0]);
  }

  async update(input: UpdateAlertRuleInput): Promise<AlertRuleRecord> {
    assertSelfActor(input.ownerUserId, input.actorUserId);
    assertAuthorizationRevision(input.authorizationRevision);
    const parsed = parseAndHashAlertDefinition(input.definition);
    return this.transaction(async (client) => {
      await this.lockOwner(client, input.ownerUserId);
      await assertActiveOwner(client, input.ownerUserId, input.authorizationRevision);
      const current = requireRuleRow(await lockRule(client, input.ownerUserId, input.ruleId));
      const currentRevision = positiveSafeInteger(current.current_revision, "alert revision");
      if (currentRevision !== input.expectedRevision) {
        if (currentRevision > input.expectedRevision && current.definition_hash === parsed.hash) return mapAlertRule(current);
        throw new AlertRevisionConflictError("The alert rule revision has changed.");
      }
      if (current.status === "archived") throw new AlertRevisionConflictError("Archived alert rules cannot be updated.");
      if (current.definition_hash === parsed.hash) {
        await client.query("UPDATE alert_rules SET authorization_revision = $3, updated_by_user_id = $1, updated_at = clock_timestamp() WHERE owner_user_id = $1 AND id = $2", [input.ownerUserId, input.ruleId, input.authorizationRevision]);
        return requireRule(await readRule(client, input.ownerUserId, input.ruleId));
      }
      if (parsed.definition.enabled && current.status !== "active") {
        await assertGlobalActiveCapacity(client);
        await assertEnabledQuota(client, input.ownerUserId);
      }
      const nextRevision = currentRevision + 1;
      const interval = evaluationIntervalSeconds(parsed.definition);
      await insertRevision(client, { ownerUserId: input.ownerUserId, ruleId: input.ruleId, revision: nextRevision, actorUserId: input.actorUserId, definition: parsed.definition, serialized: parsed.serialized, hash: parsed.hash });
      await client.query(
        `UPDATE alert_rules SET rule_kind = $3, status = $4::varchar, current_revision = $5, authorization_revision = $6,
           evaluation_interval_seconds = $7,
           next_evaluation_at = CASE WHEN $4::varchar = 'active' THEN clock_timestamp() ELSE NULL END,
           evaluation_failure_count = 0, lease_generation = lease_generation + 1,
           lease_owner = NULL, lease_token = NULL, lease_acquired_at = NULL, lease_expires_at = NULL,
           last_error_code = NULL, last_error_at = NULL, updated_by_user_id = $1, updated_at = clock_timestamp()
         WHERE owner_user_id = $1 AND id = $2`,
        [input.ownerUserId, input.ruleId, parsed.definition.kind, parsed.definition.enabled ? "active" : "disabled", nextRevision, input.authorizationRevision, interval]
      );
      return requireRule(await readRule(client, input.ownerUserId, input.ruleId));
    });
  }

  async archive(input: ArchiveAlertRuleInput): Promise<AlertRuleRecord> {
    assertSelfActor(input.ownerUserId, input.actorUserId);
    assertAuthorizationRevision(input.authorizationRevision);
    return this.transaction(async (client) => {
      await this.lockOwner(client, input.ownerUserId);
      await assertActiveOwner(client, input.ownerUserId, input.authorizationRevision);
      const current = requireRuleRow(await lockRule(client, input.ownerUserId, input.ruleId));
      if (positiveSafeInteger(current.current_revision, "alert revision") !== input.expectedRevision) throw new AlertRevisionConflictError("The alert rule revision has changed.");
      if (current.status !== "archived") {
        await client.query(
          `UPDATE alert_rules SET status = 'archived', authorization_revision = $3, next_evaluation_at = NULL,
             lease_generation = lease_generation + 1, lease_owner = NULL, lease_token = NULL, lease_acquired_at = NULL,
             lease_expires_at = NULL, archived_at = clock_timestamp(), updated_by_user_id = $1, updated_at = clock_timestamp()
           WHERE owner_user_id = $1 AND id = $2`,
          [input.ownerUserId, input.ruleId, input.authorizationRevision]
        );
      }
      return requireRule(await readRule(client, input.ownerUserId, input.ruleId));
    });
  }

  async rearm(input: RearmAlertRuleInput): Promise<AlertRuleRecord> {
    assertSelfActor(input.ownerUserId, input.actorUserId);
    assertAuthorizationRevision(input.authorizationRevision);
    const rearmKey = sha256(`rearm:${input.ruleId}:${input.expectedRevision}`);
    return this.transaction(async (client) => {
      await this.lockOwner(client, input.ownerUserId);
      await assertActiveOwner(client, input.ownerUserId, input.authorizationRevision);
      const current = requireRuleRow(await lockRule(client, input.ownerUserId, input.ruleId));
      const currentRevision = positiveSafeInteger(current.current_revision, "alert revision");
      if (currentRevision !== input.expectedRevision) {
        const replay = currentRevision === input.expectedRevision + 1 && (await eventExists(client, input.ownerUserId, rearmKey));
        if (replay) return mapAlertRule(current);
        throw new AlertRevisionConflictError("The alert rule revision has changed.");
      }
      const definition = parseAndHashAlertDefinition(current.definition).definition;
      if (definition.kind !== "price-threshold") throw new AlertRevisionConflictError("Only price-threshold alerts support rearming in this worker.");
      if (current.status === "archived") throw new AlertRevisionConflictError("Archived alert rules cannot be rearmed.");
      if (definition.enabled && current.status !== "active") {
        await assertGlobalActiveCapacity(client);
        await assertEnabledQuota(client, input.ownerUserId);
      }
      const nextRevision = currentRevision + 1;
      const parsed = parseAndHashAlertDefinition(definition);
      await insertRevision(client, { ownerUserId: input.ownerUserId, ruleId: input.ruleId, revision: nextRevision, actorUserId: input.actorUserId, definition, serialized: parsed.serialized, hash: parsed.hash });
      await client.query(
        `UPDATE alert_rules SET status = CASE WHEN $4 THEN 'active' ELSE 'disabled' END, current_revision = $3,
           authorization_revision = $5, next_evaluation_at = CASE WHEN $4 THEN clock_timestamp() ELSE NULL END,
           evaluation_failure_count = 0, lease_generation = lease_generation + 1, lease_owner = NULL, lease_token = NULL,
           lease_acquired_at = NULL, lease_expires_at = NULL, last_error_code = NULL, last_error_at = NULL,
           updated_by_user_id = $1, updated_at = clock_timestamp() WHERE owner_user_id = $1 AND id = $2`,
        [input.ownerUserId, input.ruleId, nextRevision, definition.enabled, input.authorizationRevision]
      );
      const stateKey = priceThresholdAlertScopeKey(definition);
      await client.query(
        `INSERT INTO alert_rule_states (owner_user_id, alert_rule_id, state_key, rule_revision, state_status, initialized, eligible, armed, state, last_evaluated_at)
         VALUES ($1,$2,$3,$4,'ineligible',FALSE,FALSE,TRUE,
           jsonb_build_object('status','armed','armedAt',floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint,
             'initialized',FALSE,'eligible',FALSE),statement_timestamp())
         ON CONFLICT (owner_user_id, alert_rule_id, state_key) DO UPDATE SET rule_revision = EXCLUDED.rule_revision,
           state_revision = alert_rule_states.state_revision + 1, state_status = 'ineligible', initialized = FALSE,
           eligible = FALSE, armed = TRUE, last_observation_id = NULL, last_observation_hash = NULL,
           last_evaluated_bar_time = NULL, state = EXCLUDED.state, last_evaluated_at = EXCLUDED.last_evaluated_at,
           last_transition_at = statement_timestamp(), last_triggered_at = NULL, cooldown_until = NULL, updated_at = statement_timestamp()`,
        [input.ownerUserId, input.ruleId, stateKey, nextRevision]
      );
      await client.query(
        `INSERT INTO alert_rule_events (id, owner_user_id, alert_rule_id, rule_revision, state_key, idempotency_key, event_type, to_state, evidence, notification_requested, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,'rearmed','ineligible',$7::jsonb,FALSE,statement_timestamp()) ON CONFLICT (owner_user_id, idempotency_key) DO NOTHING`,
        [randomUUID(), input.ownerUserId, input.ruleId, nextRevision, stateKey, rearmKey, JSON.stringify({ summary: "Price alert rearmed." })]
      );
      return requireRule(await readRule(client, input.ownerUserId, input.ruleId));
    });
  }

  async listEvents(ownerUserId: string, ruleId?: string, limit = ALERT_REPOSITORY_DEFAULT_LIST_LIMIT): Promise<AlertEventV1[]> {
    const parameters: unknown[] = [ownerUserId];
    const ruleFilter = ruleId ? ` AND event.alert_rule_id = $${parameters.push(ruleId)}` : "";
    parameters.push(boundedLimit(limit));
    const result = await this.pool.query<AlertEventRow>(
      `SELECT event.id, event.alert_rule_id, event.rule_revision, revision.rule_kind, event.state_key,
         event.idempotency_key, event.event_type, event.to_state, event.observation_id, event.observation_hash,
         event.evidence, event.occurred_at FROM alert_rule_events event
       INNER JOIN alert_rule_revisions revision ON revision.owner_user_id = event.owner_user_id
        AND revision.alert_rule_id = event.alert_rule_id AND revision.revision = event.rule_revision
       WHERE event.owner_user_id = $1${ruleFilter} ORDER BY event.occurred_at DESC, event.id DESC LIMIT $${parameters.length}`,
      parameters
    );
    return result.rows.map(mapAlertEvent);
  }

  async listOutbox(ownerUserId: string, limit = ALERT_REPOSITORY_DEFAULT_LIST_LIMIT): Promise<NotificationOutboxItemV1[]> {
    const result = await this.pool.query<NotificationOutboxRow>(
      `SELECT outbox.id, outbox.payload, outbox.created_at, delivery.channel,
         delivery.status AS delivery_status, delivery.attempt, delivery.max_attempts,
         delivery.run_after, delivery.delivered_at, delivery.error_message
       FROM notification_outbox outbox INNER JOIN notification_deliveries delivery
         ON delivery.owner_user_id = outbox.owner_user_id AND delivery.outbox_id = outbox.id
       WHERE outbox.owner_user_id = $1 ORDER BY outbox.created_at DESC, outbox.id DESC LIMIT $2`,
      [ownerUserId, boundedLimit(limit)]
    );
    return result.rows.map(mapNotificationOutbox);
  }

  async claimDuePriceAlert(input: ClaimPriceAlertInput): Promise<ClaimedPriceAlertRule | undefined> {
    assertWorker(input.workerId);
    if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1_000 || input.leaseMs > 300_000) throw new Error("Alert lease duration is invalid.");
    const leaseToken = randomUUID();
    try {
      return await this.transaction(async (client) => {
        const result = await client.query<ClaimedPriceAlertRow>(claimPriceAlertSql(), [input.workerId, leaseToken, input.leaseMs]);
        return result.rows[0] && mapClaimedPriceAlert(result.rows[0]);
      });
    } catch (error) {
      if (isOneLeasePerOwnerConflict(error)) return undefined;
      throw error;
    }
  }

  async recoverExpiredLeases(): Promise<RecoverExpiredLeasesResult> {
    const result = await this.pool.query(
      `UPDATE alert_rules SET lease_owner = NULL, lease_token = NULL, lease_acquired_at = NULL, lease_expires_at = NULL,
         next_evaluation_at = LEAST(next_evaluation_at, clock_timestamp()), evaluation_failure_count = LEAST(100, evaluation_failure_count + 1),
         last_error_code = 'lease_expired', last_error_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE status = 'active' AND lease_owner IS NOT NULL AND lease_expires_at <= clock_timestamp() RETURNING id`
    );
    return { recovered: result.rowCount ?? result.rows.length };
  }

  async completePriceEvaluation(input: CompletePriceEvaluationInput): Promise<CompletePriceEvaluationResult> {
    return completePriceEvaluationTransaction(this.pool, input);
  }

  async deferPriceEvaluation(input: DeferPriceEvaluationInput): Promise<boolean> {
    validateLeaseFence(input);
    const result = await this.pool.query(
      `UPDATE alert_rules rule SET next_evaluation_at = statement_timestamp() + (COALESCE($8::integer, evaluation_interval_seconds) * interval '1 second'),
         evaluation_failure_count = 0, last_success_at = statement_timestamp(), last_error_code = NULL, last_error_at = NULL,
         lease_owner = NULL, lease_token = NULL, lease_acquired_at = NULL, lease_expires_at = NULL,
         last_evaluated_at = statement_timestamp(), updated_at = statement_timestamp()
       WHERE owner_user_id = $1 AND id = $2 AND status = 'active' AND current_revision = $3 AND authorization_revision = $4
         AND lease_owner = $5 AND lease_token = $6 AND lease_generation = $7 AND lease_expires_at > statement_timestamp()
         AND EXISTS (SELECT 1 FROM users owner_user WHERE owner_user.id = rule.owner_user_id AND owner_user.status = 'active'
           AND owner_user.must_change_password = FALSE AND owner_user.authorization_revision = rule.authorization_revision)
       RETURNING id`,
      [input.ownerUserId, input.ruleId, input.expectedRevision, input.authorizationRevision, input.workerId, input.leaseToken, input.leaseGeneration, input.retryAfterSeconds ?? null]
    );
    return Boolean(result.rows[0]);
  }

  async failPriceEvaluation(input: FailPriceEvaluationInput): Promise<boolean> {
    validateFailureInput(input);
    return this.transaction(async (client) => {
      const result = await client.query<{ evaluation_failure_count: number }>(
        `UPDATE alert_rules rule SET evaluation_failure_count = LEAST(100, evaluation_failure_count + 1),
           next_evaluation_at = clock_timestamp() + (LEAST(3600, evaluation_interval_seconds * power(2, LEAST(evaluation_failure_count, 6))) * interval '1 second'),
           lease_owner = NULL, lease_token = NULL, lease_acquired_at = NULL, lease_expires_at = NULL,
           last_evaluated_at = clock_timestamp(), last_error_code = $8, last_error_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE owner_user_id = $1 AND id = $2 AND status = 'active' AND current_revision = $3 AND authorization_revision = $4
           AND lease_owner = $5 AND lease_token = $6 AND lease_generation = $7 AND lease_expires_at > clock_timestamp()
           AND EXISTS (SELECT 1 FROM users owner_user WHERE owner_user.id = rule.owner_user_id AND owner_user.status = 'active'
             AND owner_user.must_change_password = FALSE AND owner_user.authorization_revision = rule.authorization_revision)
         RETURNING evaluation_failure_count`,
        [input.ownerUserId, input.ruleId, input.expectedRevision, input.authorizationRevision, input.workerId, input.leaseToken, input.leaseGeneration, input.errorCode]
      );
      if (!result.rows[0]) return false;
      // Repeated retries of the same unavailable condition update rule health
      // but produce only one immutable history event per rule revision/code.
      const eventKey = sha256(`unavailable:${input.ruleId}:${input.expectedRevision}:${input.errorCode}`);
      await client.query(
        `INSERT INTO alert_rule_events (id, owner_user_id, alert_rule_id, rule_revision, state_key, idempotency_key, event_type, to_state, evidence, notification_requested, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,'evaluation_error','unavailable',$7::jsonb,FALSE,statement_timestamp())
         ON CONFLICT (owner_user_id, idempotency_key) DO NOTHING`,
        [randomUUID(), input.ownerUserId, input.ruleId, input.expectedRevision, input.stateKey, eventKey, JSON.stringify({ summary: "Price alert evaluation unavailable.", errorCode: input.errorCode })]
      );
      return true;
    });
  }

  private async lockOwner(client: PoolClient, ownerUserId: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock($1::integer, hashtext($2))", [ALERT_ADVISORY_LOCK_NAMESPACE, ownerUserId]);
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function insertRevision(client: PoolClient, input: { ownerUserId: string; ruleId: string; revision: number; actorUserId: string; definition: { schemaVersion: string; kind: string }; serialized: string; hash: string }): Promise<void> {
  await client.query(
    `INSERT INTO alert_rule_revisions (owner_user_id, alert_rule_id, revision, schema_version, rule_kind, definition, definition_hash, actor_user_id)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [input.ownerUserId, input.ruleId, input.revision, input.definition.schemaVersion, input.definition.kind, input.serialized, input.hash, input.actorUserId]
  );
}

async function readRule(database: Pick<Pool, "query"> | Pick<PoolClient, "query">, ownerUserId: string, ruleId: string): Promise<AlertRuleRow | undefined> {
  const result = await database.query<AlertRuleRow>(`${selectAlertRuleSql()} WHERE r.owner_user_id = $1 AND r.id = $2 LIMIT 1`, [ownerUserId, ruleId]);
  return result.rows[0];
}

async function lockRule(client: PoolClient, ownerUserId: string, ruleId: string): Promise<AlertRuleRow | undefined> {
  const result = await client.query<AlertRuleRow>(`${selectAlertRuleSql()} WHERE r.owner_user_id = $1 AND r.id = $2 FOR UPDATE OF r`, [ownerUserId, ruleId]);
  return result.rows[0];
}

async function eventExists(client: PoolClient, ownerUserId: string, idempotencyKey: string): Promise<boolean> {
  const result = await client.query("SELECT 1 FROM alert_rule_events WHERE owner_user_id = $1 AND idempotency_key = $2", [ownerUserId, idempotencyKey]);
  return Boolean(result.rows[0]);
}

async function assertActiveOwner(client: PoolClient, ownerUserId: string, authorizationRevision: number): Promise<void> {
  const result = await client.query<{ status: string; must_change_password: boolean; authorization_revision: string }>("SELECT status, must_change_password, authorization_revision FROM users WHERE id = $1 FOR SHARE", [ownerUserId]);
  const owner = result.rows[0];
  if (!owner || owner.status !== "active" || owner.must_change_password || positiveSafeInteger(owner.authorization_revision, "user authorization revision") !== authorizationRevision) throw new AlertEvaluationConflictError("The owner authorization is no longer valid.");
}

async function assertEnabledQuota(client: PoolClient, ownerUserId: string): Promise<void> {
  const result = await client.query<{ enabled: string }>("SELECT count(*)::text AS enabled FROM alert_rules WHERE owner_user_id = $1 AND status = 'active'", [ownerUserId]);
  if (Number(result.rows[0]?.enabled ?? 0) >= MAX_ENABLED_ALERT_RULES_PER_OWNER) throw new AlertQuotaError(`At most ${MAX_ENABLED_ALERT_RULES_PER_OWNER} alert rules may be enabled per owner.`);
}

async function assertGlobalActiveCapacity(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1::integer)", [ALERT_GLOBAL_CAPACITY_LOCK]);
  const result = await client.query<{ active: string }>("SELECT count(*)::text AS active FROM alert_rules WHERE status = 'active'");
  if (Number(result.rows[0]?.active ?? 0) >= MAX_ACTIVE_ALERT_RULES_GLOBAL) {
    throw new AlertCapacityError(`The R5.1 beta supports at most ${MAX_ACTIVE_ALERT_RULES_GLOBAL} globally active alert rules.`);
  }
}

function evaluationIntervalSeconds(definition: AlertRuleDocumentV1, override?: number): number {
  if (override !== undefined && (!Number.isInteger(override) || override < 60 || override > 86_400)) {
    throw new Error("Alert evaluation interval is invalid.");
  }
  if (definition.kind === "price-threshold") {
    return Math.max(60, Math.min(86_400, Math.floor(timeframeMs[definition.timeframe] / 1_000)));
  }
  return override ?? 60;
}

function requireRule(row: AlertRuleRow | undefined): AlertRuleRecord {
  if (!row) throw new AlertNotFoundError("Alert rule was not found for this owner.");
  return mapAlertRule(row);
}

function requireRuleRow(row: AlertRuleRow | undefined): AlertRuleRow {
  if (!row) throw new AlertNotFoundError("Alert rule was not found for this owner.");
  return row;
}

function boundedLimit(limit: number): number {
  if (!Number.isFinite(limit)) return ALERT_REPOSITORY_DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(ALERT_REPOSITORY_MAX_LIST_LIMIT, Math.floor(limit)));
}

function assertSelfActor(ownerUserId: string, actorUserId: string): void {
  if (ownerUserId !== actorUserId) throw new AlertNotFoundError("Alert rules can only be mutated by their owner.");
}

function assertAuthorizationRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Authorization revision is invalid.");
}

function assertWorker(workerId: string): void {
  if (workerId !== workerId.trim() || workerId.length < 1 || workerId.length > 128 || [...workerId].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error("Alert worker ID is invalid.");
}

function validateFailureInput(input: FailPriceEvaluationInput): void {
  validateLeaseFence(input);
  if (!input.stateKey || input.stateKey !== input.stateKey.trim() || input.stateKey.length > 256 || [...input.stateKey].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || !ERROR_CODE.test(input.errorCode)) throw new Error("Unavailable alert evaluation input is invalid.");
}

function validateLeaseFence(input: DeferPriceEvaluationInput): void {
  assertAuthorizationRevision(input.authorizationRevision);
  assertWorker(input.workerId);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision <= 0 || !Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration <= 0) throw new Error("Alert evaluation fence is invalid.");
  if (input.retryAfterSeconds !== undefined && (!Number.isSafeInteger(input.retryAfterSeconds) || input.retryAfterSeconds < 1 || input.retryAfterSeconds > 86_400)) throw new Error("Alert evaluation retry delay is invalid.");
}

function isOneLeasePerOwnerConflict(error: unknown): boolean {
  const value = error as { code?: unknown; constraint?: unknown } | null;
  return value?.code === "23505" && value.constraint === "alert_rules_one_leased_per_owner";
}

function claimPriceAlertSql(): string {
  return `WITH owner_heads AS MATERIALIZED (
    SELECT DISTINCT ON (r.owner_user_id) r.id, r.owner_user_id, r.next_evaluation_at, owner_user.authorization_revision
    FROM alert_rules r INNER JOIN users owner_user ON owner_user.id = r.owner_user_id
      AND owner_user.status = 'active' AND owner_user.must_change_password = FALSE
    WHERE r.status = 'active' AND r.rule_kind = 'price-threshold' AND r.lease_owner IS NULL
      AND r.next_evaluation_at <= clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM alert_rules leased WHERE leased.owner_user_id = r.owner_user_id AND leased.lease_owner IS NOT NULL)
    ORDER BY r.owner_user_id, r.next_evaluation_at, r.id
  ), candidate AS MATERIALIZED (
    SELECT r.id, r.owner_user_id, head.authorization_revision FROM alert_rules r INNER JOIN owner_heads head ON head.id = r.id
    ORDER BY head.next_evaluation_at, head.owner_user_id, head.id FOR UPDATE OF r SKIP LOCKED LIMIT 1
  ), claimed AS (
    UPDATE alert_rules r SET authorization_revision = candidate.authorization_revision,
      lease_generation = r.lease_generation + 1, lease_owner = $1, lease_token = $2,
      lease_acquired_at = clock_timestamp(), lease_expires_at = clock_timestamp() + ($3 * interval '1 millisecond'),
      updated_at = clock_timestamp() FROM candidate WHERE r.id = candidate.id AND r.owner_user_id = candidate.owner_user_id
    RETURNING r.*
  )
  SELECT r.id, r.owner_user_id, r.client_id, r.status, r.current_revision, r.authorization_revision,
    r.evaluation_interval_seconds, r.next_evaluation_at, r.evaluation_failure_count, r.last_evaluated_at,
    r.last_success_at, r.last_error_code, r.last_error_at, r.created_at, r.updated_at, r.archived_at,
    r.rule_kind, r.lease_owner, r.lease_token, r.lease_generation, r.lease_expires_at,
    revision.definition, revision.definition_hash, revision.created_at AS revision_created_at,
    state.state_key, state.state, state.rule_revision AS state_rule_revision, state.state_revision
  FROM claimed r INNER JOIN alert_rule_revisions revision ON revision.owner_user_id = r.owner_user_id
    AND revision.alert_rule_id = r.id AND revision.revision = r.current_revision
  LEFT JOIN LATERAL (SELECT s.state_key, s.state, s.rule_revision, s.state_revision FROM alert_rule_states s
    WHERE s.owner_user_id = r.owner_user_id AND s.alert_rule_id = r.id
      AND s.state_key = concat('market:', revision.definition->>'exchange', ':', revision.definition->>'marketType',
        ':', revision.definition->>'priceType', ':', revision.definition->>'symbol', ':', revision.definition->>'timeframe')
    LIMIT 1) state ON TRUE`;
}
