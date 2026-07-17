import { createHash } from "node:crypto";
import type { ScreenerAlertDefinitionV1, ScreenerDefinitionV1 } from "@saltanatbotv2/contracts";
import { describe, expect, it } from "vitest";
import type { ScreenerEngineRunV1 } from "../src/screener/engine.js";
import {
  SCREENER_ALERT_SUMMARY_SYMBOL_CAP,
  defaultScreenerAlertRuntimeState,
  evaluateScreenerAlert,
  screenerAlertChangeSummary,
  screenerAlertStateKey,
  screenerAlertTransitionKey,
  screenerDefinitionHash,
  type ScreenerAlertEvaluationInputV1,
  type ScreenerAlertRuntimeStateV1
} from "../src/alerts/screenerAlertEvaluator.js";

const RULE_ID = "11111111-1111-4111-8111-111111111111";
const DEFINITION_HASH = "b".repeat(64);
const BAR = 300_000;
const BAR_ONE = Date.parse("2026-07-17T06:00:00.000Z");
const BAR_TWO = BAR_ONE + BAR;
const NOW = BAR_TWO + 2 * BAR;
const STATE_KEY = screenerAlertStateKey(screen(), DEFINITION_HASH);

describe("screener alert match-set evaluator", () => {
  it("initializes durable membership on the first evaluation without triggering", () => {
    const first = evaluateScreenerAlert(evaluationInput());
    const replay = evaluateScreenerAlert(evaluationInput());

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      status: "initialized",
      stateKey: STATE_KEY,
      observation: {
        subjectKey: STATE_KEY,
        observationKey: `${STATE_KEY}:bar:${BAR_ONE}`,
        closedBarTimeMax: BAR_ONE,
        evaluatedAt: NOW,
        universe: { requested: 10, evaluated: 10, matched: 2, unavailable: 0 },
        researchOnly: true,
        executionPermission: false
      },
      nextState: {
        matchedSymbols: ["AAAUSDT", "BBBUSDT"],
        unknownSymbols: [],
        matchSetFingerprint: fingerprint(["AAAUSDT", "BBBUSDT"]),
        lastClosedBarTimeMax: BAR_ONE,
        initialized: true
      }
    });
    expect(first).not.toHaveProperty("transition");
    if (first.status !== "initialized") throw new Error("expected initialization");
    expect(first.observation.evidenceFingerprint).toMatch(/^[0-9a-f]{64}$/);

    expect(evaluateScreenerAlert(evaluationInput({ state: first.nextState }))).toMatchObject({ status: "idle", reason: "no-new-closed-bar", nextState: first.nextState });
  });

  it("detects entered and left symbols and emits an exactly verifiable transition", () => {
    const state = initializedState(["AAAUSDT", "BBBUSDT"]);
    const result = evaluateScreenerAlert(
      evaluationInput({
        state,
        run: run({ matched: ["BBBUSDT", "CCCUSDT"], closedBarTimeMax: BAR_TWO })
      })
    );

    expect(result).toMatchObject({
      status: "triggered",
      nextState: {
        matchedSymbols: ["BBBUSDT", "CCCUSDT"],
        matchSetFingerprint: fingerprint(["BBBUSDT", "CCCUSDT"]),
        lastClosedBarTimeMax: BAR_TWO,
        initialized: true
      },
      transition: {
        kind: "screener-alert-triggered",
        ruleId: RULE_ID,
        ruleRevision: 3,
        from: "steady",
        to: "changed",
        subjectKey: STATE_KEY,
        observationKey: `${STATE_KEY}:bar:${BAR_TWO}`,
        occurredAt: BAR_TWO,
        previousFingerprint: state.matchSetFingerprint,
        nextFingerprint: fingerprint(["BBBUSDT", "CCCUSDT"]),
        enteredSymbols: ["CCCUSDT"],
        leftSymbols: ["AAAUSDT"],
        matchedCount: 2,
        researchOnly: true,
        executionPermission: false
      }
    });
    if (result.status !== "triggered") throw new Error("expected trigger");
    expect(result.transition.transitionKey).toBe(screenerAlertTransitionKey(RULE_ID, 3, state.matchSetFingerprint, result.nextState.matchSetFingerprint, BAR_TWO));
  });

  it("treats unavailable symbols as unknown: members stay members, non-members stay non-members", () => {
    const state = initializedState(["AAAUSDT", "BBBUSDT"]);

    // AAAUSDT (member) and CCCUSDT (non-member) are unavailable: neither departs
    // nor enters, so the effective set is unchanged and nothing triggers.
    const unchanged = evaluateScreenerAlert(
      evaluationInput({
        state,
        run: run({ matched: ["BBBUSDT"], unavailable: ["AAAUSDT", "CCCUSDT"], closedBarTimeMax: BAR_TWO })
      })
    );
    expect(unchanged).toMatchObject({ status: "idle", reason: "no-change", nextState: state });

    // A real entry still triggers while the unavailable member is carried over.
    const entered = evaluateScreenerAlert(
      evaluationInput({
        state,
        run: run({ matched: ["BBBUSDT", "DDDUSDT"], unavailable: ["AAAUSDT"], closedBarTimeMax: BAR_TWO })
      })
    );
    expect(entered).toMatchObject({
      status: "triggered",
      nextState: {
        matchedSymbols: ["AAAUSDT", "BBBUSDT", "DDDUSDT"],
        unknownSymbols: ["AAAUSDT"]
      },
      transition: { enteredSymbols: ["DDDUSDT"], leftSymbols: [], matchedCount: 3 }
    });
  });

  it("defers on the availability floor without touching durable membership", () => {
    const state = initializedState(["AAAUSDT"]);
    const floored = evaluateScreenerAlert(
      evaluationInput({
        state,
        run: run({ matched: ["BBBUSDT"], unavailable: ["AAAUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT"], closedBarTimeMax: BAR_TWO })
      })
    );
    expect(floored).toEqual({
      status: "deferred",
      reason: "screener-availability-floor",
      stateKey: STATE_KEY,
      nextState: state
    });

    // Exactly 30% unavailable is still within the floor and evaluates normally.
    const boundary = evaluateScreenerAlert(
      evaluationInput({
        state,
        run: run({ matched: [], unavailable: ["AAAUSDT", "CCCUSDT", "DDDUSDT"], closedBarTimeMax: BAR_TWO })
      })
    );
    expect(boundary).toMatchObject({ status: "idle", reason: "no-change" });
  });

  it("blocks a change during cooldown and fires the identical transition after it elapses", () => {
    const state = initializedState(["AAAUSDT"]);
    const change = { state, run: run({ matched: ["AAAUSDT", "BBBUSDT"], closedBarTimeMax: BAR_TWO }) };

    const blocked = evaluateScreenerAlert(evaluationInput({ ...change, cooldownUntil: NOW + 30_000 }));
    expect(blocked).toEqual({
      status: "deferred",
      reason: "cooldown-active",
      stateKey: STATE_KEY,
      retryAfterSeconds: 30,
      nextState: state
    });

    const fired = evaluateScreenerAlert(evaluationInput({ ...change, cooldownUntil: NOW }));
    expect(fired).toMatchObject({
      status: "triggered",
      transition: {
        transitionKey: screenerAlertTransitionKey(RULE_ID, 3, state.matchSetFingerprint, fingerprint(["AAAUSDT", "BBBUSDT"]), BAR_TWO),
        enteredSymbols: ["BBBUSDT"],
        leftSymbols: []
      }
    });
  });

  it("keeps fingerprints stable under membership insertion order", () => {
    // Two different histories converge on {AAAUSDT, ZZZUSDT} with opposite
    // insertion orders (fresh match first vs carried-over member first).
    const carriedLast = evaluateScreenerAlert(
      evaluationInput({
        state: initializedState(["ZZZUSDT"]),
        run: run({ matched: ["AAAUSDT"], unavailable: ["ZZZUSDT"], closedBarTimeMax: BAR_TWO })
      })
    );
    const carriedFirst = evaluateScreenerAlert(
      evaluationInput({
        state: initializedState(["AAAUSDT"]),
        run: run({ matched: ["ZZZUSDT"], unavailable: ["AAAUSDT"], closedBarTimeMax: BAR_TWO })
      })
    );

    if (carriedLast.status !== "triggered" || carriedFirst.status !== "triggered") throw new Error("expected triggers");
    expect(carriedLast.nextState.matchedSymbols).toEqual(["AAAUSDT", "ZZZUSDT"]);
    expect(carriedFirst.nextState.matchedSymbols).toEqual(["AAAUSDT", "ZZZUSDT"]);
    expect(carriedLast.nextState.matchSetFingerprint).toBe(fingerprint(["AAAUSDT", "ZZZUSDT"]));
    expect(carriedFirst.nextState.matchSetFingerprint).toBe(carriedLast.nextState.matchSetFingerprint);
  });

  it("derives deterministic transition keys pinned to rule revision and closed bar", () => {
    const prev = fingerprint(["AAAUSDT"]);
    const next = fingerprint(["AAAUSDT", "BBBUSDT"]);
    const key = screenerAlertTransitionKey(RULE_ID, 3, prev, next, BAR_TWO);

    expect(key).toBe(sha256(JSON.stringify(["screener-alert-transition-v1", RULE_ID, 3, prev, next, BAR_TWO])));
    expect(screenerAlertTransitionKey(RULE_ID, 3, prev, next, BAR_TWO)).toBe(key);
    expect(screenerAlertTransitionKey(RULE_ID, 4, prev, next, BAR_TWO)).not.toBe(key);
    expect(screenerAlertTransitionKey(RULE_ID, 3, prev, next, BAR_TWO + BAR)).not.toBe(key);
    expect(screenerAlertTransitionKey(RULE_ID, 3, next, prev, BAR_TWO)).not.toBe(key);
  });

  it("caps the change summary at twelve spelled-out symbols", () => {
    const entered = Array.from({ length: 10 }, (_, index) => `EN${index}USDT`);
    const left = Array.from({ length: 5 }, (_, index) => `LF${index}USDT`);
    const summary = screenerAlertChangeSummary(entered, left, 42);

    const spelled = [...entered, ...left].filter((symbol) => summary.includes(symbol));
    expect(spelled).toHaveLength(SCREENER_ALERT_SUMMARY_SYMBOL_CAP);
    expect(summary.startsWith("Screen match changed: entered EN0USDT")).toBe(true);
    expect(summary).toContain("3 more changes");
    expect(summary).toContain("42 matched.");
    expect(summary).not.toContain("LF2USDT");
  });

  it.each([
    ["disabled rule", { definition: definition({ enabled: false }) }, { status: "idle", reason: "rule-disabled" }],
    ["foreign screen hash", { run: run({ matched: [], screen: screen({ name: "Другой скрин" }) }) }, { status: "unavailable", reason: "run-scope-mismatch" }],
    ["inconsistent universe counters", { run: { ...run({ matched: [] }), matchedSymbols: ["AAAUSDT"] } }, { status: "unavailable", reason: "run-scope-mismatch" }],
    ["empty universe", { run: run({ matched: [], requested: 0 }) }, { status: "unavailable", reason: "empty-universe" }],
    ["malformed durable state", { state: { ...defaultScreenerAlertRuntimeState(), matchSetFingerprint: "f".repeat(64) } }, { status: "unavailable", reason: "invalid-evaluation-input" }]
  ] as const)("fails %s closed without advancing state", (_label, override, expected) => {
    const state = "state" in override ? (override.state as ScreenerAlertRuntimeStateV1) : defaultScreenerAlertRuntimeState();
    expect(evaluateScreenerAlert(evaluationInput(override))).toMatchObject({ ...expected, nextState: state });
  });
});

