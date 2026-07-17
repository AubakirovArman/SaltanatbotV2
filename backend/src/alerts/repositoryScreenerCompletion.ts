import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  ALERT_EVENT_SCHEMA_V1,
  NOTIFICATION_ENVELOPE_SCHEMA_V1,
  parseAlertEventV1,
  parseNotificationEnvelopeV1,
  parseScreenerAlertDefinitionV1,
  type AlertEventV1,
  type NotificationOutboxItemV1,
  type ScreenerAlertDefinitionV1,
} from "@saltanatbotv2/contracts";
import { timeframeMs } from "../market/timeframes.js";
import {
  canonicalJson,
  iso,
  lockedAlertRuleSql,
  mapNotificationOutbox,
  positiveSafeInteger,
  sha256,
  type LockedAlertRuleRow,
} from "./repositoryRows.js";
import {
  SCREENER_ALERT_OBSERVATION_SCHEMA_V1,
  defaultScreenerAlertRuntimeState,
  parseScreenerAlertRuntimeStateStrict,
  screenerAlertChangeSummary,
  screenerAlertObservationFingerprint,
  screenerAlertStateKey,
  screenerAlertTransitionKey,
  type ScreenerAlertRuntimeStateV1,
} from "./screenerAlertEvaluator.js";
import {
  AlertClaimLostError,
  AlertEvaluationConflictError,
  AlertNotFoundError,
  AlertRevisionConflictError,
  type CompleteScreenerEvaluationInput,
  type CompleteScreenerEvaluationResult,
} from "./repositoryTypes.js";

const SCREENER_ALERT_PRODUCER = "screener-alert-worker";
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
  cooldown_until: Date | string | null;
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
  state: ScreenerAlertRuntimeStateV1;
  stateRevision: number;
  replacesPriorRuleRevision: boolean;
  cooldownUntilMs?: number;
}

