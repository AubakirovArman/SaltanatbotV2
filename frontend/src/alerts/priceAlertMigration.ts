import {
  ALERT_RULE_SCHEMA_V1,
  parsePriceThresholdAlertDefinitionV1,
  type AlertRuleRecordV1,
  type PriceAlertTimeframeV1,
  type PriceThresholdAlertDefinitionV1
} from "@saltanatbotv2/contracts";
import type { PriceAlert, PriceAlertSyncState } from "../market/alerts";

const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SERVER_TIMEFRAMES = new Set<string>(["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w"]);

export interface PriceAlertMigrationApi {
  create(
    ownerUserId: string,
    input: { clientId: string; definition: PriceThresholdAlertDefinitionV1 },
    signal?: AbortSignal
  ): Promise<AlertRuleRecordV1>;
  update(
    ownerUserId: string,
    ruleId: string,
    input: { expectedRevision: number; definition: PriceThresholdAlertDefinitionV1 },
    signal?: AbortSignal
  ): Promise<AlertRuleRecordV1>;
  archive(ownerUserId: string, ruleId: string, expectedRevision: number, signal?: AbortSignal): Promise<AlertRuleRecordV1>;
}

export interface ReconcilePriceAlertsInput {
  ownerUserId: string;
  localAlerts: PriceAlert[];
  serverRules: AlertRuleRecordV1[];
  api: PriceAlertMigrationApi;
  /** Every checkpoint must durably replace the browser-only snapshot. */
  persist: (alerts: PriceAlert[]) => void | Promise<void>;
  /** Optional live snapshot closes the browser-trigger-vs-migration race. */
  read?: () => PriceAlert[];
  signal?: AbortSignal;
}

export interface ReconcilePriceAlertsResult {
  localAlerts: PriceAlert[];
  serverRules: AlertRuleRecordV1[];
}

/** Only lossless, untriggered last-price rows can move to the closed-candle worker. */
export function isServerPriceAlertCandidate(alert: PriceAlert): alert is PriceAlert & { timeframe: PriceAlertTimeframeV1 } {
  return alert.source !== "server" && !alert.deleted && !alert.deletionPending && !alert.triggered && alert.priceType === "last" && typeof alert.timeframe === "string" && SERVER_TIMEFRAMES.has(alert.timeframe);
}

export function localPriceAlertStatus(alert: PriceAlert, databaseAuth: boolean, syncFailed = false): PriceAlertSyncState {
  if (alert.deletionPending) return "deleting";
  if (alert.syncState === "needs-review") return "needs-review";
  if (alert.source === "server") return alert.serverLifecycle === "disabled" ? "syncing" : "synced";
  if (databaseAuth && syncFailed && (isServerPriceAlertCandidate(alert) || Boolean(alert.serverRuleId))) return "sync-error";
  if (alert.syncState === "synced" && alert.suspended && alert.serverRuleId) return "synced";
  if (alert.triggered || alert.timeframe === undefined || alert.timeframe === "1M") return "needs-review";
  if (alert.priceType !== "last") return "browser-only";
  if (!databaseAuth) return "browser-only";
  return syncFailed ? "sync-error" : "syncing";
}

/**
 * Crash-safe two-phase local -> server reconciliation.
 *
 * 1. Create an idempotent disabled draft.
 * 2. Persist the local suspended fence.
 * 3. Enable the server rule, then persist the synced checkpoint.
 *
 * Retained local rows are never deleted by reconciliation. A retry finds the
 * draft by clientId and resumes from the last durable boundary.
 */
