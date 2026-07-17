import type { Candle, ScreenerAlertDefinitionV1 } from "@saltanatbotv2/contracts";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AlertNotFoundError, AlertRearmUnsupportedError, AlertRepository, ScreenerAlertCapacityError, ScreenerAlertQuotaError } from "../src/alerts/repository.js";
import { parseAndHashAlertDefinition } from "../src/alerts/repositoryRows.js";
import { SCREENER_ALERT_MAX_ACTIVE_GLOBAL, SCREENER_ALERT_MAX_ENABLED_PER_OWNER, type ClaimedScreenerAlertRule, type CompleteScreenerEvaluationInput } from "../src/alerts/repositoryTypes.js";
import { evaluateScreenerAlert, screenerAlertObservationFingerprint, screenerDefinitionHash } from "../src/alerts/screenerAlertEvaluator.js";
import { runScreenerAlertSweep } from "../src/alerts/screenerAlertRunner.js";
import { runScreenerEngine } from "../src/screener/engine.js";
import { migrateDatabase } from "../src/database/migrations.js";
import type { ScreenerMarketDataSnapshotV1 } from "../src/screener/marketData.js";
import { assertIsolatedTestDatabase } from "./support/postgresTestDatabase.js";

const connectionString = process.env.SCREENER_TEST_DATABASE_URL ?? process.env.ALERTS_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const OWNER_A = "00000000-0000-4000-8000-000000000071";
const OWNER_B = "00000000-0000-4000-8000-000000000072";
const PASSWORD_HASH = "test-auth-hash-placeholder";
const BAR = 300_000;
// Every fake bar is at least two full 5m intervals in the past, so the
// database-clock closed-bar fence holds for the whole suite run.
const BAR_BASE = Math.floor(Date.now() / BAR) * BAR - 4 * BAR;
const BARS = [BAR_BASE, BAR_BASE + BAR, BAR_BASE + 2 * BAR] as const;
const SYMBOLS = ["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT", "FFFUSDT", "GGGUSDT", "HHHUSDT", "IIIUSDT", "JJJUSDT"];
let pool: Pool;
let repository: AlertRepository;