export async function completeScreenerEvaluation(pool: Pool, input: CompleteScreenerEvaluationInput): Promise<CompleteScreenerEvaluationResult> {
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

async function completeInTransaction(client: PoolClient, input: CompleteScreenerEvaluationInput): Promise<CompleteScreenerEvaluationResult> {
  const locked = await lockRuleWithOwner(client, input.ownerUserId, input.ruleId);
  if (!locked) throw new AlertNotFoundError("Alert rule was not found for this owner.");
  assertEvaluationAuthorization(locked, input.expectedRevision, input.authorizationRevision);
  assertClaim(locked, input);
  if (locked.rule_kind !== "screener") throw new AlertEvaluationConflictError("The claimed rule is not a screener alert.");

  const definition = parseScreenerAlertDefinitionV1(locked.definition);
  const databaseNowMs = nonnegativeSafeInteger(locked.database_now_ms, "database clock");
  if (input.observation.closedBarTimeMax + timeframeMs[definition.screen.timeframe] > databaseNowMs) {
    throw new AlertEvaluationConflictError("The observation bar is not closed according to the database clock.");
  }
  const expectedStateKey = screenerAlertStateKey(definition.screen, locked.definition_hash);
  if (input.observation.subjectKey !== expectedStateKey) throw new AlertEvaluationConflictError("The observation does not belong to the claimed screener scope.");
  const durable = await lockDurableState(client, input);
  const receipt = await readReceipt(client, input);
  if (receipt) {
    verifyDuplicateReceipt(receipt, durable, input);
    await releaseDuplicateClaim(client, input);
    return { outcome: "duplicate" };
  }

  validateDurableAdvance(durable, input, databaseNowMs);
  const priorStateHash = sha256(canonicalJson(durable.state));
  const committedStateHash = sha256(canonicalJson(input.nextState));
  const committedStateRevision = await persistState(client, durable, input, definition.cooldownSeconds);
  if (committedStateRevision !== durable.stateRevision + 1) throw new AlertEvaluationConflictError("The durable alert state revision did not advance exactly once.");
  await insertReceipt(client, input, durable.stateRevision, committedStateRevision, priorStateHash, committedStateHash);
  const delivered = input.transition ? await writeTriggeredNotification(client, definition, input, input.transition) : {};
  await finishClaim(client, input, committedStateRevision);
  return { outcome: "applied", ...delivered };
}

async function lockRuleWithOwner(client: PoolClient, ownerUserId: string, ruleId: string): Promise<LockedAlertRuleRow | undefined> {
  const result = await client.query<LockedAlertRuleRow>(lockedAlertRuleSql(), [ownerUserId, ruleId]);
  return result.rows[0];
}

async function lockDurableState(client: PoolClient, input: CompleteScreenerEvaluationInput): Promise<LockedDurableState> {
  const result = await client.query<DurableStateRow>(
    `SELECT rule_revision, state_revision, state_status, initialized, eligible, armed,
       last_observation_id, last_observation_hash, last_evaluated_bar_time, state, cooldown_until
     FROM alert_rule_states
     WHERE owner_user_id = $1 AND alert_rule_id = $2 AND state_key = $3
     FOR UPDATE`,
    [input.ownerUserId, input.ruleId, input.observation.subjectKey],
  );
  const row = result.rows[0];
  if (!row) {
    if (input.expectedStateRevision !== 0) throw new AlertEvaluationConflictError("The claimed alert state revision no longer exists.");
    return { state: defaultScreenerAlertRuntimeState(), stateRevision: 0, replacesPriorRuleRevision: false };
  }

  const stateRevision = positiveSafeInteger(row.state_revision, "state revision");
  if (stateRevision !== input.expectedStateRevision) throw new AlertEvaluationConflictError("The alert state changed after it was claimed.");
  const storedRuleRevision = positiveSafeInteger(row.rule_revision, "state rule revision");
  if (storedRuleRevision > input.expectedRevision) throw new AlertEvaluationConflictError("The durable state belongs to a future alert rule revision.");
  const storedState = parseScreenerAlertRuntimeStateStrict(row.state);
  validateStoredStateColumns(row, storedState, input.observation.subjectKey);
  const replaces = storedRuleRevision < input.expectedRevision;
  const cooldownUntilMs = row.cooldown_until === null ? undefined : new Date(row.cooldown_until).getTime();
  if (cooldownUntilMs !== undefined && !Number.isFinite(cooldownUntilMs)) throw new Error("Stored screener alert cooldown timestamp is invalid.");
  return {
    row,
    state: replaces ? defaultScreenerAlertRuntimeState() : storedState,
    stateRevision,
    replacesPriorRuleRevision: replaces,
    ...(replaces || cooldownUntilMs === undefined ? {} : { cooldownUntilMs }),
  };
}

function validateStoredStateColumns(row: DurableStateRow, state: ScreenerAlertRuntimeStateV1, stateKey: string): void {
  const storedBarTime = row.last_evaluated_bar_time === null ? undefined : nonnegativeSafeInteger(row.last_evaluated_bar_time, "last evaluated bar time");
  if (row.state_status !== "ineligible" || row.eligible || !row.armed || row.initialized !== state.initialized) {
    throw new AlertEvaluationConflictError("Stored screener alert state columns disagree with the durable state document.");
  }
  if (!state.initialized) {
    if (row.last_observation_id !== null || row.last_observation_hash !== null || storedBarTime !== undefined) {
      throw new AlertEvaluationConflictError("Uninitialized screener alert state contains observation evidence.");
    }
    return;
  }
  if (storedBarTime !== state.lastClosedBarTimeMax || row.last_observation_id !== `${stateKey}:bar:${state.lastClosedBarTimeMax}` || !row.last_observation_hash || !HEX_64.test(row.last_observation_hash)) {
    throw new AlertEvaluationConflictError("Initialized screener alert state is missing exact cursor evidence.");
  }
}

/**
 * Re-verify the proposed advance against the durable prior state: fingerprints
 * are recomputed from stored membership, the entered/left sets are re-derived,
 * the availability floor and the cooldown fence are re-checked, and the first
 * evaluation may only initialize without triggering.
 */
function validateDurableAdvance(durable: LockedDurableState, input: CompleteScreenerEvaluationInput, databaseNowMs: number): void {
  const previous = durable.state;
  const next = input.nextState;
  const previousFingerprint = sha256(canonicalJson(previous.matchedSymbols));
  if (previousFingerprint !== previous.matchSetFingerprint) throw new AlertEvaluationConflictError("The durable screener state fingerprint does not match its membership.");
  if (previous.initialized && input.observation.closedBarTimeMax <= previous.lastClosedBarTimeMax) {
    throw new AlertEvaluationConflictError("The completion replayed or rewound the durable screener bar cursor.");
  }
  const universe = input.observation.universe;
  if (universe.requested === 0 || universe.unavailable * 10 > universe.requested * 3) {
    throw new AlertEvaluationConflictError("The observation violates the screener availability floor.");
  }
  const triggered = Boolean(input.transition);
  if (!previous.initialized && triggered) throw new AlertEvaluationConflictError("The first screener evaluation must initialize without triggering.");
  if (previous.initialized && !triggered) throw new AlertEvaluationConflictError("An initialized screener alert completion requires a match-set transition.");
  if (!input.transition) return;

  if (durable.cooldownUntilMs !== undefined && durable.cooldownUntilMs > databaseNowMs) {
    throw new AlertEvaluationConflictError("The screener alert cooldown has not elapsed.");
  }
  const transition = input.transition;
  const previousMembers = new Set(previous.matchedSymbols);
  const nextMembers = new Set(next.matchedSymbols);
  const entered = next.matchedSymbols.filter((symbol) => !previousMembers.has(symbol));
  const left = previous.matchedSymbols.filter((symbol) => !nextMembers.has(symbol));
  if (entered.length + left.length === 0 || next.matchSetFingerprint === previousFingerprint) {
    throw new AlertEvaluationConflictError("The screener transition does not change the effective matched set.");
  }
  const expectedTransitionKey = screenerAlertTransitionKey(input.ruleId, input.expectedRevision, previousFingerprint, next.matchSetFingerprint, input.observation.closedBarTimeMax);
  if (
    transition.previousFingerprint !== previousFingerprint ||
    transition.nextFingerprint !== next.matchSetFingerprint ||
    transition.transitionKey !== expectedTransitionKey ||
    !sameSymbolList(transition.enteredSymbols, entered) ||
    !sameSymbolList(transition.leftSymbols, left) ||
    transition.matchedCount !== next.matchedSymbols.length
  ) {
    throw new AlertEvaluationConflictError("The transition does not prove an exact durable match-set change.");
  }
}

async function persistState(client: PoolClient, durable: LockedDurableState, input: CompleteScreenerEvaluationInput, cooldownSeconds: number): Promise<number> {
  const triggered = Boolean(input.transition);
  const serialized = JSON.stringify(input.nextState);
  if (!durable.row) {
    const inserted = await client.query<{ state_revision: string | number }>(
      `INSERT INTO alert_rule_states (owner_user_id, alert_rule_id, state_key, rule_revision, state_revision,
         state_status, initialized, eligible, armed, last_observation_id, last_observation_hash,
         last_evaluated_bar_time, state, last_evaluated_at, updated_at)
       VALUES ($1,$2,$3,$4,1,'ineligible',TRUE,FALSE,TRUE,$5,$6,$7,$8::jsonb,statement_timestamp(),statement_timestamp())
       RETURNING state_revision`,
      [input.ownerUserId, input.ruleId, input.observation.subjectKey, input.expectedRevision, input.observation.observationKey, input.observation.evidenceFingerprint, input.observation.closedBarTimeMax, serialized],
    );
    return positiveSafeInteger(inserted.rows[0]!.state_revision, "committed state revision");
  }
  const updated = await client.query<{ state_revision: string | number }>(
    `UPDATE alert_rule_states SET rule_revision = $4, state_revision = state_revision + 1,
       state_status = 'ineligible', initialized = TRUE, eligible = FALSE, armed = TRUE,
       last_observation_id = $5, last_observation_hash = $6, last_evaluated_bar_time = $7,
       state = $8::jsonb, last_evaluated_at = statement_timestamp(),
       last_transition_at = CASE WHEN $9 THEN statement_timestamp() WHEN $10 THEN NULL ELSE last_transition_at END,
       last_triggered_at = CASE WHEN $9 THEN statement_timestamp() WHEN $10 THEN NULL ELSE last_triggered_at END,
       cooldown_until = CASE WHEN $9 AND $11::integer > 0 THEN statement_timestamp() + ($11 * interval '1 second')
         WHEN $9 OR $10 THEN NULL ELSE cooldown_until END,
       updated_at = statement_timestamp()
     WHERE owner_user_id = $1 AND alert_rule_id = $2 AND state_key = $3 AND state_revision = $12
     RETURNING state_revision`,
    [input.ownerUserId, input.ruleId, input.observation.subjectKey, input.expectedRevision, input.observation.observationKey, input.observation.evidenceFingerprint, input.observation.closedBarTimeMax, serialized, triggered, durable.replacesPriorRuleRevision, cooldownSeconds, durable.stateRevision],
  );
  if (!updated.rows[0]) throw new AlertEvaluationConflictError("The alert state changed before it could be committed.");
  return positiveSafeInteger(updated.rows[0].state_revision, "committed state revision");
}

async function readReceipt(client: PoolClient, input: CompleteScreenerEvaluationInput): Promise<EvaluationReceiptRow | undefined> {
  const result = await client.query<EvaluationReceiptRow>(
    `SELECT observation_hash, state_key, state_revision_before, state_revision_after, outcome,
       transition_key, prior_state_hash, committed_state_hash
     FROM alert_evaluation_receipts
     WHERE owner_user_id = $1 AND producer = $2 AND alert_rule_id = $3
       AND rule_revision = $4 AND observation_id = $5`,
    [input.ownerUserId, SCREENER_ALERT_PRODUCER, input.ruleId, input.expectedRevision, input.observation.observationKey],
  );
  return result.rows[0];
}

function verifyDuplicateReceipt(receipt: EvaluationReceiptRow, durable: LockedDurableState, input: CompleteScreenerEvaluationInput): void {
  const before = nonnegativeSafeInteger(receipt.state_revision_before, "receipt state revision before");
  const after = positiveSafeInteger(receipt.state_revision_after, "receipt state revision after");
  const expectedTransitionKey = receipt.outcome === "triggered" ? receipt.transition_key : null;
  if (after !== before + 1 || after !== durable.stateRevision || durable.replacesPriorRuleRevision || receipt.state_key !== input.observation.subjectKey || receipt.observation_hash !== input.observation.evidenceFingerprint || !HEX_64.test(receipt.prior_state_hash) || !HEX_64.test(receipt.committed_state_hash)) {
    throw new AlertEvaluationConflictError("The evaluation receipt does not match the current durable state fence.");
  }
  if ((expectedTransitionKey !== null && !HEX_64.test(expectedTransitionKey)) || (input.transition?.transitionKey ?? null) !== expectedTransitionKey || sha256(canonicalJson(durable.state)) !== receipt.committed_state_hash || sha256(canonicalJson(input.nextState)) !== receipt.committed_state_hash) {
    throw new AlertEvaluationConflictError("The replay does not exactly match the committed evaluation outcome.");
  }
  if (!durable.row || durable.row.last_observation_id !== input.observation.observationKey || durable.row.last_observation_hash !== input.observation.evidenceFingerprint) {
    throw new AlertEvaluationConflictError("The receipt observation is not the head of the durable alert state.");
  }
}

async function insertReceipt(client: PoolClient, input: CompleteScreenerEvaluationInput, before: number, after: number, priorStateHash: string, committedStateHash: string): Promise<void> {
  await client.query(
    `INSERT INTO alert_evaluation_receipts (owner_user_id, producer, alert_rule_id, rule_revision,
       state_key, observation_id, observation_hash, state_revision_before, state_revision_after,
       outcome, transition_key, prior_state_hash, committed_state_hash, evaluated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,statement_timestamp())`,
    [input.ownerUserId, SCREENER_ALERT_PRODUCER, input.ruleId, input.expectedRevision, input.observation.subjectKey, input.observation.observationKey, input.observation.evidenceFingerprint, before, after, input.transition ? "triggered" : "armed", input.transition?.transitionKey ?? null, priorStateHash, committedStateHash],
  );
}

/** The rule always stays active after a screener completion; cadence reschedules it. */
async function finishClaim(client: PoolClient, input: CompleteScreenerEvaluationInput, stateRevision: number): Promise<void> {
  const finished = await client.query(
    `UPDATE alert_rules SET status = 'active',
       next_evaluation_at = statement_timestamp() + (evaluation_interval_seconds * interval '1 second'),
       evaluation_failure_count = 0, lease_owner = NULL, lease_token = NULL, lease_acquired_at = NULL, lease_expires_at = NULL,
       last_evaluated_at = statement_timestamp(), last_success_at = statement_timestamp(),
       last_error_code = NULL, last_error_at = NULL, updated_at = statement_timestamp()
     WHERE owner_user_id = $1 AND id = $2 AND current_revision = $3 AND authorization_revision = $4
       AND lease_owner = $5 AND lease_token = $6 AND lease_generation = $7 AND lease_expires_at > statement_timestamp()
       AND EXISTS (SELECT 1 FROM users owner_user WHERE owner_user.id = alert_rules.owner_user_id
         AND owner_user.status = 'active' AND owner_user.must_change_password = FALSE
         AND owner_user.authorization_revision = alert_rules.authorization_revision)
       AND EXISTS (SELECT 1 FROM alert_rule_states state WHERE state.owner_user_id = alert_rules.owner_user_id
         AND state.alert_rule_id = alert_rules.id AND state.state_key = $8 AND state.rule_revision = alert_rules.current_revision
         AND state.state_revision = $9 AND state.last_observation_hash = $10)
     RETURNING id`,
    [input.ownerUserId, input.ruleId, input.expectedRevision, input.authorizationRevision, input.workerId, input.leaseToken, input.leaseGeneration, input.observation.subjectKey, stateRevision, input.observation.evidenceFingerprint],
  );
  if (!finished.rows[0]) throw new AlertClaimLostError("The alert evaluation lease was lost before commit.");
}

async function releaseDuplicateClaim(client: PoolClient, input: CompleteScreenerEvaluationInput): Promise<void> {
  const result = await client.query(
    `UPDATE alert_rules SET next_evaluation_at = statement_timestamp() + (evaluation_interval_seconds * interval '1 second'),
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
    [input.ownerUserId, input.ruleId, input.expectedRevision, input.authorizationRevision, input.workerId, input.leaseToken, input.leaseGeneration],
  );
  if (!result.rows[0]) throw new AlertClaimLostError("The duplicate completion no longer owns an active alert lease.");
}

async function writeTriggeredNotification(client: PoolClient, definition: ScreenerAlertDefinitionV1, input: CompleteScreenerEvaluationInput, transition: NonNullable<CompleteScreenerEvaluationInput["transition"]>): Promise<{ event: AlertEventV1; outbox: NotificationOutboxItemV1 }> {
  const eventId = randomUUID();
  const summary = screenerAlertChangeSummary(transition.enteredSymbols, transition.leftSymbols, transition.matchedCount);
  const eventInsert = await client.query<{ occurred_at: Date }>(
    `INSERT INTO alert_rule_events (id, owner_user_id, alert_rule_id, rule_revision, state_key, idempotency_key, event_type, from_state, to_state, observation_id, observation_hash, evidence, notification_requested, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,'triggered','ineligible','eligible',$7,$8,$9::jsonb,TRUE,statement_timestamp()) RETURNING occurred_at`,
    [eventId, input.ownerUserId, input.ruleId, input.expectedRevision, transition.subjectKey, transition.transitionKey, transition.observationKey, transition.evidenceFingerprint, JSON.stringify({ summary, observation: input.observation, transition })],
  );
  const occurredAt = iso(eventInsert.rows[0]!.occurred_at);
  const event = parseAlertEventV1({ schemaVersion: ALERT_EVENT_SCHEMA_V1, id: eventId, ruleId: input.ruleId, ruleRevision: input.expectedRevision, ruleKind: "screener", eventType: "triggered", subjectKey: transition.subjectKey, transitionKey: transition.transitionKey, evidenceId: transition.observationKey, evidenceFingerprint: transition.evidenceFingerprint, occurredAt, summary, researchOnly: true, executionPermission: false });
  const envelope = parseNotificationEnvelopeV1({ schemaVersion: NOTIFICATION_ENVELOPE_SCHEMA_V1, deduplicationId: transition.transitionKey, alertEventId: event.id, ruleId: input.ruleId, ruleRevision: input.expectedRevision, severity: "info", title: `Screen match changed: ${definition.name}`, body: `${summary} Research notification only.`, createdAt: occurredAt, researchOnly: true, executionPermission: false });
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

function validateCompletionInput(input: CompleteScreenerEvaluationInput): void {
  assertAuthorizationRevision(input.authorizationRevision);
  assertWorker(input.workerId);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision <= 0 || !Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration <= 0 || !Number.isSafeInteger(input.expectedStateRevision) || input.expectedStateRevision < 0) throw new Error("Alert evaluation fence is invalid.");
  const observation = input.observation;
  const universe = observation.universe;
  if (observation.schemaVersion !== SCREENER_ALERT_OBSERVATION_SCHEMA_V1 || observation.researchOnly !== true || observation.executionPermission !== false || !HEX_64.test(observation.subjectKey) || observation.observationKey !== `${observation.subjectKey}:bar:${observation.closedBarTimeMax}` || !HEX_64.test(observation.evidenceFingerprint) || !Number.isSafeInteger(observation.closedBarTimeMax) || observation.closedBarTimeMax < 0 || !Number.isSafeInteger(observation.evaluatedAt) || observation.evaluatedAt < 0) throw new Error("Screener alert observation is invalid.");
  if (![universe.requested, universe.evaluated, universe.matched, universe.unavailable].every((value) => Number.isSafeInteger(value) && value >= 0) || universe.evaluated > universe.requested || universe.matched > universe.evaluated || universe.unavailable > universe.requested) throw new Error("Screener alert observation is invalid.");
  const state = parseScreenerAlertRuntimeStateStrict(input.nextState);
  if (!state.initialized || state.lastClosedBarTimeMax !== observation.closedBarTimeMax) throw new Error("Screener alert runtime state is invalid.");
  if (observation.evidenceFingerprint !== screenerAlertObservationFingerprint(observation.subjectKey, observation.closedBarTimeMax, state, universe)) throw new Error("Screener alert observation does not match the proposed state.");
  if (!input.transition) return;
  const transition = input.transition;
  if (transition.kind !== "screener-alert-triggered" || transition.from !== "steady" || transition.to !== "changed" || transition.researchOnly !== true || transition.executionPermission !== false || transition.ruleId !== input.ruleId || transition.ruleRevision !== input.expectedRevision || transition.subjectKey !== observation.subjectKey || transition.observationKey !== observation.observationKey || transition.evidenceFingerprint !== observation.evidenceFingerprint || transition.occurredAt !== observation.closedBarTimeMax || !HEX_64.test(transition.transitionKey) || !HEX_64.test(transition.previousFingerprint) || transition.nextFingerprint !== state.matchSetFingerprint || !Array.isArray(transition.enteredSymbols) || !Array.isArray(transition.leftSymbols) || transition.enteredSymbols.length + transition.leftSymbols.length === 0 || transition.matchedCount !== state.matchedSymbols.length) {
    throw new Error("Screener alert transition does not match its observation and fence.");
  }
}

function sameSymbolList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((symbol, index) => symbol === right[index]);
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

function assertClaim(row: LockedAlertRuleRow, input: CompleteScreenerEvaluationInput): void {
  if (row.status !== "active" || row.lease_owner !== input.workerId || row.lease_token !== input.leaseToken || positiveSafeInteger(row.lease_generation, "lease generation") !== input.leaseGeneration || !row.lease_valid) throw new AlertClaimLostError("The alert evaluation lease is no longer valid.");
}

function nonnegativeSafeInteger(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Stored ${label} is invalid.`);
  return parsed;
}