export async function reconcilePriceAlerts(input: ReconcilePriceAlertsInput): Promise<ReconcilePriceAlertsResult> {
  let localAlerts = input.localAlerts.slice();
  let serverRules = input.serverRules.slice();

  const checkpoint = async (id: string, change: Partial<PriceAlert>) => {
    throwIfAborted(input.signal);
    let changed = false;
    localAlerts = (input.read?.() ?? localAlerts).map((alert) => {
      if (alert.id !== id) return alert;
      const next = { ...alert, ...change, source: "browser" as const };
      changed = Object.entries(next).some(([key, value]) => !Object.is(alert[key as keyof PriceAlert], value));
      return changed ? next : alert;
    });
    if (!changed) return;
    await input.persist(localAlerts);
    throwIfAborted(input.signal);
  };

  for (const original of input.localAlerts) {
    throwIfAborted(input.signal);
    if (original.deleted || original.deletionPending) {
      const clientId = stablePriceAlertClientId(original);
      let deletedRule = serverRules.find((candidate) => candidate.clientId === clientId || candidate.id === original.serverRuleId);
      if (deletedRule && deletedRule.lifecycleState !== "archived") {
        deletedRule = await input.api.archive(input.ownerUserId, deletedRule.id, deletedRule.revision, input.signal);
        serverRules = replaceServerRule(serverRules, deletedRule);
      }
      if (deletedRule) {
        await checkpoint(original.id, {
          clientId,
          deleted: true,
          deletionPending: false,
          suspended: true,
          serverRuleId: deletedRule.id,
          serverRevision: deletedRule.revision,
          serverLifecycle: deletedRule.lifecycleState,
          syncState: "synced"
        });
      }
      continue;
    }
    if (original.pendingDefinitionUpdate) {
      let pendingRule = serverRules.find((candidate) => candidate.clientId === original.clientId || candidate.id === original.serverRuleId);
      if (!pendingRule) throw new Error("The linked server alert is unavailable for its pending definition update.");
      if (pendingRule.lifecycleState === "archived") {
        await checkpoint(original.id, { deleted: true, pendingDefinitionUpdate: false, suspended: true, serverLifecycle: "archived", syncState: "synced" });
        continue;
      }
      const expected = priceAlertDefinition(original, true);
      if (JSON.stringify(pendingRule.definition) !== JSON.stringify(expected)) {
        pendingRule = await input.api.update(input.ownerUserId, pendingRule.id, { expectedRevision: pendingRule.revision, definition: expected }, input.signal);
        serverRules = replaceServerRule(serverRules, pendingRule);
      }
      await checkpoint(original.id, {
        pendingDefinitionUpdate: false,
        suspended: true,
        serverRuleId: pendingRule.id,
        serverRevision: pendingRule.revision,
        serverLifecycle: pendingRule.lifecycleState,
        syncState: "synced"
      });
      continue;
    }
    if (!isServerPriceAlertCandidate(original)) continue;

    const clientId = stablePriceAlertClientId(original);
    let local = localAlerts.find(({ id }) => id === original.id) ?? original;
    if (local.clientId !== clientId) {
      await checkpoint(local.id, { clientId, syncState: "syncing" });
      local = localAlerts.find(({ id }) => id === original.id) ?? local;
    }

    let rule = serverRules.find((candidate) => candidate.clientId === clientId);
    if (rule?.lifecycleState === "archived") {
      await checkpoint(local.id, { deleted: true, deletionPending: false, syncState: "synced", suspended: true, serverRuleId: rule.id, serverRevision: rule.revision, serverLifecycle: rule.lifecycleState });
      continue;
    }

    const disabledDefinition = priceAlertDefinition(local, false);
    if (!rule) {
      rule = await input.api.create(input.ownerUserId, { clientId, definition: disabledDefinition }, input.signal);
      serverRules = replaceServerRule(serverRules, rule);
      await checkpoint(local.id, {
        clientId,
        serverRuleId: rule.id,
        serverRevision: rule.revision,
        serverLifecycle: rule.lifecycleState,
        syncState: "syncing"
      });
      local = localAlerts.find(({ id }) => id === original.id) ?? local;
    }

    // The browser can legitimately fire while the disabled draft is being
    // created. Never overwrite that transition or enable its server twin.
    const afterDraftSnapshot = input.read?.() ?? localAlerts;
    const afterDraft = afterDraftSnapshot.find(({ id }) => id === original.id);
    if (!afterDraft || afterDraft.deleted || afterDraft.deletionPending) {
      // A user deletion wins over reconciliation. Archive the committed draft
      // immediately so it cannot reappear as a disabled server projection.
      if (rule.lifecycleState !== "archived") {
        rule = await input.api.archive(input.ownerUserId, rule.id, rule.revision, input.signal);
        serverRules = replaceServerRule(serverRules, rule);
      }
      if (afterDraft) {
        await checkpoint(afterDraft.id, {
          clientId,
          deleted: true,
          deletionPending: false,
          suspended: true,
          serverRuleId: rule.id,
          serverRevision: rule.revision,
          serverLifecycle: rule.lifecycleState,
          syncState: "synced"
        });
      }
      if (!afterDraft) localAlerts = afterDraftSnapshot.slice();
      continue;
    }
    local = afterDraft;
    if (!isServerPriceAlertCandidate(local)) {
      await checkpoint(local.id, {
        clientId,
        suspended: false,
        serverRuleId: rule.id,
        serverRevision: rule.revision,
        serverLifecycle: rule.lifecycleState,
        syncState: "needs-review"
      });
      continue;
    }

    assertSameMigratedDefinition(rule, disabledDefinition);

    if (rule.definition.enabled && local.suspended) {
      await checkpoint(local.id, {
        clientId,
        suspended: true,
        serverRuleId: rule.id,
        serverRevision: rule.revision,
        serverLifecycle: rule.lifecycleState,
        syncState: "synced"
      });
      continue;
    }

    const beforeSuspendSnapshot = input.read?.() ?? localAlerts;
    const beforeSuspend = beforeSuspendSnapshot.find(({ id }) => id === original.id);
    if (!beforeSuspend) {
      localAlerts = beforeSuspendSnapshot.slice();
      continue;
    }
    local = beforeSuspend;

    // This durable browser fence must land before the server rule can be active.
    await checkpoint(local.id, {
      clientId,
      suspended: true,
      serverRuleId: rule.id,
      serverRevision: rule.revision,
      serverLifecycle: rule.lifecycleState,
      syncState: rule.definition.enabled ? "synced" : "syncing"
    });

    const fencedSnapshot = input.read?.() ?? localAlerts;
    const fenced = fencedSnapshot.find(({ id }) => id === original.id);
    if (!fenced || fenced.deleted || fenced.deletionPending) {
      if (rule.lifecycleState !== "archived") {
        rule = await input.api.archive(input.ownerUserId, rule.id, rule.revision, input.signal);
        serverRules = replaceServerRule(serverRules, rule);
      }
      if (fenced) await checkpoint(fenced.id, { deleted: true, deletionPending: false, suspended: true, serverLifecycle: rule.lifecycleState, serverRevision: rule.revision, syncState: "synced" });
      continue;
    }
    if (fenced.triggered) {
      await checkpoint(fenced.id, { suspended: false, serverRuleId: rule.id, serverRevision: rule.revision, serverLifecycle: rule.lifecycleState, syncState: "needs-review" });
      continue;
    }
    local = fenced;

    if (!rule.definition.enabled) {
      rule = await input.api.update(
        input.ownerUserId,
        rule.id,
        { expectedRevision: rule.revision, definition: priceAlertDefinition(local, true) },
        input.signal
      );
      serverRules = replaceServerRule(serverRules, rule);
    }

    await checkpoint(local.id, {
      clientId,
      suspended: true,
      serverRuleId: rule.id,
      serverRevision: rule.revision,
      serverLifecycle: rule.lifecycleState,
      syncState: "synced"
    });
  }

  return { localAlerts, serverRules };
}

