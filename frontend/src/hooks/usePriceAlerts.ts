import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AlertEventV1, AlertRuleRecordV1, NotificationOutboxItemV1, PriceThresholdAlertDefinitionV1 } from "@saltanatbotv2/contracts";
import { AlertApiError, archiveAlertRule, createAlertRule, listAlertEvents, listAlertOutbox, listAlertRules, rearmAlertRule, updateAlertRule } from "../alerts/client";
import { advanceAlertEventWatermark, alertEventWatermarkStorageKey, estimateServerSessionStartFromElapsed, legacyEventWindowHasOverlap, loadAlertEventWatermark, storeAlertEventWatermark, type AlertEventWatermark } from "../alerts/eventWatermark";
import { ALERT_EVENT_PAGE_LIMIT, alertEventsToPublish, drainAlertEventPages, mergeAlertEventHistory, publishServerEventToasts } from "../alerts/eventPolling";
import { isOwnerStorageMessage, prepareLocalSnapshot, sameLocalSnapshot, validateAlertThresholdPrecision } from "../alerts/localSnapshot";
import { isServerPriceAlertCandidate, localPriceAlertStatus, mergePriceAlertProjections, priceAlertDefinition, reconcilePriceAlerts, stablePriceAlertClientId } from "../alerts/priceAlertMigration";
import { useAuth } from "../auth/AuthRoot";
import { DEFAULT_PRICE_ALERT_ROUTE, ensureNotificationPermission, evaluateAlertPrices, loadAlertSnapshot, mergePriceAlertSnapshots, playAlertBeep, priceAlertStorageKey, showAlertNotification, storeAlerts, type AlertDirection, type PriceAlert, type TriggeredPriceAlert } from "../market/alerts";
import type { ChartDataRoute, Timeframe } from "../types";

const ALERT_REFRESH_INTERVAL_MS = 30_000;
const ALERT_STORAGE_CHANNEL = "sbv2:price-alert-storage:v1";

export interface BrowserAlertToast {
  id: string;
  source?: "browser";
  symbol: string;
  price: number;
  direction: AlertDirection;
  hitPrice: number;
}

export interface ServerAlertToast {
  id: string;
  source: "server";
  symbol?: string;
  /** Delivery-envelope headline; present for rule kinds without a single symbol. */
  title?: string;
  /** Delivery-envelope body rendered instead of the raw event summary. */
  body?: string;
  summary: string;
  occurredAt: string;
}

export type AlertToast = BrowserAlertToast | ServerAlertToast;

export interface NewAlertInput extends ChartDataRoute {
  symbol: string;
  price: number;
  direction: AlertDirection;
  timeframe: Timeframe;
  /** Also deliver via the owner's active Telegram binding (server rules only). */
  telegramDelivery?: boolean;
}

export type PriceAlertSyncStatus = "legacy" | "loading" | "synced" | "error";

export interface PriceAlertSyncState {
  status: PriceAlertSyncStatus;
  error?: string;
  lastSyncedAt?: number;
  events: AlertEventV1[];
  outbox: NotificationOutboxItemV1[];
  refresh: () => void;
}

interface LocalAlertState {
  ownerId?: string;
  alerts: PriceAlert[];
}

interface ServerAlertState {
  ownerId?: string;
  status: PriceAlertSyncStatus;
  rules: AlertRuleRecordV1[];
  events: AlertEventV1[];
  outbox: NotificationOutboxItemV1[];
  error?: string;
  lastSyncedAt?: number;
}

interface AlertDelivery {
  id: number;
  ownerId?: string;
  fired: TriggeredPriceAlert[];
}

