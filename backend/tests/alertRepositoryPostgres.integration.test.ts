import { createHash, randomUUID } from "node:crypto";
import type { PriceThresholdAlertDefinitionV1 } from "@saltanatbotv2/contracts";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AlertClaimLostError, AlertEvaluationConflictError, AlertNotFoundError, AlertQuotaError, AlertRepository } from "../src/alerts/repository.js";
import { priceThresholdAlertScopeKey } from "../src/alerts/priceEvaluator.js";
import type { ClaimedPriceAlertRule, CompletePriceEvaluationInput } from "../src/alerts/repositoryTypes.js";
import { migrateDatabase } from "../src/database/migrations.js";
import { assertIsolatedTestDatabase } from "./support/postgresTestDatabase.js";

const connectionString = process.env.ALERTS_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const OWNER_A = "00000000-0000-4000-8000-000000000091";
const OWNER_B = "00000000-0000-4000-8000-000000000092";
const ADMIN = "00000000-0000-4000-8000-000000000093";
const PASSWORD_HASH = "test-auth-hash-placeholder";
const MINUTE = 60_000;
let pool: Pool;
let repository: AlertRepository;

describePostgres("AlertRepository against isolated PostgreSQL", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 8 });
    await assertIsolatedTestDatabase(pool, "ALERTS_TEST_DATABASE_URL");
    await migrateDatabase(pool);
    await pool.query(
      `INSERT INTO users (
         id, login, login_normalized, password_hash, status, app_role
       ) VALUES
         ($1, 'repository-owner-a', 'repository-owner-a', $4, 'active', 'user'),
         ($2, 'repository-owner-b', 'repository-owner-b', $4, 'active', 'user'),
         ($3, 'repository-admin', 'repository-admin', $4, 'active', 'admin')
       ON CONFLICT (id) DO UPDATE SET
         status = 'active', must_change_password = FALSE,
         authorization_revision = 1, app_role = EXCLUDED.app_role`,
      [OWNER_A, OWNER_B, ADMIN, PASSWORD_HASH]
    );
    repository = new AlertRepository(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE alert_event_sequences, alert_rules, notification_bindings, alert_evaluation_receipts CASCADE");
    await pool.query(
      `UPDATE users SET status = 'active', must_change_password = FALSE,
         authorization_revision = 1
       WHERE id = ANY($1::uuid[])`,
      [[OWNER_A, OWNER_B, ADMIN]]
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query("TRUNCATE alert_event_sequences, alert_rules, notification_bindings, alert_evaluation_receipts CASCADE").catch(() => undefined);
    await pool.end();
  });

  it("isolates create/list/get by owner and never treats an admin as the owner actor", async () => {
    const first = await createRule(OWNER_A, "owner-a:first");
    const second = await createRule(OWNER_B, "owner-b:first");

    expect((await repository.list(OWNER_A)).map(({ id }) => id)).toEqual([first.id]);
    expect((await repository.list(OWNER_B)).map(({ id }) => id)).toEqual([second.id]);
    expect(await repository.get(OWNER_A, second.id)).toBeUndefined();
    expect(await repository.get(ADMIN, first.id)).toBeUndefined();

    await expect(
      repository.create({
        ownerUserId: OWNER_A,
        actorUserId: ADMIN,
        authorizationRevision: 1,
        clientId: "admin:create-bypass",
        definition: definition({ name: "Admin bypass" })
      })
    ).rejects.toBeInstanceOf(AlertNotFoundError);
    await expect(
      repository.update({
        ownerUserId: OWNER_A,
        actorUserId: ADMIN,
        ruleId: first.id,
        expectedRevision: first.currentRevision,
        authorizationRevision: 1,
        definition: definition({ name: "Admin update bypass" })
      })
    ).rejects.toBeInstanceOf(AlertNotFoundError);
  });

  it("serializes disabled-to-enabled quota decisions with the owner advisory lock", async () => {
    await seedActiveRules(OWNER_A, 99);
    const first = await createRule(OWNER_A, "quota:disabled-a", {
      name: "Quota disabled A",
      enabled: false
    });
    const second = await createRule(OWNER_A, "quota:disabled-b", {
      name: "Quota disabled B",
      enabled: false
    });

    const outcomes = await Promise.allSettled([
      repository.update({
        ownerUserId: OWNER_A,
        actorUserId: OWNER_A,
        ruleId: first.id,
        expectedRevision: 1,
        authorizationRevision: 1,
        definition: definition({ name: "Quota disabled A", enabled: true })
      }),
      repository.update({
        ownerUserId: OWNER_A,
        actorUserId: OWNER_A,
        ruleId: second.id,
        expectedRevision: 1,
        authorizationRevision: 1,
        definition: definition({ name: "Quota disabled B", enabled: true })
      })
    ]);
    const fulfilled = outcomes.filter((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<AlertRepository["update"]>>> => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value).toMatchObject({ status: "active", currentRevision: 2 });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(AlertQuotaError);
    const proof = await pool.query<{ active: string; disabled: string }>(
      `SELECT count(*) FILTER (WHERE status = 'active')::text AS active,
         count(*) FILTER (WHERE status = 'disabled')::text AS disabled
       FROM alert_rules WHERE owner_user_id = $1`,
      [OWNER_A]
    );
    expect(proof.rows[0]).toEqual({ active: "100", disabled: "1" });
  });

  it("claims one due rule per owner fairly while another rule for that owner is leased", async () => {
    const ownerAFirst = await createRule(OWNER_A, "fair:a-first");
    await createRule(OWNER_A, "fair:a-second");
    const ownerBFirst = await createRule(OWNER_B, "fair:b-first");
    await pool.query(
      `UPDATE alert_rules SET next_evaluation_at = CASE id
         WHEN $1 THEN clock_timestamp() - interval '3 minutes'
         WHEN $2 THEN clock_timestamp() - interval '1 minute'
         ELSE clock_timestamp() - interval '2 minutes' END
       WHERE owner_user_id = ANY($3::uuid[])`,
      [ownerAFirst.id, ownerBFirst.id, [OWNER_A, OWNER_B]]
    );

    const firstClaim = await claim("repository-worker:first");
    const secondClaim = await claim("repository-worker:second");

    expect(firstClaim).toMatchObject({ id: ownerAFirst.id, ownerUserId: OWNER_A });
    expect(secondClaim).toMatchObject({ id: ownerBFirst.id, ownerUserId: OWNER_B });
    expect(await repository.claimDuePriceAlert({ workerId: "repository-worker:third", leaseMs: 30_000 })).toBeUndefined();
  });

  it("commits non-trigger state, then atomically persists exactly one false-to-true notification", async () => {
    const rule = await createRule(OWNER_A, "lifecycle:crossing");
    await seedInitializedState(OWNER_A, rule.id, rule.currentRevision, rule.definition);
    const firstClaim = await claim("repository-worker:lifecycle-1");
    const firstBar = firstBarAfterArming(firstClaim);
    const below = completion(firstClaim, firstBar, 100, false);

    await expect(repository.completePriceEvaluation(below)).resolves.toEqual({
      outcome: "applied"
    });
    expect(await stateProof(rule.id)).toMatchObject({
      state_status: "ineligible",
      initialized: true,
      eligible: false,
      armed: true
    });

    await makeDue(rule.id);
    const secondClaim = await claim("repository-worker:lifecycle-2");
    const crossed = completion(secondClaim, firstBar + MINUTE, 101, true);
    const result = await repository.completePriceEvaluation(crossed);

    expect(result).toMatchObject({
      outcome: "applied",
      event: {
        ruleId: rule.id,
        eventType: "triggered",
        researchOnly: true,
        executionPermission: false
      },
      outbox: {
        channel: "in-app",
        status: "delivered",
        researchOnly: true,
        executionPermission: false
      }
    });
    expect(await repository.get(OWNER_A, rule.id)).toMatchObject({
      status: "disabled",
      evaluationFailureCount: 0
    });
    expect(await stateProof(rule.id)).toMatchObject({
      state_status: "eligible",
      initialized: true,
      eligible: true,
      armed: false
    });
    expect(await graphCounts(OWNER_A, rule.id)).toEqual({
      receipts: "2",
      events: "1",
      outbox: "1",
      deliveries: "1"
    });
    expect(await repository.listEvents(OWNER_A, rule.id)).toHaveLength(1);
    expect(await repository.listOutbox(OWNER_A)).toHaveLength(1);
  });

  it("deduplicates replayed evidence after a worker restart and releases the new lease", async () => {
    const rule = await createRule(OWNER_A, "restart:deduplicate", {
      threshold: "200"
    });
    await seedInitializedState(OWNER_A, rule.id, rule.currentRevision, rule.definition);
    const firstClaim = await claim("repository-worker:before-restart");
    const firstBar = firstBarAfterArming(firstClaim);
    const evaluated = completion(firstClaim, firstBar, 100, false);
    await repository.completePriceEvaluation(evaluated);

    await makeDue(rule.id);
    const restartedClaim = await claim("repository-worker:after-restart");
    const replay = completion(restartedClaim, firstBar, 100, false);
    await expect(
      repository.completePriceEvaluation({
        ...replay,
        nextState: { ...replay.nextState, eligible: true }
      })
    ).rejects.toThrow("exactly match the committed evaluation outcome");
    await expect(repository.completePriceEvaluation(replay)).resolves.toEqual({
      outcome: "duplicate"
    });

    const proof = await pool.query<{
      lease_owner: string | null;
      status: string;
      receipts: string;
      states: string;
    }>(
      `SELECT rule.lease_owner, rule.status,
         (SELECT count(*)::text FROM alert_evaluation_receipts receipt
           WHERE receipt.owner_user_id = rule.owner_user_id) AS receipts,
         (SELECT count(*)::text FROM alert_rule_states state
           WHERE state.owner_user_id = rule.owner_user_id AND state.alert_rule_id = rule.id) AS states
       FROM alert_rules rule WHERE rule.owner_user_id = $1 AND rule.id = $2`,
      [OWNER_A, rule.id]
    );
    expect(proof.rows[0]).toEqual({
      lease_owner: null,
      status: "active",
      receipts: "1",
      states: "1"
    });
    expect(await graphCounts(OWNER_A, rule.id)).toEqual({
      receipts: "1",
      events: "0",
      outbox: "0",
      deliveries: "0"
    });
  });

  it("clears healthy deferrals, records unavailable backoff, and rejects stale fences", async () => {
    const deferredRule = await createRule(OWNER_A, "fence:defer");
    const deferredClaim = await claim("repository-worker:defer");
    await expect(repository.deferPriceEvaluation(leaseFence(deferredClaim))).resolves.toBe(true);
    await expect(repository.deferPriceEvaluation(leaseFence(deferredClaim))).resolves.toBe(false);
    expect(await ruleHealth(deferredRule.id)).toMatchObject({
      lease_owner: null,
      evaluation_failure_count: 0,
      last_error_code: null,
      has_success: true
    });

    const failedRule = await createRule(OWNER_B, "fence:unavailable");
    await makeDue(failedRule.id);
    const failedClaim = await claim("repository-worker:unavailable");
    await expect(
      repository.failPriceEvaluation({
        ...leaseFence(failedClaim),
        stateKey: failedClaim.stateKey,
        errorCode: "public_candles_unavailable"
      })
    ).resolves.toBe(true);
    await expect(
      repository.failPriceEvaluation({
        ...leaseFence(failedClaim),
        stateKey: failedClaim.stateKey,
        errorCode: "public_candles_unavailable"
      })
    ).resolves.toBe(false);
    expect(await ruleHealth(failedRule.id)).toMatchObject({
      lease_owner: null,
      evaluation_failure_count: 1,
      last_error_code: "public_candles_unavailable",
      has_backoff: true
    });
    expect(await repository.listEvents(OWNER_B, failedRule.id)).toMatchObject([{ eventType: "error", researchOnly: true, executionPermission: false }]);
  });

  it("refreshes authorization at claim time and fails closed after auth changes or lease expiry", async () => {
    const authRule = await createRule(OWNER_A, "fence:authorization");
    await pool.query("UPDATE users SET authorization_revision = 2 WHERE id = $1", [OWNER_A]);
    const authClaim = await claim("repository-worker:authorization");
    expect(authClaim).toMatchObject({
      id: authRule.id,
      authorizationRevision: 2
    });

    await pool.query("UPDATE users SET authorization_revision = 3 WHERE id = $1", [OWNER_A]);
    await expect(repository.completePriceEvaluation(completion(authClaim, firstBarAfterArming(authClaim), 100, false))).rejects.toBeInstanceOf(AlertEvaluationConflictError);
    expect(await graphCounts(OWNER_A, authRule.id)).toEqual({
      receipts: "0",
      events: "0",
      outbox: "0",
      deliveries: "0"
    });

    const expiringRule = await createRule(OWNER_B, "fence:expiry");
    await makeDue(expiringRule.id);
    const expiredClaim = await claim("repository-worker:expiry");
    await pool.query(
      `UPDATE alert_rules SET lease_acquired_at = clock_timestamp() - interval '2 seconds',
         lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE owner_user_id = $1 AND id = $2`,
      [OWNER_B, expiringRule.id]
    );
    await expect(repository.completePriceEvaluation(completion(expiredClaim, firstBarAfterArming(expiredClaim), 100, false))).rejects.toBeInstanceOf(AlertClaimLostError);
    expect(await graphCounts(OWNER_B, expiringRule.id)).toEqual({
      receipts: "0",
      events: "0",
      outbox: "0",
      deliveries: "0"
    });
  });

  it("rejects a forged first trigger, skipped cursor, and stale durable state fence", async () => {
    const firstRule = await createRule(OWNER_A, "fence:forged-first-trigger");
    await seedUninitializedClosedState(OWNER_A, firstRule.id, firstRule.currentRevision, firstRule.definition);
    const firstClaim = await claim("repository-worker:forged-first");
    await expect(
      repository.completePriceEvaluation(completion(firstClaim, firstBarAfterArming(firstClaim), 101, true))
    ).rejects.toThrow("false-to-true crossing");
    await expect(
      repository.failPriceEvaluation({
        ...leaseFence(firstClaim),
        stateKey: firstClaim.stateKey,
        errorCode: "test_rejected_forgery"
      })
    ).resolves.toBe(true);

    const cursorRule = await createRule(OWNER_B, "fence:skipped-cursor");
    await seedInitializedState(OWNER_B, cursorRule.id, cursorRule.currentRevision, cursorRule.definition);
    await makeDue(cursorRule.id);
    const cursorClaim = await claim("repository-worker:cursor-fence");
    const skippedBar = cursorClaim.state.lastEvaluatedBarTime! + 2 * MINUTE;
    await expect(repository.completePriceEvaluation(completion(cursorClaim, skippedBar, 100, false))).rejects.toThrow("skipped or replayed");
    await expect(
      repository.completePriceEvaluation({
        ...completion(cursorClaim, cursorClaim.state.lastEvaluatedBarTime! + MINUTE, 100, false),
        expectedStateRevision: cursorClaim.stateRevision + 1
      })
    ).rejects.toThrow("changed after it was claimed");
  });

  it("scopes receipt identity by immutable rule revision", async () => {
    const rule = await createRule(OWNER_A, "receipt:revision-scope");
    const updated = await repository.update({
      ownerUserId: OWNER_A,
      actorUserId: OWNER_A,
      ruleId: rule.id,
      expectedRevision: 1,
      authorizationRevision: 1,
      definition: definition({ name: "Receipt revision two" })
    });
    const scope = priceThresholdAlertScopeKey(updated.definition as PriceThresholdAlertDefinitionV1);
    const observationId = `${scope}:bar:60000`;
    const insert = async (revision: number, fingerprint: string) =>
      pool.query(
        `INSERT INTO alert_evaluation_receipts (
           owner_user_id, producer, alert_rule_id, rule_revision, state_key, observation_id,
           observation_hash, state_revision_before, state_revision_after, outcome,
           prior_state_hash, committed_state_hash, evaluated_at
         ) VALUES ($1,'price-alert-worker',$2,$3,$4,$5,$6,0,1,'armed',$7,$8,statement_timestamp())`,
        [OWNER_A, rule.id, revision, scope, observationId, fingerprint, hash(`prior:${revision}`), hash(`committed:${revision}`)]
      );
    await insert(1, hash("revision-one-evidence"));
    await insert(2, hash("revision-two-evidence"));
    const proof = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM alert_evaluation_receipts
       WHERE owner_user_id = $1 AND alert_rule_id = $2 AND observation_id = $3`,
      [OWNER_A, rule.id, observationId]
    );
    expect(proof.rows[0]?.count).toBe("2");
  });

  it("derives rearm armedAt from the PostgreSQL state-write clock", async () => {
    const rule = await createRule(OWNER_A, "rearm:database-clock");
    const rearmed = await repository.rearm({
      ownerUserId: OWNER_A,
      actorUserId: OWNER_A,
      ruleId: rule.id,
      expectedRevision: rule.currentRevision,
      authorizationRevision: 1
    });
    const proof = await pool.query<{ armed_at: string; write_clock_ms: string; rule_revision: string }>(
      `SELECT state->>'armedAt' AS armed_at,
         floor(extract(epoch FROM last_evaluated_at) * 1000)::bigint::text AS write_clock_ms,
         rule_revision::text AS rule_revision
       FROM alert_rule_states WHERE owner_user_id = $1 AND alert_rule_id = $2`,
      [OWNER_A, rule.id]
    );
    expect(proof.rows[0]).toEqual({
      armed_at: proof.rows[0]?.write_clock_ms,
      write_clock_ms: proof.rows[0]?.write_clock_ms,
      rule_revision: String(rearmed.currentRevision)
    });
  });
});

function definition(override: Partial<PriceThresholdAlertDefinitionV1> = {}): PriceThresholdAlertDefinitionV1 {
  return {
    schemaVersion: "alert-rule-v1",
    kind: "price-threshold",
    name: "Repository price alert",
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
    threshold: "101",
    crossing: "inclusive",
    repeat: "once-until-rearmed",
    ...override
  };
}

async function createRule(ownerUserId: string, clientId: string, override: Partial<PriceThresholdAlertDefinitionV1> = {}) {
  return repository.create({
    ownerUserId,
    actorUserId: ownerUserId,
    authorizationRevision: 1,
    clientId,
    definition: definition(override)
  });
}

async function claim(workerId: string): Promise<ClaimedPriceAlertRule> {
  const claimed = await repository.claimDuePriceAlert({ workerId, leaseMs: 30_000 });
  if (!claimed) throw new Error(`Expected ${workerId} to claim a due alert.`);
  return claimed;
}

function leaseFence(claimed: ClaimedPriceAlertRule) {
  return {
    ownerUserId: claimed.ownerUserId,
    ruleId: claimed.id,
    expectedRevision: claimed.currentRevision,
    authorizationRevision: claimed.authorizationRevision,
    workerId: claimed.workerId,
    leaseToken: claimed.leaseToken,
    leaseGeneration: claimed.leaseGeneration
  };
}

function firstBarAfterArming(claimed: ClaimedPriceAlertRule): number {
  return claimed.state.lastEvaluatedBarTime === undefined
    ? Math.floor(claimed.state.armedAt / MINUTE) * MINUTE
    : claimed.state.lastEvaluatedBarTime + MINUTE;
}

function completion(claimed: ClaimedPriceAlertRule, candleOpenTime: number, close: number, triggered: boolean): CompletePriceEvaluationInput {
  const subjectKey = priceThresholdAlertScopeKey(claimed.definition);
  const observationKey = `${subjectKey}:bar:${candleOpenTime}`;
  const evidenceFingerprint = hash(JSON.stringify(["repository-observation-v1", claimed.id, observationKey, close]));
  const observation = {
    schemaVersion: "price-threshold-observation-v1" as const,
    subjectKey,
    observationKey,
    evidenceFingerprint,
    candleOpenTime,
    candleCloseTime: candleOpenTime + MINUTE,
    evaluatedAt: candleOpenTime + MINUTE,
    close,
    researchOnly: true as const,
    executionPermission: false as const
  };
  const transitionKey = hash(JSON.stringify(["price-threshold-transition-v1", claimed.id, claimed.currentRevision, claimed.definition.direction, claimed.definition.threshold, observationKey, evidenceFingerprint]));
  return {
    ...leaseFence(claimed),
    expectedStateRevision: claimed.stateRevision,
    observation,
    nextState: triggered
      ? {
          status: "triggered",
          armedAt: claimed.state.armedAt,
          initialized: true,
          eligible: true,
          lastEvaluatedBarTime: candleOpenTime,
          triggeredByTransitionKey: transitionKey
        }
      : {
          status: "armed",
          armedAt: claimed.state.armedAt,
          initialized: true,
          eligible: false,
          lastEvaluatedBarTime: candleOpenTime
        },
    ...(triggered
      ? {
          transition: {
            kind: "price-threshold-triggered" as const,
            ruleId: claimed.id,
            ruleRevision: claimed.currentRevision,
            from: "armed" as const,
            to: "triggered" as const,
            subjectKey,
            transitionKey,
            observationKey,
            evidenceFingerprint,
            occurredAt: candleOpenTime + MINUTE,
            observedPrice: close,
            threshold: claimed.definition.threshold,
            direction: claimed.definition.direction,
            researchOnly: true as const,
            executionPermission: false as const
          }
        }
      : {})
  };
}

async function seedInitializedState(ownerUserId: string, ruleId: string, ruleRevision: number, document: unknown): Promise<void> {
  const parsed = document as PriceThresholdAlertDefinitionV1;
  const stateKey = priceThresholdAlertScopeKey(parsed);
  const clock = await pool.query<{ now_ms: string }>("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS now_ms");
  const latestClosedOpen = Math.floor(Number(clock.rows[0]!.now_ms) / MINUTE) * MINUTE - MINUTE;
  const cursor = latestClosedOpen - 2 * MINUTE;
  const armedAt = cursor;
  const observationId = `${stateKey}:bar:${cursor}`;
  await pool.query(
    `INSERT INTO alert_rule_states (
       owner_user_id, alert_rule_id, state_key, rule_revision, state_revision,
       state_status, initialized, eligible, armed, last_observation_id,
       last_observation_hash, last_evaluated_bar_time, state, last_evaluated_at
     ) VALUES ($1,$2,$3,$4,1,'ineligible',TRUE,FALSE,TRUE,$5,$6,$7,$8::jsonb,statement_timestamp())`,
    [ownerUserId, ruleId, stateKey, ruleRevision, observationId, hash(`seed:${ruleId}:${cursor}`), cursor, JSON.stringify({ status: "armed", armedAt, initialized: true, eligible: false, lastEvaluatedBarTime: cursor })]
  );
}

async function seedUninitializedClosedState(ownerUserId: string, ruleId: string, ruleRevision: number, document: unknown): Promise<void> {
  const parsed = document as PriceThresholdAlertDefinitionV1;
  const stateKey = priceThresholdAlertScopeKey(parsed);
  const clock = await pool.query<{ now_ms: string }>("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS now_ms");
  const armedAt = Math.floor(Number(clock.rows[0]!.now_ms) / MINUTE) * MINUTE - MINUTE;
  await pool.query(
    `INSERT INTO alert_rule_states (
       owner_user_id, alert_rule_id, state_key, rule_revision, state_revision,
       state_status, initialized, eligible, armed, state, last_evaluated_at
     ) VALUES ($1,$2,$3,$4,1,'ineligible',FALSE,FALSE,TRUE,$5::jsonb,statement_timestamp())`,
    [ownerUserId, ruleId, stateKey, ruleRevision, JSON.stringify({ status: "armed", armedAt, initialized: false, eligible: false })]
  );
}

async function makeDue(ruleId: string): Promise<void> {
  await pool.query(
    `UPDATE alert_rules SET next_evaluation_at = clock_timestamp() - interval '1 second'
     WHERE id = $1`,
    [ruleId]
  );
}

async function seedActiveRules(ownerUserId: string, count: number): Promise<void> {
  const ids = Array.from({ length: count }, () => randomUUID());
  const clientIds = ids.map((_, index) => `quota:seed:${index}`);
  const document = definition({ name: "Quota seed" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO alert_rules (
         id, owner_user_id, client_id, rule_kind, status, authorization_revision,
         next_evaluation_at, created_by_user_id, updated_by_user_id
       ) SELECT seed.id, $1, seed.client_id, 'price-threshold', 'active', 1,
           clock_timestamp() + interval '1 day', $1, $1
         FROM unnest($2::uuid[], $3::text[]) AS seed(id, client_id)`,
      [ownerUserId, ids, clientIds]
    );
    await client.query(
      `INSERT INTO alert_rule_revisions (
         owner_user_id, alert_rule_id, revision, schema_version, rule_kind,
         definition, definition_hash, actor_user_id
       ) SELECT $1, seed.id, 1, 'alert-rule-v1', 'price-threshold',
           $3::jsonb, $4, $1 FROM unnest($2::uuid[]) AS seed(id)`,
      [ownerUserId, ids, JSON.stringify(document), hash(JSON.stringify(document))]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function graphCounts(ownerUserId: string, ruleId: string) {
  const result = await pool.query<{
    receipts: string;
    events: string;
    outbox: string;
    deliveries: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM alert_evaluation_receipts WHERE owner_user_id = $1) AS receipts,
       (SELECT count(*)::text FROM alert_rule_events WHERE owner_user_id = $1 AND alert_rule_id = $2) AS events,
       (SELECT count(*)::text FROM notification_outbox WHERE owner_user_id = $1 AND alert_rule_id = $2) AS outbox,
       (SELECT count(*)::text FROM notification_deliveries delivery
          INNER JOIN notification_outbox outbox ON outbox.owner_user_id = delivery.owner_user_id AND outbox.id = delivery.outbox_id
          WHERE delivery.owner_user_id = $1 AND outbox.alert_rule_id = $2) AS deliveries`,
    [ownerUserId, ruleId]
  );
  return result.rows[0];
}

async function stateProof(ruleId: string) {
  const result = await pool.query<{
    state_status: string;
    initialized: boolean;
    eligible: boolean;
    armed: boolean;
  }>(
    `SELECT state_status, initialized, eligible, armed FROM alert_rule_states
     WHERE owner_user_id = $1 AND alert_rule_id = $2`,
    [OWNER_A, ruleId]
  );
  return result.rows[0];
}

async function ruleHealth(ruleId: string) {
  const result = await pool.query<{
    lease_owner: string | null;
    evaluation_failure_count: number;
    last_error_code: string | null;
    has_success: boolean;
    has_backoff: boolean;
  }>(
    `SELECT lease_owner, evaluation_failure_count, last_error_code,
       last_success_at IS NOT NULL AS has_success,
       next_evaluation_at > last_error_at AS has_backoff
     FROM alert_rules WHERE id = $1`,
    [ruleId]
  );
  return result.rows[0];
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
