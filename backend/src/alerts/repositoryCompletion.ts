import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  ALERT_EVENT_SCHEMA_V1,
  NOTIFICATION_ENVELOPE_SCHEMA_V1,
  parseAlertEventV1,
  parseNotificationEnvelopeV1,
  parsePriceThresholdAlertDefinitionV1,
  type AlertEventV1,
  type NotificationOutboxItemV1,
  type PriceThresholdAlertDefinitionV1,
} from "@saltanatbotv2/contracts";
import { timeframeMs } from "../market/timeframes.js";
import { PRICE_THRESHOLD_OBSERVATION_SCHEMA_V1, priceThresholdAlertScopeKey, type PriceThresholdAlertRuntimeStateV1 } from "./priceEvaluator.js";
import { priceMatchesThreshold } from "./priceDecimal.js";
import {
  canonicalJson,
  defaultPriceAlertRuntimeState,
  iso,
  lockedAlertRuleSql,
  mapNotificationOutbox,
  parsePriceAlertRuntimeStateStrict,
  positiveSafeInteger,
  sha256,
  type LockedAlertRuleRow,
} from "./repositoryRows.js";
import {
  AlertClaimLostError,
  AlertEvaluationConflictError,
  AlertNotFoundError,
  AlertRevisionConflictError,
  type CompletePriceEvaluationInput,
  type CompletePriceEvaluationResult,
} from "./repositoryTypes.js";

const PRICE_ALERT_PRODUCER = "price-alert-worker";
const HEX_64 = /^[0-9a-f]{64}$/;

interface DurableStateRow {
  rule_revision: string | number;
  state_revision: string | number;
  state_status: "ineligible" | "eligible" | "stale" | "unavailable" | "error";
  initialized: boolean;
  eligible: boolean;
  armed: boolean;
  last_observation_id: string | null;
  last_observation_hash: string | null;
  last_evaluated_bar_time: string | number | null;
  state: unknown;
  last_triggered_at: Date | string | null;
}

interface EvaluationReceiptRow {
  observation_hash: string;
  state_key: string;
  state_revision_before: string | number;
  state_revision_after: string | number;
  outcome: "armed" | "triggered";
  transition_key: string | null;
  prior_state_hash: string;
  committed_state_hash: string;
}

interface LockedDurableState {
  row?: DurableStateRow;
  state: PriceThresholdAlertRuntimeStateV1;
  stateRevision: number;
  replacesPriorRuleRevision: boolean;
}

