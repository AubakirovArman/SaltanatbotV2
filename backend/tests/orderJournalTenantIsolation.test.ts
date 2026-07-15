import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  getOrderJournalFrom,
  insertOrderEventInto,
  listOrderEventsForOwnerFrom,
  listOrderEventsFrom,
  listOrderJournalForOwnerFrom,
  upsertOrderJournalInto
} from "../src/trading/orderJournalStore.js";
import { insertFillInto } from "../src/trading/store.js";
import { migrateTradingStore } from "../src/trading/storeSchema.js";
import type { FillRecord, OrderJournalRecord } from "../src/trading/types.js";

const databases: DatabaseSync[] = [];

function memoryDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  migrateTradingStore(database, () => 10);
  return database;
}

function order(botId: string, marker: string): OrderJournalRecord {
  return {
    id: "shared-client-id",
    botId,
    exchange: "bybit",
    market: "futures",
    symbol: "BTCUSDT",
    action: "open",
    side: "buy",
    type: "market",
    qty: 1,
    reason: marker,
    clientId: "shared-client-id",
    status: "intent",
    ts: 20,
    updatedAt: 20
  };
}

function fill(botId: string, marker: string): FillRecord {
  return {
    id: "shared-fill-id",
    botId,
    symbol: "BTCUSDT",
    side: "buy",
    qty: 1,
    price: 100,
    fee: 0,
    realizedPnl: 0,
    kind: "open",
    reason: marker,
    ts: 20
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("tenant-safe order journal identity", () => {
  it("keeps equal client ids isolated between owners and bots", () => {
    const database = memoryDatabase();
    const insertBot = database.prepare(`
      INSERT INTO bots (id, ownerUserId, config, updatedAt)
      VALUES (?, ?, ?, ?)
    `);
    insertBot.run("bot-a", "owner-a", "{}", 10);
    insertBot.run("bot-b", "owner-b", "{}", 10);

    expect(insertFillInto(database, fill("bot-a", "owner-a-fill"))).toBe(true);
    expect(insertFillInto(database, fill("bot-b", "owner-b-fill"))).toBe(true);
    expect(insertFillInto(database, fill("bot-a", "duplicate"))).toBe(false);

    upsertOrderJournalInto(database, order("bot-a", "owner-a-order"));
    upsertOrderJournalInto(database, order("bot-b", "owner-b-order"));
    insertOrderEventInto(database, {
      id: "shared-event-id",
      orderId: "shared-client-id",
      botId: "bot-a",
      type: "intent",
      data: { marker: "owner-a-event" },
      ts: 20
    });
    insertOrderEventInto(database, {
      id: "shared-event-id",
      orderId: "shared-client-id",
      botId: "bot-b",
      type: "intent",
      data: { marker: "owner-b-event" },
      ts: 20
    });

    expect(getOrderJournalFrom(database, "bot-a", "shared-client-id")?.reason).toBe("owner-a-order");
    expect(getOrderJournalFrom(database, "bot-b", "shared-client-id")?.reason).toBe("owner-b-order");
    expect(listOrderJournalForOwnerFrom(database, "owner-a", "bot-a")).toEqual([
      expect.objectContaining({ botId: "bot-a", reason: "owner-a-order" })
    ]);
    expect(listOrderJournalForOwnerFrom(database, "owner-a", "bot-b")).toEqual([]);
    expect(listOrderJournalForOwnerFrom(database, "owner-b", "bot-a")).toEqual([]);
    expect(listOrderEventsFrom(database, "bot-a", "shared-client-id")).toEqual([
      expect.objectContaining({ botId: "bot-a", data: { marker: "owner-a-event" } })
    ]);
    expect(listOrderEventsForOwnerFrom(database, "owner-b", "bot-a", "shared-client-id")).toEqual([]);

    upsertOrderJournalInto(database, {
      ...order("bot-b", "owner-b-updated"),
      status: "accepted",
      updatedAt: 30
    });
    expect(getOrderJournalFrom(database, "bot-a", "shared-client-id")?.reason).toBe("owner-a-order");
    expect(getOrderJournalFrom(database, "bot-b", "shared-client-id")).toMatchObject({
      reason: "owner-b-updated",
      status: "accepted"
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM orders WHERE id = ?").get("shared-client-id"))
      .toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM order_events WHERE id = ?").get("shared-event-id"))
      .toEqual({ count: 2 });
    expect(database.prepare("SELECT data FROM fills WHERE id = ? ORDER BY botId").all("shared-fill-id")
      .map((row) => JSON.parse(String(row.data)).reason)).toEqual(["owner-a-fill", "owner-b-fill"]);
  });
});
