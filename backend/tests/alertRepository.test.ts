import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { AlertClaimLostError, AlertCapacityError, AlertEvaluationConflictError, AlertIdempotencyConflictError, AlertQuotaError, AlertRepository } from "../src/alerts/repository.js";
import { PRICE_THRESHOLD_OBSERVATION_SCHEMA_V1, priceThresholdAlertScopeKey } from "../src/alerts/priceEvaluator.js";
import { canonicalJson, parseAndHashAlertDefinition, sha256, type AlertRuleRow, type LockedAlertRuleRow } from "../src/alerts/repositoryRows.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
const RULE = "33333333-3333-4333-8333-333333333333";
const LEASE = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-07-17T12:00:00.000Z";
const FUTURE = "2099-07-17T12:00:00.000Z";
const DEFINITION = {
  schemaVersion: "alert-rule-v1",
  kind: "price-threshold",
  name: "BTC above 100",
  enabled: true,
  cooldownSeconds: 0,
  deliveryChannels: ["in-app"],
  researchOnly: true,
  executionPermission: false,
  exchange: "binance",
  marketType: "spot",
  priceType: "last",
  symbol: "BTCUSDT",
  timeframe: "1m",
  direction: "above",
  threshold: "100",
  crossing: "inclusive",
  repeat: "once-until-rearmed"
} as const;
const DEFINITION_HASH = parseAndHashAlertDefinition(DEFINITION).hash;

interface QueryCall {
  sql: string;
  values: readonly unknown[];
}

type QueryHandler = (sql: string, values: readonly unknown[]) => Promise<QueryResult> | QueryResult;

interface QueryResult {
  rows: any[];
  rowCount: number;
}