describePostgres("screener alert rules against isolated PostgreSQL", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 8 });
    await assertIsolatedTestDatabase(pool, "SCREENER_TEST_DATABASE_URL");
    await migrateDatabase(pool);
    await pool.query(
      `INSERT INTO users (id, login, login_normalized, password_hash, status, app_role)
       VALUES ($1, 'screener-alert-owner-a', 'screener-alert-owner-a', $3, 'active', 'user'),
              ($2, 'screener-alert-owner-b', 'screener-alert-owner-b', $3, 'active', 'user')
       ON CONFLICT (id) DO UPDATE SET status = 'active', must_change_password = FALSE, authorization_revision = 1`,
      [OWNER_A, OWNER_B, PASSWORD_HASH]
    );
    repository = new AlertRepository(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE alert_event_sequences, alert_rules, notification_bindings, alert_evaluation_receipts CASCADE");
    await pool.query("UPDATE users SET status = 'active', must_change_password = FALSE, authorization_revision = 1 WHERE id = ANY($1::uuid[])", [[OWNER_A, OWNER_B]]);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query("TRUNCATE alert_event_sequences, alert_rules, notification_bindings, alert_evaluation_receipts CASCADE").catch(() => undefined);
    await pool.end();
  });

  it("runs the create→claim→complete round trip at the runner seam and stays active", async () => {
    const rule = await createScreenerRule(OWNER_A, "screen:round-trip");
    expect(rule).toMatchObject({ status: "active", currentRevision: 1, evaluationIntervalSeconds: 300 });
    await makeDue(rule.id);

    const first = await sweep(snapshot(BARS[0], ["AAAUSDT"]));
    expect(first).toMatchObject({ claimAttempts: 1, claimed: 1, applied: 1, initialized: 1, triggered: 0, backedOff: 0, lostClaims: 0 });
    expect(await stateProof(OWNER_A, rule.id)).toMatchObject({
      state_status: "ineligible",
      initialized: true,
      armed: true,
      eligible: false,
      state_revision: "1",
      matched: ["AAAUSDT"]
    });
    expect(await ruleProof(rule.id)).toMatchObject({ status: "active", lease_owner: null, rescheduled: true });
    expect(await graphCounts(OWNER_A, rule.id)).toEqual({ receipts: "1", events: "0", outbox: "0", deliveries: "0" });

    await makeDue(rule.id);
    const second = await sweep(snapshot(BARS[1], ["AAAUSDT", "BBBUSDT"]));
    expect(second).toMatchObject({ claimed: 1, applied: 1, triggered: 1, initialized: 0 });
    expect(await stateProof(OWNER_A, rule.id)).toMatchObject({ state_revision: "2", matched: ["AAAUSDT", "BBBUSDT"] });
    expect(await ruleProof(rule.id)).toMatchObject({ status: "active", lease_owner: null, rescheduled: true });
    expect(await graphCounts(OWNER_A, rule.id)).toEqual({ receipts: "2", events: "1", outbox: "1", deliveries: "1" });

    const events = await repository.listEvents(OWNER_A, rule.id);
    expect(events).toMatchObject([{ ruleId: rule.id, ruleKind: "screener", eventType: "triggered", researchOnly: true, executionPermission: false }]);
    expect(events[0]!.summary).toContain("entered BBBUSDT");
    const outbox = await repository.listOutbox(OWNER_A);
    expect(outbox).toMatchObject([
      {
        channel: "in-app",
        status: "delivered",
        envelope: { title: "Screen match changed: Momentum screen alert", severity: "info" },
        researchOnly: true,
        executionPermission: false
      }
    ]);
    expect(outbox[0]!.envelope.deduplicationId).toMatch(/^[0-9a-f]{64}$/);
    expect(outbox[0]!.envelope.body).toContain("entered BBBUSDT");

    // Screener rules repeat on change and never expose the price rearm lane.
    await expect(repository.rearm({ ownerUserId: OWNER_A, actorUserId: OWNER_A, ruleId: rule.id, expectedRevision: 1, authorizationRevision: 1 })).rejects.toBeInstanceOf(AlertRearmUnsupportedError);
  });

  it("replays duplicate completion receipts idempotently and rejects forged replays", async () => {
    const rule = await createScreenerRule(OWNER_A, "screen:replay");
    await makeDue(rule.id);
    await sweep(snapshot(BARS[0], ["AAAUSDT"]));

    await makeDue(rule.id);
    const firstClaim = await claimScreener("screener-worker:replay-1");
    const evaluation = evaluate(firstClaim, snapshot(BARS[1], ["AAAUSDT", "BBBUSDT"]));
    const input = completionInput(firstClaim, evaluation);
    expect(input.transition).toBeDefined();
    await expect(repository.completeScreenerEvaluation(input)).resolves.toMatchObject({
      outcome: "applied",
      event: { eventType: "triggered", ruleKind: "screener" }
    });

    await makeDue(rule.id);
    const restartedClaim = await claimScreener("screener-worker:replay-2");
    expect(restartedClaim).toMatchObject({ id: rule.id, stateRevision: 2 });
    expect(restartedClaim.state.matchedSymbols).toEqual(["AAAUSDT", "BBBUSDT"]);
    const replay: CompleteScreenerEvaluationInput = {
      ...input,
      ...fence(restartedClaim),
      expectedStateRevision: restartedClaim.stateRevision
    };

    const forgedState = { ...input.nextState, unknownSymbols: ["JJJUSDT"] };
    const forgedFingerprint = screenerAlertObservationFingerprint(input.observation.subjectKey, input.observation.closedBarTimeMax, forgedState, input.observation.universe);
    await expect(
      repository.completeScreenerEvaluation({
        ...replay,
        nextState: forgedState,
        observation: { ...input.observation, evidenceFingerprint: forgedFingerprint },
        transition: { ...input.transition!, evidenceFingerprint: forgedFingerprint }
      })
    ).rejects.toThrow("does not match the current durable state fence");

    await expect(repository.completeScreenerEvaluation(replay)).resolves.toEqual({ outcome: "duplicate" });
    expect(await ruleProof(rule.id)).toMatchObject({ status: "active", lease_owner: null });
    expect(await stateProof(OWNER_A, rule.id)).toMatchObject({ state_revision: "2", matched: ["AAAUSDT", "BBBUSDT"] });
    expect(await graphCounts(OWNER_A, rule.id)).toEqual({ receipts: "2", events: "1", outbox: "1", deliveries: "1" });
  });

  it("isolates screener alert rules, claims and completions by owner", async () => {
    const rule = await createScreenerRule(OWNER_A, "screen:isolation");
    await expect(
      repository.create({
        ownerUserId: OWNER_A,
        actorUserId: OWNER_B,
        authorizationRevision: 1,
        clientId: "screen:isolation-bypass",
        definition: definition()
      })
    ).rejects.toBeInstanceOf(AlertNotFoundError);
    expect(await repository.get(OWNER_B, rule.id)).toBeUndefined();
    expect(await repository.list(OWNER_B)).toEqual([]);

    await makeDue(rule.id);
    const claim = await claimScreener("screener-worker:isolation");
    const evaluation = evaluate(claim, snapshot(BARS[0], ["AAAUSDT"]));
    const input = completionInput(claim, evaluation);
    await expect(repository.completeScreenerEvaluation({ ...input, ownerUserId: OWNER_B })).rejects.toBeInstanceOf(AlertNotFoundError);
    await expect(repository.completeScreenerEvaluation(input)).resolves.toMatchObject({ outcome: "applied" });
    expect(await repository.listEvents(OWNER_B)).toEqual([]);
    expect(await repository.listOutbox(OWNER_B)).toEqual([]);
  });

  it("enforces the 5-per-owner enabled quota and the 40-rule global screener capacity", async () => {
    for (let index = 0; index < SCREENER_ALERT_MAX_ENABLED_PER_OWNER; index += 1) {
      await createScreenerRule(OWNER_A, `screen:quota-${index}`);
    }
    await expect(createScreenerRule(OWNER_A, "screen:quota-overflow")).rejects.toBeInstanceOf(ScreenerAlertQuotaError);

    const disabled = await createScreenerRule(OWNER_A, "screen:quota-disabled", { enabled: false });
    expect(disabled.status).toBe("disabled");
    await expect(
      repository.update({
        ownerUserId: OWNER_A,
        actorUserId: OWNER_A,
        ruleId: disabled.id,
        expectedRevision: 1,
        authorizationRevision: 1,
        definition: definition({ enabled: true })
      })
    ).rejects.toBeInstanceOf(ScreenerAlertQuotaError);

    await seedActiveScreenerRules(OWNER_B, SCREENER_ALERT_MAX_ACTIVE_GLOBAL - SCREENER_ALERT_MAX_ENABLED_PER_OWNER);
    await expect(createScreenerRule(OWNER_B, "screen:capacity-overflow")).rejects.toBeInstanceOf(ScreenerAlertCapacityError);
    const proof = await pool.query<{ active: string }>("SELECT count(*)::text AS active FROM alert_rules WHERE status = 'active' AND rule_kind = 'screener'");
    expect(proof.rows[0]).toEqual({ active: String(SCREENER_ALERT_MAX_ACTIVE_GLOBAL) });
  });

  it("persists state across claims and enforces cooldown until the change fires later", async () => {
    const rule = await createScreenerRule(OWNER_A, "screen:cooldown", { cooldownSeconds: 3_600 });
    await makeDue(rule.id);
    expect(await sweep(snapshot(BARS[0], ["AAAUSDT"]))).toMatchObject({ initialized: 1 });
    await makeDue(rule.id);
    expect(await sweep(snapshot(BARS[1], ["AAAUSDT", "BBBUSDT"]))).toMatchObject({ triggered: 1 });
    const pending = await pool.query<{ pending: boolean }>("SELECT cooldown_until > clock_timestamp() + interval '3500 seconds' AS pending FROM alert_rule_states WHERE alert_rule_id = $1", [rule.id]);
    expect(pending.rows[0]).toEqual({ pending: true });

    await makeDue(rule.id);
    const blocked = await sweep(snapshot(BARS[2], ["AAAUSDT", "BBBUSDT", "CCCUSDT"]));
    expect(blocked).toMatchObject({ claimed: 1, deferred: 1, cooldownDeferred: 1, triggered: 0, applied: 0 });
    expect(await stateProof(OWNER_A, rule.id)).toMatchObject({ state_revision: "2", matched: ["AAAUSDT", "BBBUSDT"] });

    // The durable claim carries the persisted membership and cooldown fence,
    // and the completion re-checks the fence even for a forged worker input.
    await makeDue(rule.id);
    const claim = await claimScreener("screener-worker:cooldown-forge");
    expect(claim.state.matchedSymbols).toEqual(["AAAUSDT", "BBBUSDT"]);
    expect(claim.stateRevision).toBe(2);
    expect(claim.cooldownUntil).toBeGreaterThan(Date.now());
    const forged = evaluate(claim, snapshot(BARS[2], ["AAAUSDT", "BBBUSDT", "CCCUSDT"]), { ignoreCooldown: true });
    await expect(repository.completeScreenerEvaluation(completionInput(claim, forged))).rejects.toThrow("cooldown has not elapsed");
    await expect(repository.deferScreenerEvaluation(fence(claim))).resolves.toBe(true);

    await pool.query("UPDATE alert_rule_states SET cooldown_until = clock_timestamp() - interval '1 second' WHERE alert_rule_id = $1", [rule.id]);
    await makeDue(rule.id);
    expect(await sweep(snapshot(BARS[2], ["AAAUSDT", "BBBUSDT", "CCCUSDT"]))).toMatchObject({ triggered: 1, applied: 1 });
    expect(await stateProof(OWNER_A, rule.id)).toMatchObject({ state_revision: "3", matched: ["AAAUSDT", "BBBUSDT", "CCCUSDT"] });
    expect(await ruleProof(rule.id)).toMatchObject({ status: "active", lease_owner: null });
    const events = await repository.listEvents(OWNER_A, rule.id);
    expect(events.filter((event) => event.eventType === "triggered")).toHaveLength(2);
  });
});