export async function completePriceEvaluation(pool: Pool, input: CompletePriceEvaluationInput): Promise<CompletePriceEvaluationResult> {
  validateCompletionInput(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await completeInTransaction(client, input);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function completeInTransaction(client: PoolClient, input: CompletePriceEvaluationInput): Promise<CompletePriceEvaluationResult> {
  const locked = await lockRuleWithOwner(client, input.ownerUserId, input.ruleId);
  if (!locked) throw new AlertNotFoundError("Alert rule was not found for this owner.");
  assertEvaluationAuthorization(locked, input.expectedRevision, input.authorizationRevision);
  assertClaim(locked, input);
  if (locked.rule_kind !== "price-threshold") throw new AlertEvaluationConflictError("The claimed rule is not a price-threshold alert.");

  const definition = parsePriceThresholdAlertDefinitionV1(locked.definition);
  if (input.observation.candleCloseTime > nonnegativeSafeInteger(locked.database_now_ms, "database clock")) throw new AlertEvaluationConflictError("The observation candle is not closed according to the database clock.");
  validateObservationScope(definition, input);
  const durable = await lockDurableState(client, locked, input, timeframeMs[definition.timeframe]);
  const receipt = await readReceipt(client, input);
  if (receipt) {
    verifyDuplicateReceipt(receipt, durable, input);
    await releaseDuplicateClaim(client, input, receipt.outcome === "triggered");
    return { outcome: "duplicate" };
  }

  validateDurableAdvance(definition, durable.state, input);
  const priorStateHash = sha256(canonicalJson(durable.state));
  const committedStateHash = sha256(canonicalJson(input.nextState));
  const committedStateRevision = await persistState(client, durable, input);
  if (committedStateRevision !== durable.stateRevision + 1) throw new AlertEvaluationConflictError("The durable alert state revision did not advance exactly once.");
  await insertReceipt(client, input, durable.stateRevision, committedStateRevision, priorStateHash, committedStateHash);
  const delivered = input.transition ? await writeTriggeredNotification(client, definition, input, input.transition) : {};
  await finishClaim(client, input, committedStateRevision, Boolean(input.transition));
  return { outcome: "applied", ...delivered };
}

async function lockRuleWithOwner(client: PoolClient, ownerUserId: string, ruleId: string): Promise<LockedAlertRuleRow | undefined> {
  const result = await client.query<LockedAlertRuleRow>(lockedAlertRuleSql(), [ownerUserId, ruleId]);
  return result.rows[0];
}

async function lockDurableState(client: PoolClient, locked: LockedAlertRuleRow, input: CompletePriceEvaluationInput, interval: number): Promise<LockedDurableState> {
  const result = await client.query<DurableStateRow>(
    `SELECT rule_revision, state_revision, state_status, initialized, eligible, armed,
       last_observation_id, last_observation_hash, last_evaluated_bar_time, state, last_triggered_at
     FROM alert_rule_states
     WHERE owner_user_id = $1 AND alert_rule_id = $2 AND state_key = $3
     FOR UPDATE`,
    [input.ownerUserId, input.ruleId, input.observation.subjectKey],
  );
  const row = result.rows[0];
  if (!row) {
    if (input.expectedStateRevision !== 0) throw new AlertEvaluationConflictError("The claimed alert state revision no longer exists.");
    return {
      state: defaultPriceAlertRuntimeState(locked.revision_created_at ?? locked.created_at),
      stateRevision: 0,
      replacesPriorRuleRevision: false,
    };
  }

  const stateRevision = positiveSafeInteger(row.state_revision, "state revision");
  if (stateRevision !== input.expectedStateRevision) throw new AlertEvaluationConflictError("The alert state changed after it was claimed.");
  const storedRuleRevision = positiveSafeInteger(row.rule_revision, "state rule revision");
  if (storedRuleRevision > input.expectedRevision) throw new AlertEvaluationConflictError("The durable state belongs to a future alert rule revision.");
  const storedState = parsePriceAlertRuntimeStateStrict(row.state);
  validateStoredStateColumns(row, storedState, input.observation.subjectKey, interval);
  return {
    row,
    state:
      storedRuleRevision === input.expectedRevision
        ? storedState
        : defaultPriceAlertRuntimeState(locked.revision_created_at ?? locked.created_at),
    stateRevision,
    replacesPriorRuleRevision: storedRuleRevision < input.expectedRevision,
  };
}

function validateStoredStateColumns(row: DurableStateRow, state: PriceThresholdAlertRuntimeStateV1, stateKey: string, interval: number): void {
  const expectedStatus = state.eligible ? "eligible" : "ineligible";
  const storedBarTime = row.last_evaluated_bar_time === null ? undefined : nonnegativeSafeInteger(row.last_evaluated_bar_time, "last evaluated bar time");
  if (row.state_status !== expectedStatus || row.initialized !== state.initialized || row.eligible !== state.eligible || row.armed !== (state.status === "armed") || storedBarTime !== state.lastEvaluatedBarTime) {
    throw new AlertEvaluationConflictError("Stored price alert state columns disagree with the durable state document.");
  }
  if (!state.initialized && (row.last_observation_id !== null || row.last_observation_hash !== null)) throw new AlertEvaluationConflictError("Uninitialized price alert state contains observation evidence.");
  if (state.initialized && (row.last_observation_id !== `${stateKey}:bar:${state.lastEvaluatedBarTime}` || !row.last_observation_hash || !HEX_64.test(row.last_observation_hash) || state.armedAt >= state.lastEvaluatedBarTime! + interval)) throw new AlertEvaluationConflictError("Initialized price alert state is missing exact cursor evidence.");
  if ((state.status === "triggered") !== (row.last_triggered_at !== null)) throw new AlertEvaluationConflictError("Stored price alert trigger metadata is inconsistent.");
}

function validateObservationScope(definition: PriceThresholdAlertDefinitionV1, input: CompletePriceEvaluationInput): void {
  const expectedScope = priceThresholdAlertScopeKey(definition);
  if (input.observation.subjectKey !== expectedScope || input.observation.observationKey !== `${expectedScope}:bar:${input.observation.candleOpenTime}`) throw new AlertEvaluationConflictError("The observation does not belong to the claimed market scope.");
  if (input.observation.candleCloseTime - input.observation.candleOpenTime !== timeframeMs[definition.timeframe]) throw new AlertEvaluationConflictError("The observation candle interval does not match the claimed alert timeframe.");
}

function validateDurableAdvance(definition: PriceThresholdAlertDefinitionV1, durable: PriceThresholdAlertRuntimeStateV1, input: CompletePriceEvaluationInput): void {
  if (durable.status !== "armed") throw new AlertEvaluationConflictError("A triggered alert state cannot be evaluated again before rearming.");
  const interval = timeframeMs[definition.timeframe];
  if (!durable.initialized) {
    if (durable.lastEvaluatedBarTime !== undefined || input.observation.candleOpenTime > durable.armedAt || durable.armedAt >= input.observation.candleCloseTime) throw new AlertEvaluationConflictError("The first observation is not the exact closed bar containing the durable arming time.");
  } else if (durable.lastEvaluatedBarTime === undefined || input.observation.candleOpenTime !== durable.lastEvaluatedBarTime + interval) {
    throw new AlertEvaluationConflictError("The completion skipped or replayed the durable alert cursor.");
  }

  const matched = priceMatchesThreshold(input.observation.close, definition.threshold, definition.direction);
  const crossing = durable.initialized && !durable.eligible && matched;
  const expectedNextState: PriceThresholdAlertRuntimeStateV1 = crossing
    ? {
        status: "triggered",
        armedAt: durable.armedAt,
        initialized: true,
        eligible: true,
        lastEvaluatedBarTime: input.observation.candleOpenTime,
        triggeredByTransitionKey: input.transition?.transitionKey,
      }
    : {
        status: "armed",
        armedAt: durable.armedAt,
        initialized: true,
        eligible: matched,
        lastEvaluatedBarTime: input.observation.candleOpenTime,
      };
  if (Boolean(input.transition) !== crossing || canonicalJson(input.nextState) !== canonicalJson(expectedNextState)) throw new AlertEvaluationConflictError("The proposed state does not prove an exact durable false-to-true crossing.");
  if (!input.transition) return;
  const expectedTransitionKey = sha256(JSON.stringify(["price-threshold-transition-v1", input.ruleId, input.expectedRevision, definition.direction, definition.threshold, input.observation.observationKey, input.observation.evidenceFingerprint]));
  if (input.transition.threshold !== definition.threshold || input.transition.direction !== definition.direction || input.transition.transitionKey !== expectedTransitionKey) throw new AlertEvaluationConflictError("The transition does not match the claimed alert definition.");
}

async function persistState(client: PoolClient, durable: LockedDurableState, input: CompletePriceEvaluationInput): Promise<number> {
  const stateStatus = input.nextState.eligible ? "eligible" : "ineligible";
  const triggered = Boolean(input.transition);
  if (!durable.row) {
    const inserted = await client.query<{ state_revision: string | number }>(
      `INSERT INTO alert_rule_states (owner_user_id, alert_rule_id, state_key, rule_revision, state_revision,
         state_status, initialized, eligible, armed, last_observation_id, last_observation_hash,
         last_evaluated_bar_time, state, last_evaluated_at, last_transition_at, last_triggered_at, updated_at)
       VALUES ($1,$2,$3,$4,1,$5,TRUE,$6,$7,$8,$9,$10,$11::jsonb,statement_timestamp(),
         CASE WHEN $12 THEN statement_timestamp() ELSE NULL END,
         CASE WHEN $13 THEN statement_timestamp() ELSE NULL END,statement_timestamp())
       RETURNING state_revision`,
      [input.ownerUserId, input.ruleId, input.observation.subjectKey, input.expectedRevision, stateStatus, input.nextState.eligible, !triggered, input.observation.observationKey, input.observation.evidenceFingerprint, input.observation.candleOpenTime, JSON.stringify(input.nextState), input.nextState.eligible, triggered],
    );
    return positiveSafeInteger(inserted.rows[0]!.state_revision, "committed state revision");
  }
  const updated = await client.query<{ state_revision: string | number }>(
    `UPDATE alert_rule_states SET rule_revision = $4, state_revision = state_revision + 1,
       state_status = $5, initialized = TRUE, eligible = $6, armed = $7,
       last_observation_id = $8, last_observation_hash = $9, last_evaluated_bar_time = $10,
       state = $11::jsonb, last_evaluated_at = statement_timestamp(),
       last_transition_at = CASE WHEN $12 THEN statement_timestamp() WHEN $13 THEN NULL ELSE last_transition_at END,
       last_triggered_at = CASE WHEN $14 THEN statement_timestamp() WHEN $13 THEN NULL ELSE last_triggered_at END,
       cooldown_until = NULL, updated_at = statement_timestamp()
     WHERE owner_user_id = $1 AND alert_rule_id = $2 AND state_key = $3 AND state_revision = $15
     RETURNING state_revision`,
    [input.ownerUserId, input.ruleId, input.observation.subjectKey, input.expectedRevision, stateStatus, input.nextState.eligible, !triggered, input.observation.observationKey, input.observation.evidenceFingerprint, input.observation.candleOpenTime, JSON.stringify(input.nextState), durable.state.eligible !== input.nextState.eligible, durable.replacesPriorRuleRevision, triggered, durable.stateRevision],
  );
  if (!updated.rows[0]) throw new AlertEvaluationConflictError("The alert state changed before it could be committed.");
  return positiveSafeInteger(updated.rows[0].state_revision, "committed state revision");
}

async function readReceipt(client: PoolClient, input: CompletePriceEvaluationInput): Promise<EvaluationReceiptRow | undefined> {
  const result = await client.query<EvaluationReceiptRow>(
    `SELECT observation_hash, state_key, state_revision_before, state_revision_after, outcome,
       transition_key, prior_state_hash, committed_state_hash
     FROM alert_evaluation_receipts
     WHERE owner_user_id = $1 AND producer = $2 AND alert_rule_id = $3
       AND rule_revision = $4 AND observation_id = $5`,
    [input.ownerUserId, PRICE_ALERT_PRODUCER, input.ruleId, input.expectedRevision, input.observation.observationKey],
  );
  return result.rows[0];
}

function verifyDuplicateReceipt(receipt: EvaluationReceiptRow, durable: LockedDurableState, input: CompletePriceEvaluationInput): void {
  const before = nonnegativeSafeInteger(receipt.state_revision_before, "receipt state revision before");
  const after = positiveSafeInteger(receipt.state_revision_after, "receipt state revision after");
  const expectedTransitionKey = receipt.outcome === "triggered" ? receipt.transition_key : null;
  if (after !== before + 1 || after !== durable.stateRevision || durable.replacesPriorRuleRevision || receipt.state_key !== input.observation.subjectKey || receipt.observation_hash !== input.observation.evidenceFingerprint || !HEX_64.test(receipt.prior_state_hash) || !HEX_64.test(receipt.committed_state_hash)) {
    throw new AlertEvaluationConflictError("The evaluation receipt does not match the current durable state fence.");
  }
  if ((expectedTransitionKey !== null && !HEX_64.test(expectedTransitionKey)) || (input.transition?.transitionKey ?? null) !== expectedTransitionKey || sha256(canonicalJson(durable.state)) !== receipt.committed_state_hash || sha256(canonicalJson(input.nextState)) !== receipt.committed_state_hash) {
    throw new AlertEvaluationConflictError("The replay does not exactly match the committed evaluation outcome.");
  }
  if (!durable.row || durable.row.last_observation_id !== input.observation.observationKey || durable.row.last_observation_hash !== input.observation.evidenceFingerprint || (receipt.outcome === "triggered") !== (durable.state.status === "triggered")) {
    throw new AlertEvaluationConflictError("The receipt observation is not the head of the durable alert state.");
  }
}

async function insertReceipt(client: PoolClient, input: CompletePriceEvaluationInput, before: number, after: number, priorStateHash: string, committedStateHash: string): Promise<void> {
  await client.query(
    `INSERT INTO alert_evaluation_receipts (owner_user_id, producer, alert_rule_id, rule_revision,
       state_key, observation_id, observation_hash, state_revision_before, state_revision_after,
       outcome, transition_key, prior_state_hash, committed_state_hash, evaluated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,statement_timestamp())`,
    [input.ownerUserId, PRICE_ALERT_PRODUCER, input.ruleId, input.expectedRevision, input.observation.subjectKey, input.observation.observationKey, input.observation.evidenceFingerprint, before, after, input.transition ? "triggered" : "armed", input.transition?.transitionKey ?? null, priorStateHash, committedStateHash],
  );
}

async function finishClaim(client: PoolClient, input: CompletePriceEvaluationInput, stateRevision: number, triggered: boolean): Promise<void> {
  const finished = await client.query(
    `UPDATE alert_rules SET status = CASE WHEN $7 THEN 'disabled' ELSE 'active' END,
       next_evaluation_at = CASE WHEN $7 THEN NULL
         WHEN $12 <= floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint - $13 THEN statement_timestamp()
         ELSE statement_timestamp() + (evaluation_interval_seconds * interval '1 second') END,
       evaluation_failure_count = 0, lease_owner = NULL, lease_token = NULL, lease_acquired_at = NULL, lease_expires_at = NULL,
       last_evaluated_at = statement_timestamp(), last_success_at = statement_timestamp(),
       last_error_code = NULL, last_error_at = NULL, updated_at = statement_timestamp()
     WHERE owner_user_id = $1 AND id = $2 AND current_revision = $3 AND authorization_revision = $4
       AND lease_owner = $5 AND lease_token = $6 AND lease_generation = $8 AND lease_expires_at > statement_timestamp()
       AND EXISTS (SELECT 1 FROM users owner_user WHERE owner_user.id = alert_rules.owner_user_id
         AND owner_user.status = 'active' AND owner_user.must_change_password = FALSE
         AND owner_user.authorization_revision = alert_rules.authorization_revision)
       AND EXISTS (SELECT 1 FROM alert_rule_states state WHERE state.owner_user_id = alert_rules.owner_user_id
         AND state.alert_rule_id = alert_rules.id AND state.state_key = $9 AND state.rule_revision = alert_rules.current_revision
         AND state.state_revision = $10 AND state.last_observation_hash = $11)
     RETURNING id`,
    [input.ownerUserId, input.ruleId, input.expectedRevision, input.authorizationRevision, input.workerId, input.leaseToken, triggered, input.leaseGeneration, input.observation.subjectKey, stateRevision, input.observation.evidenceFingerprint, input.observation.candleCloseTime, input.observation.candleCloseTime - input.observation.candleOpenTime],
  );
  if (!finished.rows[0]) throw new AlertClaimLostError("The alert evaluation lease was lost before commit.");
}

async function releaseDuplicateClaim(client: PoolClient, input: CompletePriceEvaluationInput, triggered: boolean): Promise<void> {
  const result = await client.query(
    `UPDATE alert_rules SET status = CASE WHEN $8 THEN 'disabled' ELSE status END,
       next_evaluation_at = CASE WHEN $8 THEN NULL
         WHEN $9 <= floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint - $10 THEN statement_timestamp()
         ELSE statement_timestamp() + (evaluation_interval_seconds * interval '1 second') END,
       evaluation_failure_count = 0, lease_owner = NULL, lease_token = NULL, lease_acquired_at = NULL, lease_expires_at = NULL,
       last_evaluated_at = statement_timestamp(), last_success_at = statement_timestamp(), last_error_code = NULL,
       last_error_at = NULL, updated_at = statement_timestamp()
     WHERE owner_user_id = $1 AND id = $2 AND current_revision = $3 AND authorization_revision = $4
       AND status = 'active' AND lease_owner = $5 AND lease_token = $6 AND lease_generation = $7
       AND lease_expires_at > statement_timestamp()
       AND EXISTS (SELECT 1 FROM users owner_user WHERE owner_user.id = alert_rules.owner_user_id
         AND owner_user.status = 'active' AND owner_user.must_change_password = FALSE
         AND owner_user.authorization_revision = alert_rules.authorization_revision)
     RETURNING id`,
    [input.ownerUserId, input.ruleId, input.expectedRevision, input.authorizationRevision, input.workerId, input.leaseToken, input.leaseGeneration, triggered, input.observation.candleCloseTime, input.observation.candleCloseTime - input.observation.candleOpenTime],
  );
  if (!result.rows[0]) throw new AlertClaimLostError("The duplicate completion no longer owns an active alert lease.");
}

async function writeTriggeredNotification(client: PoolClient, definition: PriceThresholdAlertDefinitionV1, input: CompletePriceEvaluationInput, transition: NonNullable<CompletePriceEvaluationInput["transition"]>): Promise<{ event: AlertEventV1; outbox: NotificationOutboxItemV1 }> {
  const eventId = randomUUID();
  const summary = `${definition.symbol} crossed ${definition.threshold} ${definition.direction}.`;
  const eventInsert = await client.query<{ occurred_at: Date }>(
    `INSERT INTO alert_rule_events (id, owner_user_id, alert_rule_id, rule_revision, state_key, idempotency_key, event_type, from_state, to_state, observation_id, observation_hash, evidence, notification_requested, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,'triggered','ineligible','eligible',$7,$8,$9::jsonb,TRUE,statement_timestamp()) RETURNING occurred_at`,
    [eventId, input.ownerUserId, input.ruleId, input.expectedRevision, transition.subjectKey, transition.transitionKey, transition.observationKey, transition.evidenceFingerprint, JSON.stringify({ summary, observation: input.observation, transition })],
  );
  const occurredAt = iso(eventInsert.rows[0]!.occurred_at);
  const event = parseAlertEventV1({ schemaVersion: ALERT_EVENT_SCHEMA_V1, id: eventId, ruleId: input.ruleId, ruleRevision: input.expectedRevision, ruleKind: "price-threshold", eventType: "triggered", subjectKey: transition.subjectKey, transitionKey: transition.transitionKey, evidenceId: transition.observationKey, evidenceFingerprint: transition.evidenceFingerprint, occurredAt, summary, researchOnly: true, executionPermission: false });
  const envelope = parseNotificationEnvelopeV1({ schemaVersion: NOTIFICATION_ENVELOPE_SCHEMA_V1, deduplicationId: transition.transitionKey, alertEventId: event.id, ruleId: input.ruleId, ruleRevision: input.expectedRevision, severity: "warning", title: `${definition.symbol} price alert`, body: `${definition.symbol} ${definition.direction} ${definition.threshold}; observed ${transition.observedPrice}. Research notification only.`, createdAt: occurredAt, researchOnly: true, executionPermission: false });
  const outboxId = randomUUID();
  const outboxInsert = await client.query<{ created_at: Date }>(
    `INSERT INTO notification_outbox (id, owner_user_id, alert_event_id, alert_rule_id, rule_revision, authorization_revision, deduplication_key, schema_version, payload, payload_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING created_at`,
    [outboxId, input.ownerUserId, event.id, input.ruleId, input.expectedRevision, input.authorizationRevision, transition.transitionKey, NOTIFICATION_ENVELOPE_SCHEMA_V1, JSON.stringify(envelope), sha256(canonicalJson(envelope))],
  );
  const delivery = await client.query<{ channel: "in-app"; status: "delivered"; attempt: number; max_attempts: number; run_after: Date; delivered_at: Date }>(
    `INSERT INTO notification_deliveries (id, owner_user_id, outbox_id, channel, deduplication_key, status, attempt, max_attempts, run_after, lease_generation, created_at, updated_at, terminal_at, delivered_at)
     VALUES ($1,$2,$3,'in-app',$4,'delivered',1,1,statement_timestamp(),1,statement_timestamp(),statement_timestamp(),statement_timestamp(),statement_timestamp())
     RETURNING channel, status, attempt, max_attempts, run_after, delivered_at`,
    [randomUUID(), input.ownerUserId, outboxId, transition.transitionKey],
  );
  const row = delivery.rows[0]!;
  return { event, outbox: mapNotificationOutbox({ id: outboxId, payload: envelope, created_at: outboxInsert.rows[0]!.created_at, channel: row.channel, delivery_status: row.status, attempt: row.attempt, max_attempts: row.max_attempts, run_after: row.run_after, delivered_at: row.delivered_at, error_message: null }) };
}

function validateCompletionInput(input: CompletePriceEvaluationInput): void {
  assertAuthorizationRevision(input.authorizationRevision);
  assertWorker(input.workerId);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision <= 0 || !Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration <= 0 || !Number.isSafeInteger(input.expectedStateRevision) || input.expectedStateRevision < 0) throw new Error("Alert evaluation fence is invalid.");
  const observation = input.observation;
  if (observation.schemaVersion !== PRICE_THRESHOLD_OBSERVATION_SCHEMA_V1 || observation.researchOnly !== true || observation.executionPermission !== false || !observation.subjectKey || observation.subjectKey.length > 256 || !observation.observationKey || observation.observationKey.length > 256 || !HEX_64.test(observation.evidenceFingerprint) || !Number.isSafeInteger(observation.evaluatedAt) || !Number.isSafeInteger(observation.candleOpenTime) || !Number.isSafeInteger(observation.candleCloseTime) || observation.candleOpenTime < 0 || observation.candleCloseTime <= observation.candleOpenTime || observation.evaluatedAt < observation.candleCloseTime || !Number.isFinite(observation.close) || observation.close <= 0) throw new Error("Price alert observation is invalid.");
  const state = input.nextState;
  if ((state.status !== "armed" && state.status !== "triggered") || !Number.isSafeInteger(state.armedAt) || state.armedAt < 0 || state.armedAt >= observation.candleCloseTime || state.initialized !== true || typeof state.eligible !== "boolean" || (state.status === "triggered" && !state.eligible) || state.lastEvaluatedBarTime !== observation.candleOpenTime || Boolean(input.transition) !== (state.status === "triggered")) throw new Error("Price alert runtime state is invalid.");
  if (!input.transition && state.triggeredByTransitionKey !== undefined) throw new Error("An armed price alert cannot retain a triggered transition key.");
  if (input.transition && (input.transition.kind !== "price-threshold-triggered" || input.transition.from !== "armed" || input.transition.to !== "triggered" || input.transition.researchOnly !== true || input.transition.executionPermission !== false || input.transition.ruleId !== input.ruleId || input.transition.ruleRevision !== input.expectedRevision || input.transition.subjectKey !== observation.subjectKey || input.transition.observationKey !== observation.observationKey || input.transition.evidenceFingerprint !== observation.evidenceFingerprint || !HEX_64.test(input.transition.transitionKey) || state.triggeredByTransitionKey !== input.transition.transitionKey || input.transition.occurredAt !== observation.candleCloseTime || !Number.isFinite(input.transition.observedPrice) || input.transition.observedPrice !== observation.close)) throw new Error("Price alert transition does not match its observation and fence.");
}

function assertAuthorizationRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Authorization revision is invalid.");
}