function screen(override: Partial<ScreenerDefinitionV1> = {}): ScreenerDefinitionV1 {
  return {
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
    executionPermission: false,
    ...override
  };
}

function definition(override: Partial<ScreenerAlertDefinitionV1> = {}): ScreenerAlertDefinitionV1 {
  return {
    schemaVersion: "alert-rule-v1",
    kind: "screener",
    name: "Momentum screen alert",
    enabled: true,
    cooldownSeconds: 3_600,
    deliveryChannels: ["in-app"],
    researchOnly: true,
    executionPermission: false,
    screen: screen(),
    repeat: "on-change",
    ...override
  };
}

function evaluationInput(override: Partial<ScreenerAlertEvaluationInputV1> = {}): ScreenerAlertEvaluationInputV1 {
  return {
    ruleId: RULE_ID,
    ruleRevision: 3,
    definition: definition(),
    definitionHash: DEFINITION_HASH,
    state: defaultScreenerAlertRuntimeState(),
    run: run({ matched: ["AAAUSDT", "BBBUSDT"] }),
    now: NOW,
    ...override
  };
}

function run(options: {
  matched: readonly string[];
  unavailable?: readonly string[];
  requested?: number;
  closedBarTimeMax?: number;
  screen?: ScreenerDefinitionV1;
}): ScreenerEngineRunV1 {
  const unavailable = options.unavailable ?? [];
  const requested = options.requested ?? 10;
  const closedBarTimeMax = options.closedBarTimeMax ?? BAR_ONE;
  const screenDefinition = options.screen ?? screen();
  return {
    result: {
      schemaVersion: "screener-run-result-v1",
      definitionHash: screenerDefinitionHash(screenDefinition),
      generatedAt: new Date(NOW).toISOString(),
      timeframe: screenDefinition.timeframe,
      closedBarTimeMin: closedBarTimeMax,
      closedBarTimeMax,
      universe: {
        requested,
        evaluated: requested - unavailable.length,
        matched: options.matched.length,
        unavailable: unavailable.length
      },
      unavailableReasons: {},
      rows: [],
      rowsTruncated: false,
      researchOnly: true,
      executionPermission: false
    },
    matchedSymbols: [...options.matched],
    unavailableSymbols: [...unavailable]
  };
}

function initializedState(matched: readonly string[]): ScreenerAlertRuntimeStateV1 {
  const seeded = evaluateScreenerAlert(evaluationInput({ run: run({ matched }) }));
  if (seeded.status !== "initialized") throw new Error("expected seeded state");
  return seeded.nextState;
}

function fingerprint(symbols: readonly string[]): string {
  return sha256(JSON.stringify(symbols));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