describe("alert PostgreSQL repository", () => {
  it("replays an identical owner/client request and rejects a different definition", async () => {
    const replayDouble = poolDouble((sql) => {
      if (sql.includes("r.client_id = $2")) return result([ruleRow()]);
      return routine(sql);
    });
    const replay = await new AlertRepository(replayDouble.pool).create(createInput());
    expect(replay).toMatchObject({ id: RULE, ownerUserId: OWNER, currentRevision: 1, definitionHash: DEFINITION_HASH });
    expect(replayDouble.calls.some((call) => call.sql.includes("INSERT INTO alert_rules"))).toBe(false);

    const conflictDouble = poolDouble((sql) => {
      if (sql.includes("r.client_id = $2")) return result([ruleRow({ definition_hash: "f".repeat(64) })]);
      return routine(sql);
    });
    await expect(new AlertRepository(conflictDouble.pool).create(createInput())).rejects.toBeInstanceOf(AlertIdempotencyConflictError);
    expect(conflictDouble.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("enforces enabled, operational, and total-history owner quotas under an advisory lock", async () => {
    const enabled = poolDouble((sql) => {
      if (sql.includes("r.client_id = $2")) return result([]);
      if (sql.includes("FILTER (WHERE status = 'active')")) return result([{ enabled: "100", retained: "150", total: "150" }]);
      return routine(sql);
    });
    await expect(new AlertRepository(enabled.pool).create(createInput())).rejects.toBeInstanceOf(AlertQuotaError);
    expect(enabled.calls.some((call) => call.sql.includes("pg_advisory_xact_lock"))).toBe(true);

    const retained = poolDouble((sql) => {
      if (sql.includes("r.client_id = $2")) return result([]);
      if (sql.includes("FILTER (WHERE status = 'active')")) return result([{ enabled: "0", retained: "200", total: "250" }]);
      return routine(sql);
    });
    await expect(new AlertRepository(retained.pool).create(createInput({ definition: { ...DEFINITION, enabled: false } }))).rejects.toBeInstanceOf(AlertQuotaError);
    expect(retained.calls.find((call) => call.sql.includes("AS retained"))?.sql).toContain("status <> 'archived'");

    const totalHistory = poolDouble((sql) => {
      if (sql.includes("r.client_id = $2")) return result([]);
      if (sql.includes("FILTER (WHERE status = 'active')")) return result([{ enabled: "0", retained: "0", total: "400" }]);
      return routine(sql);
    });
    await expect(new AlertRepository(totalHistory.pool).create(createInput({ definition: { ...DEFINITION, enabled: false } }))).rejects.toBeInstanceOf(AlertQuotaError);
    expect(totalHistory.calls.find((call) => call.sql.includes("AS total"))?.sql).toContain("count(*)::text AS total");

    const enableUpdate = poolDouble((sql) => {
      if (sql.includes("FOR UPDATE OF r")) return result([ruleRow({ status: "disabled", next_evaluation_at: null })]);
      if (sql.startsWith("SELECT count(*)::text AS enabled")) return result([{ enabled: "100" }]);
      return routine(sql);
    });
    await expect(new AlertRepository(enableUpdate.pool).update({ ownerUserId: OWNER, actorUserId: OWNER, ruleId: RULE, expectedRevision: 1, authorizationRevision: 7, definition: { ...DEFINITION, threshold: "101" } })).rejects.toBeInstanceOf(AlertQuotaError);

    const archiveAtHistoryPressure = poolDouble((sql) => {
      if (sql.includes("FOR UPDATE OF r")) return result([ruleRow()]);
      if (sql.includes("WHERE r.owner_user_id = $1 AND r.id = $2 LIMIT 1")) return result([ruleRow({ status: "archived", archived_at: NOW, next_evaluation_at: null })]);
      return routine(sql);
    });
    await expect(new AlertRepository(archiveAtHistoryPressure.pool).archive({ ownerUserId: OWNER, actorUserId: OWNER, ruleId: RULE, expectedRevision: 1, authorizationRevision: 7 })).resolves.toMatchObject({ status: "archived" });
    expect(archiveAtHistoryPressure.calls.some((call) => call.sql.includes("count(*)::text AS archived"))).toBe(false);
  });

  it("serializes and rejects globally active rules beyond the R5.1 beta capacity", async () => {
    const capacity = poolDouble((sql) => {
      if (sql.includes("r.client_id = $2")) return result([]);
      if (sql === "SELECT count(*)::text AS active FROM alert_rules WHERE status = 'active'") return result([{ active: "480" }]);
      return routine(sql);
    });
    await expect(new AlertRepository(capacity.pool).create(createInput())).rejects.toBeInstanceOf(AlertCapacityError);
    expect(capacity.calls.some((call) => call.sql === "SELECT pg_advisory_xact_lock($1::integer)")).toBe(true);
    expect(capacity.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("derives price evaluation cadence from timeframe and caps daily/weekly churn", async () => {
    const daily = { ...DEFINITION, timeframe: "1d" } as const;
    const double = poolDouble((sql) => {
      if (sql.includes("r.client_id = $2")) return result([]);
      if (sql.includes("AS active FROM alert_rules")) return result([{ active: "0" }]);
      if (sql.includes("AS retained")) return result([{ enabled: "0", retained: "0", total: "0" }]);
      if (sql.includes("WHERE r.owner_user_id = $1 AND r.id = $2 LIMIT 1")) return result([ruleRow({ definition: daily, evaluation_interval_seconds: 86_400 })]);
      return routine(sql);
    });
    await new AlertRepository(double.pool).create(createInput({ definition: daily }));
    expect(double.calls.find((call) => call.sql.includes("INSERT INTO alert_rules"))?.values[6]).toBe(86_400);

    const weekly = { ...DEFINITION, timeframe: "1w", threshold: "101" } as const;
    const update = poolDouble((sql) => {
      if (sql.includes("FOR UPDATE OF r")) return result([ruleRow()]);
      if (sql.includes("WHERE r.owner_user_id = $1 AND r.id = $2 LIMIT 1")) return result([ruleRow({ definition: weekly, current_revision: "2", evaluation_interval_seconds: 86_400 })]);
      return routine(sql);
    });
    await new AlertRepository(update.pool).update({ ownerUserId: OWNER, actorUserId: OWNER, ruleId: RULE, expectedRevision: 1, authorizationRevision: 7, definition: weekly });
    expect(update.calls.find((call) => call.sql.startsWith("UPDATE alert_rules SET rule_kind"))?.values[6]).toBe(86_400);
  });

  it("inserts immutable revisions and treats a same-hash stale revision as lost-response replay", async () => {
    const changed = { ...DEFINITION, threshold: "101" } as const;
    const changedHash = parseAndHashAlertDefinition(changed).hash;
    const updateDouble = poolDouble((sql) => {
      if (sql.includes("FOR UPDATE OF r")) return result([ruleRow()]);
      if (sql.includes("WHERE r.owner_user_id = $1 AND r.id = $2 LIMIT 1")) return result([ruleRow({ current_revision: "2", definition: changed, definition_hash: changedHash })]);
      return routine(sql);
    });
    const updated = await new AlertRepository(updateDouble.pool).update({ ownerUserId: OWNER, actorUserId: OWNER, ruleId: RULE, expectedRevision: 1, authorizationRevision: 7, definition: changed });
    expect(updated.currentRevision).toBe(2);
    const revisionInsert = updateDouble.calls.find((call) => call.sql.includes("INSERT INTO alert_rule_revisions"));
    expect(revisionInsert?.values.slice(0, 3)).toEqual([OWNER, RULE, 2]);
    expect(revisionInsert?.values[6]).toBe(changedHash);

    const replayDouble = poolDouble((sql) => {
      if (sql.includes("FOR UPDATE OF r")) return result([ruleRow({ current_revision: "2", definition: changed, definition_hash: changedHash })]);
      return routine(sql);
    });
    const replay = await new AlertRepository(replayDouble.pool).update({ ownerUserId: OWNER, actorUserId: OWNER, ruleId: RULE, expectedRevision: 1, authorizationRevision: 7, definition: changed });
    expect(replay.currentRevision).toBe(2);
    expect(replayDouble.calls.some((call) => call.sql.includes("INSERT INTO alert_rule_revisions"))).toBe(false);
  });

  it("archives with a revision fence and rearms by creating a new immutable revision and state", async () => {
    const archiveDouble = poolDouble((sql) => {
      if (sql.includes("FOR UPDATE OF r")) return result([ruleRow()]);
      if (sql.includes("WHERE r.owner_user_id = $1 AND r.id = $2 LIMIT 1")) return result([ruleRow({ status: "archived", archived_at: NOW, next_evaluation_at: null })]);
      return routine(sql);
    });
    const archived = await new AlertRepository(archiveDouble.pool).archive({ ownerUserId: OWNER, actorUserId: OWNER, ruleId: RULE, expectedRevision: 1, authorizationRevision: 7 });
    expect(archived.status).toBe("archived");
    const archiveSql = archiveDouble.calls.find((call) => call.sql.includes("SET status = 'archived'"))?.sql ?? "";
    expect(archiveSql).toContain("lease_generation = lease_generation + 1");

    const rearmDouble = poolDouble((sql) => {
      if (sql.includes("FOR UPDATE OF r")) return result([ruleRow({ status: "disabled", next_evaluation_at: null })]);
      if (sql.includes("WHERE r.owner_user_id = $1 AND r.id = $2 LIMIT 1")) return result([ruleRow({ current_revision: "2" })]);
      return routine(sql);
    });
    const rearmed = await new AlertRepository(rearmDouble.pool).rearm({ ownerUserId: OWNER, actorUserId: OWNER, ruleId: RULE, expectedRevision: 1, authorizationRevision: 7 });
    expect(rearmed.currentRevision).toBe(2);
    const rearmState = rearmDouble.calls.find((call) => call.sql.includes("INSERT INTO alert_rule_states"));
    expect(rearmState?.sql).toContain("extract(epoch FROM statement_timestamp())");
    expect(rearmState?.values).toHaveLength(4);
    expect(rearmDouble.calls.some((call) => call.sql.includes("'rearmed'"))).toBe(true);
  });

  it("keeps reads owner-scoped and hard-bounds rule, event, and outbox lists", async () => {
    const double = poolDouble((sql, values) => {
      if (sql.includes("FROM alert_rules r") && sql.includes("r.id = $2")) return result(values[0] === OWNER ? [ruleRow()] : []);
      return result([]);
    });
    const repository = new AlertRepository(double.pool);
    expect(await repository.get(OWNER, RULE)).toMatchObject({ id: RULE, ownerUserId: OWNER });
    expect(await repository.get(OTHER_OWNER, RULE)).toBeUndefined();
    await repository.list(OWNER, 999);
    await repository.listEvents(OWNER, RULE, 999);
    await repository.listOutbox(OWNER, 999);
    expect(double.calls.filter((call) => call.sql.includes("LIMIT")).every((call) => call.values.includes(200) || call.sql.includes("LIMIT 1"))).toBe(true);
    expect(double.calls.find((call) => call.sql.includes("ORDER BY CASE"))?.sql).toContain("r.status = 'archived'");
    expect(double.calls.filter((call) => call.sql.includes("alert_rule_events") || call.sql.includes("notification_outbox")).every((call) => call.values[0] === OWNER)).toBe(true);
  });

  it("claims due price alerts fairly with skip-locked owner heads and the persisted lease fence", async () => {
    const stateKey = priceThresholdAlertScopeKey(DEFINITION);
    const double = poolDouble((sql, values) => {
      if (!sql.startsWith("WITH owner_heads")) return result([]);
      expect(sql).toContain("DISTINCT ON (r.owner_user_id)");
      expect(sql).toContain("FOR UPDATE OF r SKIP LOCKED");
      expect(sql).not.toContain("owner_user.authorization_revision = r.authorization_revision");
      expect(sql).toContain("authorization_revision = candidate.authorization_revision");
      expect(sql).toContain("NOT EXISTS (SELECT 1 FROM alert_rules leased");
      return result([
        claimedRow({
          authorization_revision: "8",
          lease_owner: String(values[0]),
          lease_token: String(values[1]),
          state_key: stateKey,
          state: { status: "armed", armedAt: 1, initialized: true, eligible: false, lastEvaluatedBarTime: 60_000 },
          state_rule_revision: "1",
          state_revision: "1"
        })
      ]);
    });
    const claim = await new AlertRepository(double.pool).claimDuePriceAlert({ workerId: "price-worker-1", leaseMs: 30_000 });
    expect(claim).toMatchObject({ ownerUserId: OWNER, authorizationRevision: 8, workerId: "price-worker-1", leaseGeneration: 3, stateKey, stateRevision: 1, state: { status: "armed", initialized: true } });
    expect(claim?.leaseToken).toMatch(/^[0-9a-f-]{36}$/);

    const malformed = poolDouble((sql) => (sql.startsWith("WITH owner_heads") ? result([claimedRow({ state_key: stateKey, state_rule_revision: "1", state_revision: "1", state: { status: "armed", armedAt: 1, initialized: true, eligible: false, lastEvaluatedBarTime: 60_000, forged: true } })]) : routine(sql)));
    await expect(new AlertRepository(malformed.pool).claimDuePriceAlert({ workerId: "price-worker-1", leaseMs: 30_000 })).rejects.toThrow("runtime state is malformed");
    expect(malformed.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("commits state, receipt, trigger event, outbox, and in-app delivery in one fenced transaction", async () => {
    const completion = completionInput();
    const double = poolDouble((sql) => {
      if (sql.includes("user_authorization_revision") && sql.includes("FOR UPDATE OF r")) return result([lockedRow()]);
      if (sql.startsWith("SELECT rule_revision, state_revision")) return result([durableStateRow()]);
      if (sql.startsWith("SELECT observation_hash, state_key")) return result([]);
      if (sql.includes("RETURNING state_revision")) return result([{ state_revision: "2" }]);
      if (sql.includes("INSERT INTO alert_rule_events")) return result([{ occurred_at: new Date(NOW) }]);
      if (sql.includes("INSERT INTO notification_outbox")) return result([{ created_at: new Date(NOW) }]);
      if (sql.includes("INSERT INTO notification_deliveries")) return result([{ channel: "in-app", status: "delivered", attempt: 1, max_attempts: 1, run_after: new Date(NOW), delivered_at: new Date(NOW) }]);
      if (sql.includes("UPDATE alert_rules SET status = CASE")) return result([{ id: RULE }]);
      return routine(sql);
    });
    const committed = await new AlertRepository(double.pool).completePriceEvaluation(completion);
    expect(committed).toMatchObject({ outcome: "applied", event: { eventType: "triggered", researchOnly: true, executionPermission: false }, outbox: { channel: "in-app", status: "delivered" } });
    const statements = double.calls.map((call) => call.sql);
    expect(statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining("INSERT INTO alert_evaluation_receipts"),
        expect.stringContaining("UPDATE alert_rule_states"),
        expect.stringContaining("INSERT INTO alert_rule_events"),
        expect.stringContaining("INSERT INTO notification_outbox"),
        expect.stringContaining("INSERT INTO notification_deliveries")
      ])
    );
    const dedup = completion.transition!.transitionKey;
    expect(double.calls.filter((call) => call.sql.includes("alert_rule_events") || call.sql.includes("notification_outbox") || call.sql.includes("notification_deliveries")).every((call) => call.values.includes(dedup))).toBe(true);
    expect(statements.filter((sql) => sql.includes("alert_evaluation_receipts") || sql.includes("alert_rule_states") || sql.includes("UPDATE alert_rules SET status")).every((sql) => !sql.includes("to_timestamp"))).toBe(true);
    const completionUpdate = statements.find((sql) => sql.includes("UPDATE alert_rules SET status")) ?? "";
    expect(completionUpdate).toContain("owner_user.authorization_revision = alert_rules.authorization_revision");
    expect(completionUpdate).toContain("extract(epoch FROM statement_timestamp())");
    expect(completionUpdate).toContain("THEN statement_timestamp()");
    expect(double.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("fails closed on forged completion state, scope, transition identity, and inclusive evidence", async () => {
    const baseline = completionInput();
    const futureArmed = { ...baseline, nextState: { ...baseline.nextState, armedAt: baseline.observation.evaluatedAt + 1 } };
    const noQuery = poolDouble(() => result([]));
    await expect(new AlertRepository(noQuery.pool).completePriceEvaluation(futureArmed)).rejects.toThrow("runtime state is invalid");
    expect(noQuery.calls).toHaveLength(0);

    const wrongObservationKey = `${baseline.observation.subjectKey}:bar:121000`;
    const wrongScope = { ...baseline, observation: { ...baseline.observation, observationKey: wrongObservationKey }, transition: { ...baseline.transition, observationKey: wrongObservationKey } };
    await expect(new AlertRepository(completionBoundaryPool().pool).completePriceEvaluation(wrongScope)).rejects.toBeInstanceOf(AlertEvaluationConflictError);

    const forgedKey = "a".repeat(64);
    const wrongTransition = { ...baseline, nextState: { ...baseline.nextState, triggeredByTransitionKey: forgedKey }, transition: { ...baseline.transition, transitionKey: forgedKey } };
    await expect(new AlertRepository(completionBoundaryPool().pool).completePriceEvaluation(wrongTransition)).rejects.toBeInstanceOf(AlertEvaluationConflictError);

    const nonCrossing = { ...baseline, observation: { ...baseline.observation, close: 99 }, transition: { ...baseline.transition, observedPrice: 99 } };
    await expect(new AlertRepository(completionBoundaryPool().pool).completePriceEvaluation(nonCrossing)).rejects.toBeInstanceOf(AlertEvaluationConflictError);

    const preciseThreshold = "100.0000000000000001";
    const preciseDefinition = { ...DEFINITION, threshold: preciseThreshold };
    const preciseObservation = { ...baseline.observation, close: 100 };
    const preciseTransitionKey = sha256(JSON.stringify(["price-threshold-transition-v1", RULE, 1, DEFINITION.direction, preciseThreshold, preciseObservation.observationKey, preciseObservation.evidenceFingerprint]));
    const roundedThresholdForgery = {
      ...baseline,
      observation: preciseObservation,
      nextState: { ...baseline.nextState, triggeredByTransitionKey: preciseTransitionKey },
      transition: { ...baseline.transition, observedPrice: 100, threshold: preciseThreshold, transitionKey: preciseTransitionKey }
    };
    const preciseBoundary = poolDouble((sql) => {
      if (sql.includes("user_authorization_revision") && sql.includes("FOR UPDATE OF r")) {
        return result([lockedRow({ definition: preciseDefinition, definition_hash: parseAndHashAlertDefinition(preciseDefinition).hash })]);
      }
      if (sql.startsWith("SELECT rule_revision, state_revision")) return result([durableStateRow()]);
      return routine(sql);
    });
    await expect(new AlertRepository(preciseBoundary.pool).completePriceEvaluation(roundedThresholdForgery)).rejects.toBeInstanceOf(AlertEvaluationConflictError);

    const { transition: _ignored, ...withoutTransition } = baseline;
    const wrongEligibility = { ...withoutTransition, nextState: { status: "armed" as const, armedAt: 1, initialized: true, eligible: false, lastEvaluatedBarTime: baseline.observation.candleOpenTime } };
    await expect(new AlertRepository(completionBoundaryPool().pool).completePriceEvaluation(wrongEligibility)).rejects.toBeInstanceOf(AlertEvaluationConflictError);

    const firstArmedAt = 120_001;
    const forgedFirstTrigger = { ...baseline, expectedStateRevision: 0, nextState: { ...baseline.nextState, armedAt: firstArmedAt } };
    const firstStateDouble = poolDouble((sql) => {
      if (sql.includes("user_authorization_revision") && sql.includes("FOR UPDATE OF r")) return result([lockedRow({ revision_created_at: new Date(firstArmedAt) })]);
      if (sql.startsWith("SELECT rule_revision, state_revision")) return result([]);
      if (sql.startsWith("SELECT observation_hash, state_key")) return result([]);
      return routine(sql);
    });
    await expect(new AlertRepository(firstStateDouble.pool).completePriceEvaluation(forgedFirstTrigger)).rejects.toThrow("false-to-true crossing");

    const skippedObservationKey = `${baseline.observation.subjectKey}:bar:180000`;
    const skippedCursor = {
      ...withoutTransition,
      observation: { ...baseline.observation, observationKey: skippedObservationKey, candleOpenTime: 180_000, candleCloseTime: 240_000, evaluatedAt: 240_000, close: 99 },
      nextState: { status: "armed" as const, armedAt: 1, initialized: true, eligible: false, lastEvaluatedBarTime: 180_000 }
    };
    await expect(new AlertRepository(completionBoundaryPool().pool).completePriceEvaluation(skippedCursor)).rejects.toThrow("skipped or replayed");

    await expect(new AlertRepository(completionBoundaryPool().pool).completePriceEvaluation({ ...baseline, expectedStateRevision: 2 })).rejects.toThrow("changed after it was claimed");
  });

  it("accepts an exact lost-response completion replay but rejects authorization drift", async () => {
    const completion = completionInput();
    const replayed = { ...completion, expectedStateRevision: 2 };
    const committedState = durableStateRow({
      state_revision: "2",
      state_status: "eligible",
      initialized: true,
      eligible: true,
      armed: false,
      last_observation_id: completion.observation.observationKey,
      last_observation_hash: completion.observation.evidenceFingerprint,
      last_evaluated_bar_time: String(completion.observation.candleOpenTime),
      state: completion.nextState,
      last_triggered_at: NOW
    });
    const receipt = {
      observation_hash: completion.observation.evidenceFingerprint,
      state_key: completion.observation.subjectKey,
      state_revision_before: "1",
      state_revision_after: "2",
      outcome: "triggered",
      transition_key: completion.transition.transitionKey,
      prior_state_hash: sha256(canonicalJson(durableStateRow().state)),
      committed_state_hash: sha256(canonicalJson(completion.nextState))
    };
    const replayDouble = poolDouble((sql) => {
      if (sql.includes("user_authorization_revision") && sql.includes("FOR UPDATE OF r")) return result([lockedRow()]);
      if (sql.startsWith("SELECT rule_revision, state_revision")) return result([committedState]);
      if (sql.startsWith("SELECT observation_hash, state_key")) return result([receipt]);
      if (sql.includes("next_evaluation_at = CASE WHEN $8")) return result([{ id: RULE }]);
      return routine(sql);
    });
    await expect(new AlertRepository(replayDouble.pool).completePriceEvaluation(replayed)).resolves.toEqual({ outcome: "duplicate" });
    expect(replayDouble.calls.some((call) => call.sql.includes("alert_rule_states SET"))).toBe(false);
    const duplicateRelease = replayDouble.calls.find((call) => call.sql.includes("next_evaluation_at = CASE WHEN $8"))?.sql ?? "";
    expect(duplicateRelease).toContain("lease_expires_at > statement_timestamp()");
    expect(duplicateRelease).toContain("owner_user.authorization_revision = alert_rules.authorization_revision");

    const revokedDouble = poolDouble((sql) => {
      if (sql.includes("user_authorization_revision") && sql.includes("FOR UPDATE OF r")) return result([lockedRow({ user_authorization_revision: "8" })]);
      return routine(sql);
    });
    await expect(new AlertRepository(revokedDouble.pool).completePriceEvaluation(completion)).rejects.toBeInstanceOf(AlertEvaluationConflictError);
    expect(revokedDouble.calls.at(-1)?.sql).toBe("ROLLBACK");

    const midClaimRevocation = poolDouble((sql) => {
      if (sql.includes("user_authorization_revision") && sql.includes("FOR UPDATE OF r")) return result([lockedRow()]);
      if (sql.startsWith("SELECT rule_revision, state_revision")) return result([durableStateRow()]);
      if (sql.startsWith("SELECT observation_hash, state_key")) return result([]);
      if (sql.includes("RETURNING state_revision")) return result([{ state_revision: "2" }]);
      if (sql.includes("INSERT INTO alert_rule_events")) return result([{ occurred_at: new Date(NOW) }]);
      if (sql.includes("INSERT INTO notification_outbox")) return result([{ created_at: new Date(NOW) }]);
      if (sql.includes("INSERT INTO notification_deliveries")) return result([{ channel: "in-app", status: "delivered", attempt: 1, max_attempts: 1, run_after: new Date(NOW), delivered_at: new Date(NOW) }]);
      if (sql.includes("UPDATE alert_rules SET status = CASE")) return result([]);
      return routine(sql);
    });
    await expect(new AlertRepository(midClaimRevocation.pool).completePriceEvaluation(completion)).rejects.toBeInstanceOf(AlertClaimLostError);
    expect(midClaimRevocation.calls.at(-1)?.sql).toBe("ROLLBACK");

    const expiredDouble = poolDouble((sql) => {
      if (sql.includes("user_authorization_revision") && sql.includes("FOR UPDATE OF r")) return result([lockedRow({ lease_valid: false })]);
      return routine(sql);
    });
    await expect(new AlertRepository(expiredDouble.pool).completePriceEvaluation(completion)).rejects.toBeInstanceOf(AlertClaimLostError);
    expect(expiredDouble.calls.find((call) => call.sql.includes("FOR UPDATE OF r"))?.sql).toContain("lease_expires_at > clock_timestamp()");

    const malformedDouble = poolDouble((sql) => {
      if (sql.includes("user_authorization_revision") && sql.includes("FOR UPDATE OF r")) return result([lockedRow({ definition: { ...DEFINITION, unexpected: true } })]);
      return routine(sql);
    });
    await expect(new AlertRepository(malformedDouble.pool).completePriceEvaluation(completion)).rejects.toThrow("missing or unknown fields");
    expect(malformedDouble.calls.some((call) => call.sql.includes("alert_evaluation_receipts"))).toBe(false);
  });

  it("backs unavailable evaluations off behind the complete claim fence and recovers expired leases", async () => {
    const deferred = poolDouble((sql) => (sql.startsWith("UPDATE alert_rules rule SET next_evaluation_at") ? result([{ id: RULE }]) : result([])));
    await expect(new AlertRepository(deferred.pool).deferPriceEvaluation({ ownerUserId: OWNER, ruleId: RULE, expectedRevision: 1, authorizationRevision: 7, workerId: "price-worker-1", leaseToken: LEASE, leaseGeneration: 3 })).resolves.toBe(true);
    const deferSql = deferred.calls[0]?.sql ?? "";
    expect(deferSql).toContain("lease_expires_at > statement_timestamp()");
    expect(deferSql).toContain("owner_user.authorization_revision = rule.authorization_revision");
    expect(deferSql).toContain("evaluation_failure_count = 0");
    expect(deferSql).toContain("last_success_at = statement_timestamp()");
    expect(deferSql).toContain("last_error_code = NULL");
    expect(deferSql).not.toContain("evaluation_failure_count + 1");
    expect(deferred.calls.some((call) => call.sql.includes("alert_rule_events"))).toBe(false);

    await expect(new AlertRepository(deferred.pool).deferPriceEvaluation({ ownerUserId: OWNER, ruleId: RULE, expectedRevision: 1, authorizationRevision: 7, workerId: "price-worker-1", leaseToken: LEASE, leaseGeneration: 3, retryAfterSeconds: 86_400 })).resolves.toBe(true);
    expect(deferred.calls.at(-1)?.values[7]).toBe(86_400);
    await expect(new AlertRepository(deferred.pool).deferPriceEvaluation({ ownerUserId: OWNER, ruleId: RULE, expectedRevision: 1, authorizationRevision: 7, workerId: "price-worker-1", leaseToken: LEASE, leaseGeneration: 3, retryAfterSeconds: 86_401 })).rejects.toThrow("retry delay is invalid");

    const lost = poolDouble(() => result([]));
    await expect(new AlertRepository(lost.pool).deferPriceEvaluation({ ownerUserId: OWNER, ruleId: RULE, expectedRevision: 1, authorizationRevision: 7, workerId: "price-worker-1", leaseToken: LEASE, leaseGeneration: 3 })).resolves.toBe(false);

    const unavailable = poolDouble((sql) => {
      if (sql.startsWith("UPDATE alert_rules rule SET")) return result([{ evaluation_failure_count: 2 }]);
      return routine(sql);
    });
    const repository = new AlertRepository(unavailable.pool);
    await expect(repository.failPriceEvaluation({ ownerUserId: OWNER, ruleId: RULE, expectedRevision: 1, authorizationRevision: 7, workerId: "price-worker-1", leaseToken: LEASE, leaseGeneration: 3, stateKey: priceThresholdAlertScopeKey(DEFINITION), errorCode: "stale_candle_window" })).resolves.toBe(true);
    await expect(repository.failPriceEvaluation({ ownerUserId: OWNER, ruleId: RULE, expectedRevision: 1, authorizationRevision: 7, workerId: "price-worker-1", leaseToken: LEASE, leaseGeneration: 4, stateKey: priceThresholdAlertScopeKey(DEFINITION), errorCode: "stale_candle_window" })).resolves.toBe(true);
    const backoffSql = unavailable.calls.find((call) => call.sql.startsWith("UPDATE alert_rules rule SET"))?.sql ?? "";
    expect(backoffSql).toContain("power(2");
    expect(backoffSql).toContain("owner_user.authorization_revision = rule.authorization_revision");
    const eventCalls = unavailable.calls.filter((call) => call.sql.includes("'evaluation_error'"));
    expect(eventCalls).toHaveLength(2);
    expect(eventCalls[0]?.values[5]).toBe(eventCalls[1]?.values[5]);

    const expired = poolDouble((sql) => (sql.startsWith("UPDATE alert_rules SET lease_owner") ? { rows: [{ id: RULE }, { id: "55555555-5555-4555-8555-555555555555" }], rowCount: 2 } : result([])));
    await expect(new AlertRepository(expired.pool).recoverExpiredLeases()).resolves.toEqual({ recovered: 2 });
    expect(expired.calls[0]?.sql).toContain("lease_expires_at <= clock_timestamp()");
  });

  it("does not provide an admin/actor bypass for owner mutations", async () => {
    const double = poolDouble(() => result([]));
    await expect(new AlertRepository(double.pool).create(createInput({ actorUserId: OTHER_OWNER }))).rejects.toThrow("only be mutated by their owner");
    expect(double.calls).toHaveLength(0);
  });
});

function poolDouble(handler: QueryHandler): { pool: Pool; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const query = async (query: unknown, values: readonly unknown[] = []) => {
    const sql = typeof query === "string" ? query.trim() : String(query);
    calls.push({ sql, values });
    return handler(sql, values);
  };
  const client = { query, release: () => undefined };
  return { pool: { query, connect: async () => client } as unknown as Pool, calls };
}

function completionBoundaryPool(): { pool: Pool; calls: QueryCall[] } {
  return poolDouble((sql) => {
    if (sql.includes("user_authorization_revision") && sql.includes("FOR UPDATE OF r")) return result([lockedRow()]);
    if (sql.startsWith("SELECT rule_revision, state_revision")) return result([durableStateRow()]);
    return routine(sql);
  });
}

function routine(sql: string): QueryResult {
  if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("pg_advisory_xact_lock") || sql.startsWith("INSERT") || sql.startsWith("UPDATE")) return result([]);
  if (sql.startsWith("SELECT status, must_change_password")) return result([{ status: "active", must_change_password: false, authorization_revision: "7" }]);
  return result([]);
}

function result(rows: any[]): QueryResult {
  return { rows, rowCount: rows.length };
}

function createInput(overrides: Record<string, unknown> = {}) {
  return { ownerUserId: OWNER, actorUserId: OWNER, authorizationRevision: 7, clientId: "mobile-price-1", definition: DEFINITION, ...overrides } as any;
}

function ruleRow(overrides: Partial<AlertRuleRow> = {}): AlertRuleRow {
  return {
    id: RULE,
    owner_user_id: OWNER,
    client_id: "mobile-price-1",
    status: "active",
    current_revision: "1",
    authorization_revision: "7",
    evaluation_interval_seconds: 60,
    next_evaluation_at: NOW,
    evaluation_failure_count: 0,
    last_evaluated_at: null,
    last_success_at: null,
    last_error_code: null,
    last_error_at: null,
    created_at: NOW,
    updated_at: NOW,
    archived_at: null,
    rule_kind: "price-threshold",
    definition: DEFINITION,
    definition_hash: DEFINITION_HASH,
    revision_created_at: NOW,
    ...overrides
  };
}

function claimedRow(overrides: Record<string, unknown> = {}) {
  return { ...ruleRow(), lease_owner: "price-worker-1", lease_token: LEASE, lease_generation: "3", lease_expires_at: FUTURE, state_key: null, state: null, state_rule_revision: null, state_revision: null, ...overrides };
}

function lockedRow(overrides: Partial<LockedAlertRuleRow> = {}): LockedAlertRuleRow {
  return { ...ruleRow(), user_status: "active", user_must_change_password: false, user_authorization_revision: "7", lease_owner: "price-worker-1", lease_token: LEASE, lease_generation: "3", lease_expires_at: FUTURE, lease_valid: true, database_now_ms: new Date(NOW).getTime(), ...overrides };
}

function durableStateRow(overrides: Record<string, unknown> = {}) {
  const stateKey = priceThresholdAlertScopeKey(DEFINITION);
  return {
    rule_revision: "1",
    state_revision: "1",
    state_status: "ineligible",
    initialized: true,
    eligible: false,
    armed: true,
    last_observation_id: `${stateKey}:bar:60000`,
    last_observation_hash: sha256("prior-evidence"),
    last_evaluated_bar_time: "60000",
    state: { status: "armed", armedAt: 1, initialized: true, eligible: false, lastEvaluatedBarTime: 60_000 },
    last_triggered_at: null,
    ...overrides
  };
}

function completionInput() {
  const subjectKey = priceThresholdAlertScopeKey(DEFINITION);
  const observationKey = `${subjectKey}:bar:120000`;
  const evidenceFingerprint = sha256("evidence");
  const transitionKey = sha256(JSON.stringify(["price-threshold-transition-v1", RULE, 1, DEFINITION.direction, DEFINITION.threshold, observationKey, evidenceFingerprint]));
  return {
    ownerUserId: OWNER,
    ruleId: RULE,
    expectedRevision: 1,
    authorizationRevision: 7,
    workerId: "price-worker-1",
    leaseToken: LEASE,
    leaseGeneration: 3,
    expectedStateRevision: 1,
    observation: { schemaVersion: PRICE_THRESHOLD_OBSERVATION_SCHEMA_V1, subjectKey, observationKey, evidenceFingerprint, candleOpenTime: 120_000, candleCloseTime: 180_000, evaluatedAt: 180_000, close: 101, researchOnly: true, executionPermission: false },
    nextState: { status: "triggered", armedAt: 1, initialized: true, eligible: true, lastEvaluatedBarTime: 120_000, triggeredByTransitionKey: transitionKey },
    transition: { kind: "price-threshold-triggered", ruleId: RULE, ruleRevision: 1, from: "armed", to: "triggered", subjectKey, transitionKey, observationKey, evidenceFingerprint, occurredAt: 180_000, observedPrice: 101, threshold: "100", direction: "above", researchOnly: true, executionPermission: false }
  } as const;
}