function assertWorker(workerId: string): void {
  if (workerId !== workerId.trim() || workerId.length < 1 || workerId.length > 128 || [...workerId].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error("Alert worker ID is invalid.");
}

function assertEvaluationAuthorization(row: LockedAlertRuleRow, expectedRevision: number, authorizationRevision: number): void {
  if (positiveSafeInteger(row.current_revision, "alert revision") !== expectedRevision) throw new AlertRevisionConflictError("The alert rule revision changed during evaluation.");
  if (positiveSafeInteger(row.authorization_revision, "alert authorization revision") !== authorizationRevision || row.user_status !== "active" || row.user_must_change_password || positiveSafeInteger(row.user_authorization_revision, "user authorization revision") !== authorizationRevision) throw new AlertEvaluationConflictError("The owner authorization is no longer valid.");
}

function assertClaim(row: LockedAlertRuleRow, input: CompletePriceEvaluationInput): void {
  if (row.status !== "active" || row.lease_owner !== input.workerId || row.lease_token !== input.leaseToken || positiveSafeInteger(row.lease_generation, "lease generation") !== input.leaseGeneration || !row.lease_valid) throw new AlertClaimLostError("The alert evaluation lease is no longer valid.");
}

function nonnegativeSafeInteger(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Stored ${label} is invalid.`);
  return parsed;
}