export function priceAlertDefinition(alert: PriceAlert, enabled: boolean): PriceThresholdAlertDefinitionV1 {
  if (!isServerPriceAlertCandidate(alert) && !(alert.suspended && alert.timeframe && SERVER_TIMEFRAMES.has(alert.timeframe) && alert.priceType === "last")) {
    throw new Error("Browser price alert is not eligible for server evaluation.");
  }
  const timeframe = alert.timeframe as PriceAlertTimeframeV1;
  return parsePriceThresholdAlertDefinitionV1({
    schemaVersion: ALERT_RULE_SCHEMA_V1,
    kind: "price-threshold",
    name: `${alert.symbol} ${alert.direction} ${canonicalAlertDecimal(alert.price)}`.slice(0, 120),
    enabled,
    cooldownSeconds: 0,
    deliveryChannels: ["in-app"],
    exchange: alert.exchange,
    marketType: alert.marketType,
    priceType: "last",
    symbol: alert.symbol,
    timeframe,
    direction: alert.direction,
    threshold: canonicalAlertDecimal(alert.price),
    crossing: "inclusive",
    repeat: "once-until-rearmed",
    researchOnly: true,
    executionPermission: false
  });
}

/** Expand exponent notation without losing small prices such as 1e-8. */
export function canonicalAlertDecimal(value: number): string {
  if (!Number.isFinite(value) || value <= 0) throw new Error("Alert threshold must be a positive finite number.");
  const raw = value.toString().toLowerCase();
  const expanded = raw.includes("e") ? expandExponent(raw) : raw;
  const [integer, fraction = ""] = expanded.split(".");
  const normalizedInteger = integer.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = fraction.replace(/0+$/, "");
  if (normalizedInteger.length > 40 || normalizedFraction.length > 18) {
    throw new Error("Alert threshold exceeds the supported decimal precision.");
  }
  return normalizedFraction ? `${normalizedInteger}.${normalizedFraction}` : normalizedInteger;
}

