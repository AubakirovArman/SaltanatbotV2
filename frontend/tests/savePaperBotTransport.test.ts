// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveBot, type SaveBotInput, type TradingBot } from "../src/trading/tradeClient";

const ownerUserId = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

describe("durable paper bot transport", () => {
  it("sends the owner fence, one idempotency key and the exact canonical reservation body", async () => {
    const input = paperInput();
    const fetchMock = vi.fn(async () => json({ bot: savedBot(input) }));
    vi.stubGlobal("fetch", fetchMock);

    await saveBot(input, { ownerUserId, idempotencyKey: "paper-bot-command-1" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(url).toBe("/api/trade/bots");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(headers.get("X-SBV2-Expected-User")).toBe(ownerUserId);
    expect(headers.get("Idempotency-Key")).toBe("paper-bot-command-1");
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it("keeps legacy calls header-free and never retries a failed durable command", async () => {
    const legacyFetch = vi.fn(async () => json({ bot: savedBot({ exchange: "paper" }) }));
    vi.stubGlobal("fetch", legacyFetch);
    await saveBot({ exchange: "paper" });
    const legacyHeaders = new Headers(legacyFetch.mock.calls[0]?.[1]?.headers);
    expect(legacyHeaders.get("X-SBV2-Expected-User")).toBeNull();
    expect(legacyHeaders.get("Idempotency-Key")).toBeNull();

    const failedFetch = vi.fn(async () => { throw new Error("connection lost"); });
    vi.stubGlobal("fetch", failedFetch);
    await expect(saveBot(paperInput(), { ownerUserId, idempotencyKey: "stable-command" })).rejects.toThrow("connection lost");
    expect(failedFetch).toHaveBeenCalledOnce();
  });
});

function paperInput(): SaveBotInput {
  return {
    exchange: "paper",
    paperPortfolioId: "portfolio-1",
    paperAllocation: "10000.000000",
    expectedPortfolioRevision: 4,
    expectedLedgerEpoch: 1
  };
}

function savedBot(input: SaveBotInput): TradingBot {
  return {
    ...input,
    id: "bot-1",
    name: "Paper bot",
    strategyName: "Strategy",
    ir: {} as TradingBot["ir"],
    symbol: "BTCUSDT",
    timeframe: "1m",
    exchange: "paper",
    market: "futures",
    sizeMode: "quote",
    sizeValue: 100,
    leverage: 1,
    notifyMarkers: false,
    status: "stopped",
    createdAt: 1,
    updatedAt: 1
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}