function definition(override: Partial<ScreenerAlertDefinitionV1> = {}): ScreenerAlertDefinitionV1 {
  return {
    schemaVersion: "alert-rule-v1",
    kind: "screener",
    name: "Momentum screen alert",
    enabled: true,
    cooldownSeconds: 0,
    deliveryChannels: ["in-app"],
    researchOnly: true,
    executionPermission: false,
    screen: {
      schemaVersion: "screener-definition-v1",
      kind: "technical",
      name: "Momentum screen",
      exchange: "binance",
      marketType: "spot",
      priceType: "last",
      timeframe: "5m",
      universeLimit: 10,
      sort: { key: "symbol", direction: "asc" },
      filters: [{ kind: "price", min: "100", max: "200" }],
      researchOnly: true,
      executionPermission: false
    },
    repeat: "on-change",
    ...override
  };
}

async function createScreenerRule(ownerUserId: string, clientId: string, override: Partial<ScreenerAlertDefinitionV1> = {}) {
  return repository.create({
    ownerUserId,
    actorUserId: ownerUserId,
    authorizationRevision: 1,
    clientId,
    definition: definition(override)
  });
}

async function sweep(snap: ScreenerMarketDataSnapshotV1) {
  const errors: unknown[] = [];
  const result = await runScreenerAlertSweep(repository, {
    workerId: "screener-worker:integration",
    marketData: async () => snap,
    onError: (error) => errors.push(error)
  });
  expect(errors).toEqual([]);
  return result;
}