function makeId() {
  return `alert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Browser-only alerts and database-owned alert projections share one UI model,
 * while keeping their evaluation and persistence paths strictly separated.
 */
export function usePriceAlerts(decimalsFor: (symbol: string) => number, legacyRoute: ChartDataRoute = DEFAULT_PRICE_ALERT_ROUTE) {
  const accountAuth = useAuth();
  const databaseAuth = accountAuth.authRequired;
  const ownerId = databaseAuth ? (accountAuth.user?.id ?? "") : undefined;
  const [localState, setLocalState] = useState<LocalAlertState>(() => ({ ownerId, alerts: loadAlertSnapshot(ownerId, legacyRoute) }));
  const [serverState, setServerState] = useState<ServerAlertState>(() => ({ ownerId, status: databaseAuth ? "loading" : "legacy", rules: [], events: [], outbox: [] }));
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [toasts, setToasts] = useState<AlertToast[]>([]);
  const [deliveries, setDeliveries] = useState<AlertDelivery[]>([]);
  const deliverySequence = useRef(0);
  const processedDeliveries = useRef(new Set<number>());
  const localMutationClock = useRef(Date.now());
  const storageChannelRef = useRef<BroadcastChannel>();
  const serverMutationEpoch = useRef(0);
  const sessionStartedAt = useRef(monotonicNow());
  const initialEventFloor = useRef<string>();
  const eventWatermark = useRef<AlertEventWatermark>();
  const decimalsRef = useRef(decimalsFor);
  decimalsRef.current = decimalsFor;
  const legacyRouteRef = useRef(legacyRoute);
  legacyRouteRef.current = legacyRoute;
  const ownerRef = useRef(ownerId);
  ownerRef.current = ownerId;

  // Fail closed during an in-place owner change; the new tenant snapshot is
  // loaded by the effect without ever rendering the previous tenant's rows.
  const localAlerts = localState.ownerId === ownerId ? localState.alerts : [];
  const localAlertsRef = useRef(localAlerts);
  localAlertsRef.current = localAlerts;

  const replaceLocalAlerts = useCallback((next: PriceAlert[], expectedOwner = ownerId, requireDurable = false) => {
    if (ownerRef.current !== expectedOwner) return false;
    const latest = loadAlertSnapshot(expectedOwner, legacyRouteRef.current);
    const merged = prepareLocalSnapshot(localAlertsRef.current, next, latest, localMutationClock);
    const stored = storeAlerts(merged, expectedOwner);
    if (requireDurable && !stored) return false;
    const committed = stored ? merged : mergePriceAlertSnapshots(localAlertsRef.current, merged);
    localAlertsRef.current = committed;
    setLocalState({ ownerId: expectedOwner, alerts: committed });
    if (stored) storageChannelRef.current?.postMessage({ ownerId: expectedOwner ?? null });
    return true;
  }, [ownerId]);

  useEffect(() => {
    const next = loadAlertSnapshot(ownerId, legacyRouteRef.current);
    localAlertsRef.current = next;
    setLocalState({ ownerId, alerts: next });
  }, [ownerId]);

  useEffect(() => {
    const key = priceAlertStorageKey(ownerId);
    if (!key) return;
    const watermarkKey = databaseAuth && ownerId ? alertEventWatermarkStorageKey(ownerId) : undefined;
    const applyExternalSnapshot = () => {
      if (ownerRef.current !== ownerId) return;
      const stored = loadAlertSnapshot(ownerId, legacyRouteRef.current);
      const merged = mergePriceAlertSnapshots(localAlertsRef.current, stored);
      if (sameLocalSnapshot(localAlertsRef.current, merged)) return;
      localMutationClock.current = Math.max(localMutationClock.current, ...merged.map(({ localRevision }) => localRevision ?? 0));
      localAlertsRef.current = merged;
      setLocalState({ ownerId, alerts: merged });
      if (databaseAuth) setRefreshSequence((current) => current + 1);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) applyExternalSnapshot();
      if (watermarkKey && event.key === watermarkKey) eventWatermark.current = loadAlertEventWatermark(ownerId!);
    };
    window.addEventListener("storage", onStorage);
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(ALERT_STORAGE_CHANNEL);
      storageChannelRef.current = channel;
      channel.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (isOwnerStorageMessage(event.data, ownerId)) applyExternalSnapshot();
      });
      return () => {
        window.removeEventListener("storage", onStorage);
        if (storageChannelRef.current === channel) storageChannelRef.current = undefined;
        channel.close();
      };
    }
    return () => window.removeEventListener("storage", onStorage);
  }, [databaseAuth, ownerId]);

  const setLocalAlerts = useCallback(
    (action: PriceAlert[] | ((alerts: PriceAlert[]) => PriceAlert[])) => {
      if (ownerRef.current !== ownerId) return;
      const current = localAlertsRef.current;
      const next = typeof action === "function" ? action(current) : action;
      if (next !== current) replaceLocalAlerts(next);
    },
    [ownerId, replaceLocalAlerts]
  );

  useEffect(() => {
    setToasts([]);
    setDeliveries([]);
    processedDeliveries.current.clear();
    serverMutationEpoch.current += 1;
    sessionStartedAt.current = monotonicNow();
    initialEventFloor.current = undefined;
    eventWatermark.current = databaseAuth && ownerId ? loadAlertEventWatermark(ownerId) : undefined;
    setServerState({ ownerId, status: databaseAuth ? "loading" : "legacy", rules: [], events: [], outbox: [] });
  }, [databaseAuth, ownerId]);

  useEffect(() => {
    if (!databaseAuth || !ownerId) return;
    const controller = new AbortController();
    let disposed = false;
    let inFlight = false;

    const synchronize = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      const mutationEpochAtStart = serverMutationEpoch.current;
      try {
        let watermarkAtStart = loadAlertEventWatermark(ownerId) ?? eventWatermark.current;
        eventWatermark.current = watermarkAtStart;
        const loadBatch = () => Promise.all([
          listAlertRules(ownerId, controller.signal),
          listAlertEvents(ownerId, { limit: ALERT_EVENT_PAGE_LIMIT, ...(watermarkAtStart?.cursor ? { cursor: watermarkAtStart.cursor } : {}) }, controller.signal),
          listAlertOutbox(ownerId, 100, controller.signal)
        ] as const);
        let cursorResetBaseline = watermarkAtStart?.baselinePending === true;
        let batch: Awaited<ReturnType<typeof loadBatch>>;
        try {
          batch = await loadBatch();
        } catch (error) {
          if (!(error instanceof AlertApiError) || error.status !== 409 || error.code !== "alert_event_cursor_ahead" || !watermarkAtStart?.cursor) throw error;
          const resetWatermark: AlertEventWatermark = { occurredAt: watermarkAtStart.occurredAt, idsAtOccurredAt: watermarkAtStart.idsAtOccurredAt, baselinePending: true };
          if (!storeAlertEventWatermark(ownerId, resetWatermark)) {
            throw new Error("Browser storage is unavailable; the restored alert cursor cannot be reset safely.");
          }
          watermarkAtStart = resetWatermark;
          eventWatermark.current = resetWatermark;
          cursorResetBaseline = true;
          batch = await loadBatch();
        }
        const [listed, firstEventPage, outboxList] = batch;
        if (disposed || ownerRef.current !== ownerId || mutationEpochAtStart !== serverMutationEpoch.current) return;
        const generatedAt = firstEventPage.generatedAt ?? listed.generatedAt;
        const floor = initialEventFloor.current ?? estimateServerSessionStartFromElapsed(generatedAt, Math.max(0, monotonicNow() - sessionStartedAt.current));
        initialEventFloor.current = floor;
        let bootstrapSince: string | undefined;
        let firstPageToDrain = firstEventPage;
        if (!watermarkAtStart?.cursor && firstEventPage.hasMore === true) {
          bootstrapSince = floor;
          firstPageToDrain = await listAlertEvents(ownerId, { limit: ALERT_EVENT_PAGE_LIMIT, since: floor }, controller.signal);
          if (disposed || ownerRef.current !== ownerId || mutationEpochAtStart !== serverMutationEpoch.current) return;
        }
        const eventPage = await drainAlertEventPages(ownerId, firstPageToDrain, controller.signal, bootstrapSince);
        if (disposed || ownerRef.current !== ownerId || mutationEpochAtStart !== serverMutationEpoch.current) return;
        const forwardCursorResponse = firstPageToDrain.nextCursor !== undefined;
        if (watermarkAtStart?.cursor && !forwardCursorResponse) {
          throw new Error("Alert service did not honor the durable event cursor; synchronization stopped to avoid notification loss.");
        }
        if (!forwardCursorResponse && !legacyEventWindowHasOverlap(eventPage.events, ALERT_EVENT_PAGE_LIMIT, watermarkAtStart, floor)) {
          throw new Error("Alert event history exceeded the bounded API window; notification completeness cannot be verified.");
        }
        const advancedEvents = advanceAlertEventWatermark(eventPage.events, watermarkAtStart, floor, eventPage.nextCursor);
        const unseenEvents = cursorResetBaseline ? [] : alertEventsToPublish(eventPage.events, watermarkAtStart, advancedEvents.unseen, forwardCursorResponse);
        // At-least-once delivery: surface the event before advancing the durable
        // cursor. A crash may repeat a toast, but cannot permanently suppress it.
        publishServerEventToasts(unseenEvents, listed.rules, outboxList.items, setToasts);
        if (!storeAlertEventWatermark(ownerId, advancedEvents.watermark)) {
          throw new Error("Browser storage is unavailable; the alert event delivery watermark is not durable.");
        }
        eventWatermark.current = advancedEvents.watermark;
        const reconciled = await reconcilePriceAlerts({
          ownerUserId: ownerId,
          localAlerts: localAlertsRef.current,
          serverRules: listed.rules,
          signal: controller.signal,
          persist: (next) => {
            if (ownerRef.current !== ownerId) throw new DOMException("Alert owner changed.", "AbortError");
            if (!replaceLocalAlerts(next, ownerId, true)) throw new Error("Browser storage is unavailable; the server alert was not enabled.");
          },
          read: () => localAlertsRef.current,
          api: {
            create: (expectedOwner, input, signal) => createAlertRule(expectedOwner, input, signal),
            update: (expectedOwner, ruleId, input, signal) => updateAlertRule(expectedOwner, ruleId, input, signal),
            archive: (expectedOwner, ruleId, expectedRevision, signal) => archiveAlertRule(expectedOwner, ruleId, expectedRevision, signal)
          }
        });
        if (disposed || ownerRef.current !== ownerId || mutationEpochAtStart !== serverMutationEpoch.current) return;
        setServerState((current) => ({
          ownerId,
          status: "synced",
          rules: reconciled.serverRules,
          events: mergeAlertEventHistory(current.ownerId === ownerId ? current.events : [], eventPage.events),
          outbox: outboxList.items,
          lastSyncedAt: Date.now()
        }));
      } catch (error) {
        if (!disposed && ownerRef.current === ownerId && !isAbort(error)) {
          setServerState((current) => ({
            ownerId,
            status: "error",
            rules: current.ownerId === ownerId ? current.rules : [],
            events: current.ownerId === ownerId ? current.events : [],
            outbox: current.ownerId === ownerId ? current.outbox : [],
            error: boundedError(error)
          }));
        }
      } finally {
        inFlight = false;
      }
    };

    void synchronize();
    const timer = window.setInterval(() => void synchronize(), ALERT_REFRESH_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void synchronize();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [databaseAuth, ownerId, refreshSequence, replaceLocalAlerts]);

  const currentServerState = serverState.ownerId === ownerId ? serverState : { ownerId, status: databaseAuth ? "loading" as const : "legacy" as const, rules: [], events: [], outbox: [] };
  const alerts = useMemo(
    () => mergePriceAlertProjections(localAlerts, currentServerState.rules, databaseAuth, currentServerState.status === "error"),
    [currentServerState.rules, currentServerState.status, databaseAuth, localAlerts]
  );
  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;

  const browserAlerts = useMemo(
    () => localAlerts
      .filter((alert) => alert.source !== "server" && !alert.deleted && !alert.deletionPending && !alert.suspended && alert.timeframe !== undefined)
      .map((alert) => ({ ...alert, source: "browser" as const, syncState: localPriceAlertStatus(alert, databaseAuth, currentServerState.status === "error") })),
    [currentServerState.status, databaseAuth, localAlerts]
  );

  // Screener-kind rules stay server-owned records: they are never projected
  // into PriceAlert rows, so they can never open a price-quote subscription.
  const screenerRules = useMemo(
    () => currentServerState.rules.filter((rule) => rule.definition.kind === "screener" && rule.lifecycleState !== "archived"),
    [currentServerState.rules]
  );
  const screenerRulesRef = useRef(screenerRules);
  screenerRulesRef.current = screenerRules;

  const updateServerRule = useCallback((rule: AlertRuleRecordV1) => {
    if (ownerRef.current !== ownerId) return;
    serverMutationEpoch.current += 1;
    setServerState((current) => {
      if (current.ownerId !== ownerId) return current;
      const index = current.rules.findIndex(({ id }) => id === rule.id);
      const existing = index < 0 ? undefined : current.rules[index];
      const accepted = existing && compareServerRuleFreshness(existing, rule) > 0 ? existing : rule;
      const rules = index < 0 ? [...current.rules, accepted] : current.rules.map((item, itemIndex) => (itemIndex === index ? accepted : item));
      return { ...current, status: "synced", rules, error: undefined, lastSyncedAt: Date.now() };
    });
  }, [ownerId]);

  const addAlert = useCallback(
    async (input: NewAlertInput) => {
      if (databaseAuth) {
        if (!ownerId) throw new Error("Alert owner is unavailable.");
        const draftId = makeId();
        const draft: PriceAlert = {
          id: draftId,
          symbol: input.symbol,
          price: input.price,
          direction: input.direction,
          timeframe: input.timeframe,
          createdAt: Date.now(),
          triggered: false,
          exchange: input.exchange,
          marketType: input.marketType,
          priceType: input.priceType,
          source: "browser",
          ...(input.telegramDelivery === true ? { telegramDelivery: true as const } : {})
        };
        if (!isServerPriceAlertCandidate(draft)) throw new Error("This alert route requires browser-only review and cannot be created as a server alert.");
        validateAlertThresholdPrecision(draft.price, decimalsRef.current(draft.symbol));
        // Validate the exact shared definition before persisting or clearing the form.
        priceAlertDefinition(draft, false);
        const clientId = stablePriceAlertClientId(draft);
        // Persist the idempotent intent before any network request. The normal
        // reconciler creates it disabled, fences browser evaluation, then enables.
        const next = [...localAlertsRef.current, { ...draft, clientId, syncState: "syncing" as const }];
        if (!replaceLocalAlerts(next, ownerId, true)) throw new Error("Browser storage is unavailable; the server alert was not created.");
        void ensureNotificationPermission();
        setRefreshSequence((current) => current + 1);
        return;
      }

      void ensureNotificationPermission();
      setLocalAlerts((current) => [
        ...current,
        {
          id: makeId(),
          symbol: input.symbol,
          price: input.price,
          direction: input.direction,
          timeframe: input.timeframe,
          createdAt: Date.now(),
          triggered: false,
          exchange: input.exchange,
          marketType: input.marketType,
          priceType: input.priceType,
          source: "browser",
          syncState: "browser-only"
        }
      ]);
    },
    [databaseAuth, ownerId, replaceLocalAlerts, setLocalAlerts]
  );

  const removeAlert = useCallback(
    async (id: string) => {
      const alert = alertsRef.current.find((candidate) => candidate.id === id);
      if (!alert) return;
      const retained = localAlertsRef.current.find((candidate) => candidate.id === id || (alert.clientId && candidate.clientId === alert.clientId));
      const persistDeletionCheckpoint = (change: Partial<PriceAlert>, errorMessage: string) => {
        if (!retained) return;
        const next = localAlertsRef.current.map((candidate) => candidate.id === retained.id ? { ...candidate, ...change, source: "browser" as const } : candidate);
        if (!replaceLocalAlerts(next, ownerId, databaseAuth)) throw new Error(errorMessage);
      };
      if (databaseAuth && alert.serverRuleId && alert.serverRevision) {
        if (!ownerId) throw new Error("Alert owner is unavailable.");
        persistDeletionCheckpoint({ suspended: true, deletionPending: true, syncState: "deleting" }, "Browser storage is unavailable; the server alert was not removed.");
        const archived = await archiveAlertRule(ownerId, alert.serverRuleId, alert.serverRevision);
        if (ownerRef.current !== ownerId) return;
        updateServerRule(archived);
        persistDeletionCheckpoint({ deleted: true, deletionPending: false, suspended: true, syncState: "synced", serverLifecycle: "archived" }, "The server alert was archived, but its browser deletion checkpoint could not be saved. It remains inert; retry after restoring browser storage.");
        return;
      }
      if (retained) {
        persistDeletionCheckpoint({ deleted: true, deletionPending: databaseAuth && Boolean(retained.clientId), suspended: true, syncState: databaseAuth && retained.clientId ? "deleting" : "browser-only" }, "Browser storage is unavailable; the alert was not removed.");
        if (databaseAuth && retained.clientId) setRefreshSequence((current) => current + 1);
      }
    },
    [databaseAuth, ownerId, replaceLocalAlerts, updateServerRule]
  );

  const resetAlert = useCallback(
    async (id: string) => {
      const alert = alertsRef.current.find((candidate) => candidate.id === id);
      if (!alert) return;
      if (databaseAuth && alert.source === "server" && alert.serverRuleId && alert.serverRevision) {
        if (!ownerId) throw new Error("Alert owner is unavailable.");
        const rearmed = await rearmAlertRule(ownerId, alert.serverRuleId, alert.serverRevision);
        if (ownerRef.current === ownerId) updateServerRule(rearmed);
        return;
      }
      if (!alert.timeframe) throw new Error("Choose an alert timeframe before re-arming this browser alert.");
      setLocalAlerts((current) => current.map((candidate) => (candidate.id === id ? { ...candidate, triggered: false } : candidate)));
    },
    [databaseAuth, ownerId, replaceLocalAlerts, setLocalAlerts, updateServerRule]
  );

  const updateAlert = useCallback(
    async (id: string, input: NewAlertInput) => {
      const alert = alertsRef.current.find((candidate) => candidate.id === id);
      if (!alert) return;
      if (databaseAuth && alert.source === "server" && alert.serverRuleId && alert.serverRevision) {
        if (!ownerId) throw new Error("Alert owner is unavailable.");
        validateAlertThresholdPrecision(input.price, decimalsRef.current(input.symbol));
        const next: PriceAlert = { ...alert, ...input, triggered: false, source: "browser", suspended: true, syncState: "syncing", pendingDefinitionUpdate: true };
        const definition: PriceThresholdAlertDefinitionV1 = priceAlertDefinition(next, true);
        const retainedIndex = localAlertsRef.current.findIndex((candidate) => candidate.clientId === alert.clientId);
        const checkpoint = retainedIndex < 0
          ? [...localAlertsRef.current, next]
          : localAlertsRef.current.map((candidate, index) => index === retainedIndex ? { ...candidate, ...next } : candidate);
        if (!replaceLocalAlerts(checkpoint, ownerId, true)) throw new Error("Browser storage is unavailable; the alert update was not sent.");
        const updated = await updateAlertRule(ownerId, alert.serverRuleId, { expectedRevision: alert.serverRevision, definition });
        if (ownerRef.current === ownerId) {
          const completed = localAlertsRef.current.map((candidate) => candidate.clientId === alert.clientId ? {
            ...candidate,
            pendingDefinitionUpdate: false,
            suspended: true,
            syncState: "synced" as const,
            serverRevision: updated.revision,
            serverLifecycle: updated.lifecycleState
          } : candidate);
          if (!replaceLocalAlerts(completed, ownerId, true)) throw new Error("The server alert was updated, but its browser checkpoint could not be saved. The alert remains suspended until synchronization recovers.");
          updateServerRule(updated);
        }
        return;
      }
      setLocalAlerts((current) => current.map((candidate) => (candidate.id === id ? { ...candidate, ...input, triggered: false } : candidate)));
    },
    [databaseAuth, ownerId, setLocalAlerts, updateServerRule]
  );

  const setScreenerAlertEnabled = useCallback(
    async (ruleId: string, enabled: boolean) => {
      if (!databaseAuth || !ownerId) throw new Error("Alert owner is unavailable.");
      const rule = screenerRulesRef.current.find((candidate) => candidate.id === ruleId);
      const definition = rule?.definition;
      if (!rule || definition?.kind !== "screener") throw new Error("The screen alert is unavailable.");
      if (definition.enabled === enabled) return;
      const updated = await updateAlertRule(ownerId, rule.id, { expectedRevision: rule.revision, definition: { ...definition, enabled } });
      if (ownerRef.current === ownerId) updateServerRule(updated);
    },
    [databaseAuth, ownerId, updateServerRule]
  );

  const archiveScreenerAlert = useCallback(
    async (ruleId: string) => {
      if (!databaseAuth || !ownerId) throw new Error("Alert owner is unavailable.");
      const rule = screenerRulesRef.current.find((candidate) => candidate.id === ruleId);
      if (!rule) return;
      const archived = await archiveAlertRule(ownerId, rule.id, rule.revision);
      if (ownerRef.current === ownerId) updateServerRule(archived);
    },
    [databaseAuth, ownerId, updateServerRule]
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  // Called only by PriceAlertFeed, which already scopes to retained browser rows.
  const evaluatePrices = useCallback(
    (route: ChartDataRoute, timeframe: Timeframe, prices: Record<string, number>) => {
      if (ownerRef.current !== ownerId) return;
      // Read the durable owner snapshot on every price transition. This is the
      // final cross-tab fence: a second tab cannot fire an in-memory stale row
      // after another tab has durably suspended it and before server enable.
      const current = mergePriceAlertSnapshots(localAlertsRef.current, loadAlertSnapshot(ownerId, legacyRouteRef.current));
      if (!sameLocalSnapshot(localAlertsRef.current, current)) {
        localAlertsRef.current = current;
        setLocalState({ ownerId, alerts: current });
      }
      const evaluable = current
        .filter((alert) => alert.source !== "server" && !alert.deleted && !alert.deletionPending && !alert.suspended && alert.timeframe === timeframe);
      const result = evaluateAlertPrices(evaluable, route, prices, timeframe);
      if (result.fired.length === 0) return;
      const firedIds = new Set(result.fired.map(({ alert }) => alert.id));
      setLocalAlerts(current.map((alert) => (firedIds.has(alert.id) ? { ...alert, triggered: true } : alert)));
      deliverySequence.current += 1;
      setDeliveries((pending) => [...pending, { id: deliverySequence.current, ownerId, fired: result.fired }]);
    },
    [ownerId, setLocalAlerts]
  );

  useEffect(() => {
    if (deliveries.length === 0) {
      processedDeliveries.current.clear();
      return;
    }
    const pending = deliveries.filter((delivery) => !processedDeliveries.current.has(delivery.id));
    if (pending.length === 0) return;
    for (const delivery of pending) processedDeliveries.current.add(delivery.id);
    const fired = pending.filter((delivery) => delivery.ownerId === ownerId).flatMap((delivery) => delivery.fired);
    if (fired.length > 0) {
      for (const hit of fired) showAlertNotification(hit.alert, hit.hitPrice, decimalsRef.current(hit.alert.symbol));
      playAlertBeep();
      setToasts((current) => [
        ...current,
        ...fired.map(({ alert, hitPrice }) => ({ id: alert.id, symbol: alert.symbol, price: alert.price, direction: alert.direction, hitPrice }))
      ]);
    }
    const deliveredIds = new Set(pending.map((delivery) => delivery.id));
    setDeliveries((current) => current.filter((delivery) => !deliveredIds.has(delivery.id)));
  }, [deliveries, ownerId]);

  const activeCount = useMemo(
    () => alerts.filter((alert) => alert.source === "server" ? alert.serverLifecycle === "armed" : !alert.deleted && !alert.deletionPending && !alert.triggered && !alert.suspended && alert.timeframe !== undefined).length,
    [alerts]
  );
  const refresh = useCallback(() => setRefreshSequence((current) => current + 1), []);
  const sync: PriceAlertSyncState = {
    status: currentServerState.status,
    ...(currentServerState.error ? { error: currentServerState.error } : {}),
    ...(currentServerState.lastSyncedAt ? { lastSyncedAt: currentServerState.lastSyncedAt } : {}),
    events: currentServerState.events,
    outbox: currentServerState.outbox,
    refresh
  };

  return { alerts, browserAlerts, screenerRules, toasts, activeCount, sync, addAlert, updateAlert, removeAlert, resetAlert, setScreenerAlertEnabled, archiveScreenerAlert, dismissToast, evaluatePrices };
}

function compareServerRuleFreshness(left: AlertRuleRecordV1, right: AlertRuleRecordV1): number {
  return left.revision - right.revision || Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Alert synchronization failed.";
  return [...message]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 512) || "Alert synchronization failed.";
}

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function monotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}