export function stablePriceAlertClientId(alert: PriceAlert): string {
  if (alert.clientId && CLIENT_ID.test(alert.clientId)) return alert.clientId;
  const fingerprint = `${alert.id}\u0000${alert.symbol}\u0000${alert.createdAt}\u0000${alert.exchange}\u0000${alert.marketType}\u0000${alert.priceType}`;
  return `browser-alert:${fnv1a64(fingerprint)}`;
}

export function projectServerPriceAlert(rule: AlertRuleRecordV1): PriceAlert | undefined {
  if (rule.definition.kind !== "price-threshold" || rule.lifecycleState === "archived") return undefined;
  const definition = rule.definition;
  const price = Number(definition.threshold);
  if (!Number.isFinite(price) || price <= 0) return undefined;
  return {
    id: rule.id,
    clientId: rule.clientId,
    symbol: definition.symbol,
    price,
    direction: definition.direction,
    timeframe: definition.timeframe,
    createdAt: Date.parse(rule.createdAt),
    triggered: rule.lifecycleState === "triggered",
    exchange: definition.exchange,
    marketType: definition.marketType,
    priceType: definition.priceType,
    source: "server",
    suspended: true,
    syncState: definition.enabled ? "synced" : "syncing",
    serverRuleId: rule.id,
    serverRevision: rule.revision,
    serverLifecycle: rule.lifecycleState
  };
}

export function mergePriceAlertProjections(localAlerts: PriceAlert[], serverRules: AlertRuleRecordV1[], databaseAuth: boolean, syncFailed = false): PriceAlert[] {
  const retained = localAlerts.filter((alert) => !alert.deleted);
  const localByClientId = new Map(retained.filter(({ clientId }) => Boolean(clientId)).map((alert) => [alert.clientId!, alert]));
  const server = serverRules
    .map(projectServerPriceAlert)
    .filter((alert): alert is PriceAlert => alert !== undefined)
    .filter((alert) => !alert.clientId || !localByClientId.has(alert.clientId) || localByClientId.get(alert.clientId)?.suspended === true)
    .map((alert) => alert.clientId && localByClientId.get(alert.clientId)?.deletionPending ? { ...alert, syncState: "deleting" as const } : alert);
  const linkedClientIds = new Set(server.map(({ clientId }) => clientId).filter((value): value is string => Boolean(value)));
  const browser = retained
    .filter((alert) => !alert.suspended || !alert.clientId || !linkedClientIds.has(alert.clientId))
    .map((alert) => ({ ...alert, source: "browser" as const, syncState: localPriceAlertStatus(alert, databaseAuth, syncFailed) }));
  return [...server, ...browser].sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
}

function assertSameMigratedDefinition(rule: AlertRuleRecordV1, expected: PriceThresholdAlertDefinitionV1): void {
  if (rule.definition.kind !== "price-threshold") throw new Error("The alert client ID belongs to another rule kind.");
  const actual = { ...rule.definition, enabled: false };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("The alert client ID belongs to a different price alert.");
}

function replaceServerRule(rules: AlertRuleRecordV1[], next: AlertRuleRecordV1): AlertRuleRecordV1[] {
  const index = rules.findIndex(({ id }) => id === next.id);
  if (index < 0) return [...rules, next];
  const copy = rules.slice();
  copy[index] = next;
  return copy;
}

function expandExponent(raw: string): string {
  const match = /^(\d+)(?:\.(\d+))?e([+-]?\d+)$/.exec(raw);
  if (!match) throw new Error("Alert threshold is not a supported decimal.");
  const digits = `${match[1]}${match[2] ?? ""}`;
  const decimalIndex = match[1].length + Number(match[3]);
  if (decimalIndex <= 0) return `0.${"0".repeat(-decimalIndex)}${digits}`;
  if (decimalIndex >= digits.length) return `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  return `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The alert synchronization was aborted.", "AbortError");
}