async function claimScreener(workerId: string): Promise<ClaimedScreenerAlertRule> {
  const claimed = await repository.claimDueScreenerAlert({ workerId, leaseMs: 300_000 });
  if (!claimed) throw new Error(`Expected ${workerId} to claim a due screener alert.`);
  return claimed;
}

function evaluate(claim: ClaimedScreenerAlertRule, snap: ScreenerMarketDataSnapshotV1, options: { ignoreCooldown?: boolean } = {}) {
  const run = runScreenerEngine({
    definition: claim.definition.screen,
    definitionHash: screenerDefinitionHash(claim.definition.screen),
    universe: snap.universe,
    candlesBySymbol: snap.candlesBySymbol,
    unavailableReasonBySymbol: snap.unavailableReasonBySymbol,
    now: Date.now()
  });
  return evaluateScreenerAlert({
    ruleId: claim.id,
    ruleRevision: claim.currentRevision,
    definition: claim.definition,
    definitionHash: claim.definitionHash,
    state: claim.state,
    ...(options.ignoreCooldown || claim.cooldownUntil === undefined ? {} : { cooldownUntil: claim.cooldownUntil }),
    run,
    now: Date.now()
  });
}

function completionInput(claim: ClaimedScreenerAlertRule, evaluation: ReturnType<typeof evaluate>): CompleteScreenerEvaluationInput {
  if (evaluation.status !== "initialized" && evaluation.status !== "triggered") {
    throw new Error(`Expected a completable evaluation, received ${evaluation.status}.`);
  }
  return {
    ...fence(claim),
    expectedStateRevision: claim.stateRevision,
    observation: evaluation.observation,
    nextState: evaluation.nextState,
    ...(evaluation.status === "triggered" ? { transition: evaluation.transition } : {})
  };
}

