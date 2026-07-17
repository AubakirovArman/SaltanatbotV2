// @vitest-environment jsdom

import type { AlertRuleRecordV1 } from "@saltanatbotv2/contracts";
import { describe, expect, it, vi } from "vitest";
import { canonicalAlertDecimal, isServerPriceAlertCandidate, mergePriceAlertProjections, priceAlertDefinition, reconcilePriceAlerts, stablePriceAlertClientId } from "../src/alerts/priceAlertMigration";
import { groupPriceAlertSubscriptions } from "../src/market/PriceAlertFeed";
import { evaluateAlertPrices, type PriceAlert } from "../src/market/alerts";

const OWNER = "00000000-0000-4000-8000-000000000031";
const RULE_ID = "00000000-0000-4000-8000-000000000041";

describe("price alert browser-to-server migration", () => {
  it("expands small thresholds without exponent notation and rejects excess precision", () => {
    expect(canonicalAlertDecimal(1e-8)).toBe("0.00000001");
    expect(canonicalAlertDecimal(65_000.25)).toBe("65000.25");
    expect(priceAlertDefinition(local(), false).threshold).toBe("65000.25");
    expect(() => canonicalAlertDecimal(1.2345678901234568e-19)).toThrow(/precision/i);
  });

  it("keeps browser evaluation alive until the durable suspended checkpoint, then stops it", async () => {
    let retained = [local()];
    const before = groupPriceAlertSubscriptions(retained);
    expect(before.map(({ timeframe, symbols }) => [timeframe, symbols])).toEqual([["1m", ["BTCUSDT"]]]);
    expect(evaluateAlertPrices(retained, { exchange: "binance", marketType: "spot", priceType: "last" }, { BTCUSDT: 65_001 }, "1m").fired).toHaveLength(1);

    const disabled = record(retained[0], false, 1, "disabled");
    const enabled = record(retained[0], true, 2, "armed");
    const checkpoints: PriceAlert[][] = [];
    const update = vi.fn(async () => {
      expect(retained[0]).toMatchObject({ suspended: true, syncState: "syncing", serverRuleId: RULE_ID });
      expect(groupPriceAlertSubscriptions(retained)).toEqual([]);
      expect(evaluateAlertPrices(retained, { exchange: "binance", marketType: "spot", priceType: "last" }, { BTCUSDT: 65_001 }, "1m").fired).toEqual([]);
      return enabled;
    });

    const result = await reconcilePriceAlerts({
      ownerUserId: OWNER,
      localAlerts: retained,
      serverRules: [],
      read: () => retained,
      persist: (next) => {
        retained = structuredClone(next);
        checkpoints.push(retained);
      },
      api: {
        create: async () => disabled,
        update
      }
    });

    expect(update).toHaveBeenCalledOnce();
    expect(checkpoints.some((snapshot) => snapshot[0]?.suspended !== true)).toBe(true);
    expect(checkpoints.at(-1)?.[0]).toMatchObject({ suspended: true, syncState: "synced", serverRevision: 2 });
    expect(groupPriceAlertSubscriptions(result.localAlerts)).toEqual([]);
    const projections = mergePriceAlertProjections(result.localAlerts, result.serverRules, true);
    expect(projections).toHaveLength(1);
    expect(projections[0]).toMatchObject({ source: "server", serverLifecycle: "armed", timeframe: "1m" });
    expect(groupPriceAlertSubscriptions(projections)).toEqual([]);
  });

  it("resumes by clientId after a crash between suspension and server enable", async () => {
    let retained = [local({ clientId: "browser-alert:fixed" })];
    const disabled = record(retained[0], false, 1, "disabled");
    const firstCreate = vi.fn(async () => disabled);
    const failedUpdate = vi.fn(async () => {
      throw new Error("simulated crash");
    });

    await expect(reconcilePriceAlerts({
      ownerUserId: OWNER,
      localAlerts: retained,
      serverRules: [],
      read: () => retained,
      persist: (next) => {
        retained = structuredClone(next);
      },
      api: { create: firstCreate, update: failedUpdate }
    })).rejects.toThrow("simulated crash");

    expect(retained[0]).toMatchObject({ suspended: true, clientId: "browser-alert:fixed", serverRuleId: RULE_ID, syncState: "syncing" });
    expect(groupPriceAlertSubscriptions(retained)).toEqual([]);

    const retryCreate = vi.fn();
    const retry = await reconcilePriceAlerts({
      ownerUserId: OWNER,
      localAlerts: retained,
      serverRules: [disabled],
      read: () => retained,
      persist: (next) => {
        retained = structuredClone(next);
      },
      api: {
        create: retryCreate,
        update: async () => record(retained[0], true, 2, "armed")
      }
    });

    expect(retryCreate).not.toHaveBeenCalled();
    expect(retry.localAlerts[0]).toMatchObject({ suspended: true, syncState: "synced", serverRevision: 2 });
  });

  it("recovers a committed disabled draft after the create response is lost", async () => {
    let retained = [local()];
    let durableServerRules: AlertRuleRecordV1[] = [];
    const create = vi.fn(async (_owner: string, input: { clientId: string }) => {
      const committed = record({ ...retained[0], clientId: input.clientId }, false, 1, "disabled");
      durableServerRules = [committed];
      throw new Error("response lost");
    });

    await expect(reconcilePriceAlerts({
      ownerUserId: OWNER,
      localAlerts: retained,
      serverRules: [],
      read: () => retained,
      persist: (next) => {
        retained = structuredClone(next);
      },
      api: { create, update: vi.fn() }
    })).rejects.toThrow("response lost");

    expect(create).toHaveBeenCalledOnce();
    expect(durableServerRules).toHaveLength(1);
    expect(durableServerRules[0]?.definition.enabled).toBe(false);
    expect(retained[0]).toMatchObject({ clientId: durableServerRules[0]?.clientId, syncState: "syncing" });
    expect(retained[0]?.suspended).not.toBe(true);
    expect(evaluateAlertPrices(retained, { exchange: "binance", marketType: "spot", priceType: "last" }, { BTCUSDT: 65_001 }, "1m").fired).toHaveLength(1);

    const retryCreate = vi.fn();
    const recovered = await reconcilePriceAlerts({
      ownerUserId: OWNER,
      localAlerts: retained,
      serverRules: durableServerRules,
      read: () => retained,
      persist: (next) => {
        retained = structuredClone(next);
      },
      api: {
        create: retryCreate,
        update: async () => {
          const enabled = record(retained[0], true, 2, "armed");
          durableServerRules = [enabled];
          return enabled;
        }
      }
    });

    expect(retryCreate).not.toHaveBeenCalled();
    expect(durableServerRules).toHaveLength(1);
    expect(recovered.localAlerts[0]).toMatchObject({ suspended: true, syncState: "synced", serverRevision: 2 });
    expect(evaluateAlertPrices(recovered.localAlerts, { exchange: "binance", marketType: "spot", priceType: "last" }, { BTCUSDT: 65_001 }, "1m").fired).toEqual([]);
  });

  it("never overwrites a browser trigger that races with disabled-draft creation", async () => {
    let retained = [local()];
    const update = vi.fn();
    const disabled = record(retained[0], false, 1, "disabled");

    const result = await reconcilePriceAlerts({
      ownerUserId: OWNER,
      localAlerts: retained,
      serverRules: [],
      read: () => retained,
      persist: (next) => {
        retained = structuredClone(next);
      },
      api: {
        create: async () => {
          retained = retained.map((alert) => ({ ...alert, triggered: true }));
          return disabled;
        },
        update
      }
    });

    expect(update).not.toHaveBeenCalled();
    expect(result.localAlerts[0]).toMatchObject({ triggered: true, suspended: false, syncState: "needs-review", serverLifecycle: "disabled" });
    expect(result.serverRules[0]?.definition.enabled).toBe(false);
    expect(mergePriceAlertProjections(result.localAlerts, result.serverRules, true)).toEqual([
      expect.objectContaining({ id: "alert-local-1", source: "browser", triggered: true, syncState: "needs-review" })
    ]);
  });

  it("archives the disabled draft when the browser row is deleted during creation", async () => {
    let retained = [local()];
    const update = vi.fn();
    const archive = vi.fn(async () => record(retained[0] ?? local(), false, 1, "archived"));
    const disabled = record(retained[0], false, 1, "disabled");

    const result = await reconcilePriceAlerts({
      ownerUserId: OWNER,
      localAlerts: retained,
      serverRules: [],
      read: () => retained,
      persist: (next) => {
        retained = structuredClone(next);
      },
      api: {
        create: async () => {
          retained = [];
          return disabled;
        },
        update,
        archive
      }
    });

    expect(update).not.toHaveBeenCalled();
    expect(archive).toHaveBeenCalledOnce();
    expect(result.localAlerts).toEqual([]);
    expect(result.serverRules).toHaveLength(1);
    expect(result.serverRules[0]?.definition.enabled).toBe(false);
    expect(result.serverRules[0]?.lifecycleState).toBe("archived");
  });

  it("recovers a definition update committed before its local checkpoint", async () => {
    let retained = [local({
      clientId: "browser-alert:update-recovery",
      price: 66_000,
      suspended: true,
      pendingDefinitionUpdate: true,
      serverRuleId: RULE_ID,
      serverRevision: 1,
      syncState: "syncing"
    })];
    const committed = record(retained[0], true, 2, "armed");
    const update = vi.fn();

    const result = await reconcilePriceAlerts({
      ownerUserId: OWNER,
      localAlerts: retained,
      serverRules: [committed],
      read: () => retained,
      persist: (next) => {
        retained = structuredClone(next);
      },
      api: { create: vi.fn(), update, archive: vi.fn() }
    });

    expect(update).not.toHaveBeenCalled();
    expect(result.localAlerts[0]).toMatchObject({
      price: 66_000,
      pendingDefinitionUpdate: false,
      suspended: true,
      syncState: "synced",
      serverRevision: 2
    });
  });

  it("archives a linked server rule before completing a retained deletion tombstone", async () => {
    let retained = [local({
      clientId: "browser-alert:delete-recovery",
      deleted: true,
      deletionPending: true,
      suspended: true,
      serverRuleId: RULE_ID,
      serverRevision: 1,
      syncState: "deleting"
    })];
    const armed = record(retained[0], true, 1, "armed");
    const archive = vi.fn(async () => record(retained[0], true, 2, "archived"));

    const result = await reconcilePriceAlerts({
      ownerUserId: OWNER,
      localAlerts: retained,
      serverRules: [armed],
      read: () => retained,
      persist: (next) => {
        retained = structuredClone(next);
      },
      api: { create: vi.fn(), update: vi.fn(), archive }
    });

    expect(archive).toHaveBeenCalledWith(OWNER, RULE_ID, 1, undefined);
    expect(result.localAlerts[0]).toMatchObject({ deleted: true, deletionPending: false, suspended: true, serverLifecycle: "archived", syncState: "synced" });
  });

  it("imports only untriggered explicit non-month last-price alerts", () => {
    const cases: Array<[string, PriceAlert, boolean]> = [
      ["eligible", local(), true],
      ["triggered", local({ triggered: true }), false],
      ["mark", local({ priceType: "mark", marketType: "linear" }), false],
      ["index", local({ priceType: "index", marketType: "linear" }), false],
      ["missing timeframe", local({ timeframe: undefined }), false],
      ["calendar month", local({ timeframe: "1M" }), false]
    ];
    expect(cases.map(([name, alert]) => [name, isServerPriceAlertCandidate(alert)])).toEqual(cases.map(([name, , eligible]) => [name, eligible]));
    expect(stablePriceAlertClientId(local())).toMatch(/^browser-alert:[0-9a-f]{16}$/);
  });
});

function local(overrides: Partial<PriceAlert> = {}): PriceAlert {
  return {
    id: "alert-local-1",
    symbol: "BTCUSDT",
    price: 65_000.25,
    direction: "above",
    timeframe: "1m",
    createdAt: 1_752_739_200_000,
    triggered: false,
    exchange: "binance",
    marketType: "spot",
    priceType: "last",
    source: "browser",
    ...overrides
  };
}

function record(alert: PriceAlert, enabled: boolean, revision: number, lifecycleState: AlertRuleRecordV1["lifecycleState"]): AlertRuleRecordV1 {
  return {
    schemaVersion: "alert-rule-record-v1",
    id: RULE_ID,
    clientId: stablePriceAlertClientId(alert),
    revision,
    definition: priceAlertDefinition({ ...alert, triggered: false }, enabled),
    lifecycleState,
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: `2026-07-17T08:0${revision}:00.000Z`,
    researchOnly: true,
    executionPermission: false
  };
}
