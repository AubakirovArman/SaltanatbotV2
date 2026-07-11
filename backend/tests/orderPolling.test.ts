import { describe, expect, it, vi } from "vitest";
import { pollOrderUpdates } from "../src/trading/orderPolling.js";
import type { ExchangeAdapter, OrderJournalRecord } from "../src/trading/types.js";

const record = (id: string, status: OrderJournalRecord["status"], updatedAt: number): OrderJournalRecord => ({
  id,
  botId: "bot",
  exchange: "binance",
  market: "futures",
  symbol: "BTCUSDT",
  action: "open",
  side: "buy",
  type: "limit",
  qty: 1,
  reason: "test",
  clientId: `client-${id}`,
  status,
  ts: 1,
  updatedAt
});

describe("order polling fallback", () => {
  it("polls non-terminal orders oldest-first and emits snapshots", async () => {
    const seen: string[] = [];
    const onSnapshot = vi.fn();
    const adapter = {
      orderStatus: async (_symbol: string, identity: { clientId?: string }) => {
        seen.push(identity.clientId ?? "");
        return { id: identity.clientId ?? "", clientId: identity.clientId, status: "filled", qty: 1, filledQty: 1, avgFillPrice: 100, updatedAt: 10 } as const;
      }
    } as ExchangeAdapter;

    const result = await pollOrderUpdates([
      record("terminal", "filled", 0),
      record("newer", "accepted", 3),
      record("oldest", "unknown", 1),
      record("partial", "partially_filled", 2)
    ], adapter, onSnapshot, 2);

    expect(seen).toEqual(["client-oldest", "client-partial"]);
    expect(result).toMatchObject({ checked: 2, updated: 2, failures: [], nextOffset: 2 });
    expect(onSnapshot).toHaveBeenCalledTimes(2);
  });

  it("rotates bounded batches so a large pending set cannot starve", async () => {
    const seen: string[] = [];
    const adapter = {
      orderStatus: async (_symbol: string, identity: { clientId?: string }) => {
        seen.push(identity.clientId ?? "");
        return null;
      }
    } as ExchangeAdapter;
    const records = [record("a", "accepted", 1), record("b", "accepted", 2), record("c", "accepted", 3)];

    const first = await pollOrderUpdates(records, adapter, () => {}, 2, 0);
    await pollOrderUpdates(records, adapter, () => {}, 2, first.nextOffset);

    expect(seen).toEqual(["client-a", "client-b", "client-c", "client-a"]);
  });

  it("isolates one failed signed query and continues the batch", async () => {
    const onSnapshot = vi.fn();
    const adapter = {
      orderStatus: async (_symbol: string, identity: { clientId?: string }) => {
        if (identity.clientId === "client-bad") throw new Error("rate limited");
        return { id: "ok", status: "accepted", qty: 1, filledQty: 0, updatedAt: 10 } as const;
      }
    } as ExchangeAdapter;

    const result = await pollOrderUpdates([record("bad", "accepted", 1), record("good", "accepted", 2)], adapter, onSnapshot);

    expect(result.checked).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
  });
});