function fence(claim: ClaimedScreenerAlertRule) {
  return {
    ownerUserId: claim.ownerUserId,
    ruleId: claim.id,
    expectedRevision: claim.currentRevision,
    authorizationRevision: claim.authorizationRevision,
    workerId: claim.workerId,
    leaseToken: claim.leaseToken,
    leaseGeneration: claim.leaseGeneration
  };
}

function snapshot(barTime: number, matched: readonly string[]): ScreenerMarketDataSnapshotV1 {
  const matchedSet = new Set(matched);
  const candlesBySymbol = new Map<string, Candle[]>();
  for (const symbol of SYMBOLS) {
    const close = matchedSet.has(symbol) ? 150 : 50;
    candlesBySymbol.set(symbol, [candle(barTime - 2 * BAR, close), candle(barTime - BAR, close), candle(barTime, close)]);
  }
  return {
    observedAt: Date.now(),
    universe: SYMBOLS.map((symbol) => ({ symbol })),
    candlesBySymbol,
    unavailableReasonBySymbol: new Map()
  };
}

function candle(time: number, close: number): Candle {
  return { time, open: close, high: close + 1, low: close - 1, close, volume: 10, final: true, source: "public-test" };
}

async function makeDue(ruleId: string): Promise<void> {
  await pool.query("UPDATE alert_rules SET next_evaluation_at = clock_timestamp() - interval '1 second' WHERE id = $1", [ruleId]);
}

async function seedActiveScreenerRules(ownerUserId: string, count: number): Promise<void> {
  const parsed = parseAndHashAlertDefinition(definition());
  const ids = Array.from({ length: count }, () => randomUUID());
  const clientIds = ids.map((_, index) => `screen:seed:${index}`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO alert_rules (id, owner_user_id, client_id, rule_kind, status, authorization_revision, next_evaluation_at, created_by_user_id, updated_by_user_id)
       SELECT seed.id, $1, seed.client_id, 'screener', 'active', 1, clock_timestamp() + interval '1 day', $1, $1
       FROM unnest($2::uuid[], $3::text[]) AS seed(id, client_id)`,
      [ownerUserId, ids, clientIds]
    );
    await client.query(
      `INSERT INTO alert_rule_revisions (owner_user_id, alert_rule_id, revision, schema_version, rule_kind, definition, definition_hash, actor_user_id)
       SELECT $1, seed.id, 1, 'alert-rule-v1', 'screener', $3::jsonb, $4, $1 FROM unnest($2::uuid[]) AS seed(id)`,
      [ownerUserId, ids, parsed.serialized, parsed.hash]
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
  const result = await pool.query<{ receipts: string; events: string; outbox: string; deliveries: string }>(
    `SELECT
       (SELECT count(*)::text FROM alert_evaluation_receipts WHERE owner_user_id = $1 AND alert_rule_id = $2) AS receipts,
       (SELECT count(*)::text FROM alert_rule_events WHERE owner_user_id = $1 AND alert_rule_id = $2) AS events,
       (SELECT count(*)::text FROM notification_outbox WHERE owner_user_id = $1 AND alert_rule_id = $2) AS outbox,
       (SELECT count(*)::text FROM notification_deliveries delivery
          INNER JOIN notification_outbox outbox ON outbox.owner_user_id = delivery.owner_user_id AND outbox.id = delivery.outbox_id
          WHERE delivery.owner_user_id = $1 AND outbox.alert_rule_id = $2) AS deliveries`,
    [ownerUserId, ruleId]
  );
  return result.rows[0];
}

async function stateProof(ownerUserId: string, ruleId: string) {
  const result = await pool.query<{
    state_status: string;
    initialized: boolean;
    eligible: boolean;
    armed: boolean;
    state_revision: string;
    matched: unknown;
  }>(
    `SELECT state_status, initialized, eligible, armed, state_revision::text AS state_revision,
       state->'matchedSymbols' AS matched
     FROM alert_rule_states WHERE owner_user_id = $1 AND alert_rule_id = $2`,
    [ownerUserId, ruleId]
  );
  return result.rows[0];
}

async function ruleProof(ruleId: string) {
  const result = await pool.query<{ status: string; lease_owner: string | null; rescheduled: boolean }>(
    `SELECT status, lease_owner, next_evaluation_at > clock_timestamp() AS rescheduled
     FROM alert_rules WHERE id = $1`,
    [ruleId]
  );
  return result.rows[0];
}
