import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionAuthorizationSnapshot } from "../src/identity/service.js";
import { runtimePolicyFromConfig } from "../src/runtimeProfile.js";
import { ExecutionAuthority, type ExecutionAuthoritySource } from "../src/trading/executionAuthority.js";
import { BinanceSignedClient } from "../src/trading/exchange/binanceClient.js";
import { BybitV5Client } from "../src/trading/exchange/bybitClient.js";
import { ExchangeRequestGuard } from "../src/trading/exchange/requestGuard.js";
import {
  DENY_SIGNED_REQUEST_AUTHORIZER,
  signedRequestAuthorizerFromExecutionHandoff,
  type SignedRequestAuthorizer
} from "../src/trading/exchange/signedRequestGate.js";
import type { TradingAccountAuthorizationState, TradingOwnerAuthorityState } from "../src/trading/tradingAccountStore.js";
import { signedRequestAuthorizerForTests } from "./support/signedRequestAuthorizer.js";

const keys = { apiKey: "test-key", apiSecret: "test-secret" };
const live = runtimePolicyFromConfig({ runtimeProfile: "private-live" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mandatory signed REST request gate", () => {
  it("keeps signing clocks and fetch at zero for denied or missing authorizers", async () => {
    const binanceFetch = vi.fn();
    const binanceNow = vi.fn(() => 10);
    const deniedBinance = new BinanceSignedClient(keys, "futures", DENY_SIGNED_REQUEST_AUTHORIZER, {
      fetch: binanceFetch as never,
      now: binanceNow,
      requestGuard: guard("Binance"),
      runtimePolicy: live
    });
    await expect(deniedBinance.request("GET", "/fapi/v2/balance")).rejects.toMatchObject({ code: "SIGNED_REQUEST_DENIED" });
    expect(binanceNow).not.toHaveBeenCalled();
    expect(binanceFetch).not.toHaveBeenCalled();

    const missingBinance = new BinanceSignedClient(keys, "futures", undefined as never, {
      fetch: binanceFetch as never,
      now: binanceNow,
      requestGuard: guard("Binance"),
      runtimePolicy: live
    });
    await expect(missingBinance.request("GET", "/fapi/v2/balance")).rejects.toMatchObject({ code: "SIGNED_REQUEST_AUTHORIZER_REQUIRED" });
    expect(binanceNow).not.toHaveBeenCalled();
    expect(binanceFetch).not.toHaveBeenCalled();

    const bybitFetch = vi.fn();
    const bybitNow = vi.fn(() => 20);
    const deniedBybit = new BybitV5Client(keys, "futures", DENY_SIGNED_REQUEST_AUTHORIZER, {
      fetch: bybitFetch as never,
      now: bybitNow,
      requestGuard: guard("Bybit"),
      runtimePolicy: live
    });
    await expect(deniedBybit.request("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" })).rejects.toMatchObject({ code: "SIGNED_REQUEST_DENIED" });
    expect(bybitNow).not.toHaveBeenCalled();
    expect(bybitFetch).not.toHaveBeenCalled();
  });

  it("resolves the default fetch at call time and still keeps DENY at zero fetch", async () => {
    const firstGlobalFetch = vi.fn();
    const currentGlobalFetch = vi.fn(async () => json([]));
    const signingNow = vi.fn(() => 10);
    vi.stubGlobal("fetch", firstGlobalFetch);
    const denied = new BinanceSignedClient(keys, "futures", DENY_SIGNED_REQUEST_AUTHORIZER, {
      now: signingNow,
      requestGuard: guard("Binance"),
      runtimePolicy: live
    });
    vi.stubGlobal("fetch", currentGlobalFetch);
    await expect(denied.request("GET", "/fapi/v2/balance")).rejects.toMatchObject({ code: "SIGNED_REQUEST_DENIED" });
    expect(signingNow).not.toHaveBeenCalled();
    expect(firstGlobalFetch).not.toHaveBeenCalled();
    expect(currentGlobalFetch).not.toHaveBeenCalled();

    const allowed = new BinanceSignedClient(keys, "futures", signedRequestAuthorizerForTests({ maxConsumes: 1 }), {
      now: signingNow,
      requestGuard: guard("Binance"),
      runtimePolicy: live
    });
    await allowed.request("GET", "/fapi/v2/balance");
    expect(firstGlobalFetch).not.toHaveBeenCalled();
    expect(currentGlobalFetch).toHaveBeenCalledTimes(1);
  });

  it("consumes one permit once and rejects reuse before a second fetch", async () => {
    const binanceFetch = vi.fn(async () => json([]));
    const binanceNow = vi.fn(() => 10);
    const binanceAuthorizer = signedRequestAuthorizerForTests({
      expected: { venue: "binance", market: "futures", method: "GET", path: "/fapi/v2/balance", payload: {} },
      maxConsumes: 1,
      onConsume: () => {
        expect(binanceNow).not.toHaveBeenCalled();
        expect(binanceFetch).not.toHaveBeenCalled();
      }
    });
    const binance = new BinanceSignedClient(keys, "futures", binanceAuthorizer, {
      fetch: binanceFetch as never,
      now: binanceNow,
      requestGuard: guard("Binance"),
      runtimePolicy: live
    });
    await expect(binance.request("GET", "/fapi/v2/balance")).resolves.toEqual([]);
    await expect(binance.request("GET", "/fapi/v2/balance")).rejects.toThrow(/permit reuse/);
    expect(binanceAuthorizer.consumedCount()).toBe(1);
    expect(binanceNow).toHaveBeenCalledTimes(1);
    expect(binanceFetch).toHaveBeenCalledTimes(1);

    const bybitFetch = vi.fn(async () => bybitJson({ list: [] }));
    const bybitNow = vi.fn(() => 20);
    const bybitAuthorizer = signedRequestAuthorizerForTests({
      expected: { venue: "bybit", market: "futures", method: "GET", path: "/v5/account/wallet-balance", payload: { accountType: "UNIFIED" } },
      maxConsumes: 1,
      onConsume: () => {
        expect(bybitNow).not.toHaveBeenCalled();
        expect(bybitFetch).not.toHaveBeenCalled();
      }
    });
    const bybit = new BybitV5Client(keys, "futures", bybitAuthorizer, {
      fetch: bybitFetch as never,
      now: bybitNow,
      requestGuard: guard("Bybit"),
      runtimePolicy: live
    });
    await expect(bybit.request("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" })).resolves.toMatchObject({ retCode: 0 });
    await expect(bybit.request("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" })).rejects.toThrow(/permit reuse/);
    expect(bybitAuthorizer.consumedCount()).toBe(1);
    expect(bybitNow).toHaveBeenCalledTimes(1);
    expect(bybitFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a descriptor mismatch before timestamp, HMAC or fetch", async () => {
    const binanceFetch = vi.fn();
    const binanceNow = vi.fn(() => 10);
    const binance = new BinanceSignedClient(
      keys,
      "futures",
      signedRequestAuthorizerForTests({
        expected: { venue: "binance", market: "futures", method: "GET", path: "/fapi/v2/positionRisk", payload: { symbol: "BTCUSDT" } },
        maxConsumes: 1
      }),
      {
        fetch: binanceFetch as never,
        now: binanceNow,
        requestGuard: guard("Binance"),
        runtimePolicy: live
      }
    );
    await expect(binance.request("GET", "/fapi/v2/positionRisk", { symbol: "ETHUSDT" })).rejects.toThrow(/wrong descriptor/);
    expect(binanceNow).not.toHaveBeenCalled();
    expect(binanceFetch).not.toHaveBeenCalled();

    const bybitFetch = vi.fn();
    const bybitNow = vi.fn(() => 20);
    const bybit = new BybitV5Client(
      keys,
      "futures",
      signedRequestAuthorizerForTests({
        expected: {
          venue: "bybit",
          market: "futures",
          method: "POST",
          path: "/v5/order/create",
          payload: { category: "linear", symbol: "BTCUSDT", side: "Buy", orderType: "Market", qty: "1", positionIdx: 0 }
        },
        maxConsumes: 1
      }),
      {
        fetch: bybitFetch as never,
        now: bybitNow,
        requestGuard: guard("Bybit"),
        runtimePolicy: live
      }
    );
    await expect(bybit.request("POST", "/v5/order/create", { category: "linear", symbol: "BTCUSDT", side: "Buy", orderType: "Market", qty: "2", positionIdx: 0 })).rejects.toThrow(/wrong descriptor/);
    expect(bybitNow).not.toHaveBeenCalled();
    expect(bybitFetch).not.toHaveBeenCalled();
  });

  it("authorizes the exact normalized GET wire payload actually sent", async () => {
    const fetcher = vi.fn(async () => bybitJson({ list: [] }));
    const authorizer = signedRequestAuthorizerForTests({
      maxConsumes: 1,
      onConsume: (request) => {
        expect(request).toEqual({
          venue: "bybit",
          market: "futures",
          method: "GET",
          path: "/v5/order/realtime",
          payload: { category: "linear", limit: "50", settleCoin: "USDT" }
        });
        expect(Object.isFrozen(request)).toBe(true);
        expect(Object.isFrozen(request.payload)).toBe(true);
      }
    });
    const client = new BybitV5Client(keys, "futures", authorizer, {
      fetch: fetcher as never,
      now: () => 20,
      requestGuard: guard("Bybit"),
      runtimePolicy: live
    });
    await client.request("GET", "/v5/order/realtime", { category: "linear", limit: 50, settleCoin: "USDT", cursor: undefined });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("category=linear&limit=50&settleCoin=USDT");
  });

  it("allows an async durable check to invoke signing while consume is still active", async () => {
    const fetcher = vi.fn(async () => bybitJson({ list: [] }));
    const signingNow = vi.fn(() => 20);
    let durableReads = 0;
    const authorizer: SignedRequestAuthorizer = {
      async consume<T>(_request: unknown, afterConsume: () => T): Promise<Awaited<T>> {
        await Promise.resolve();
        durableReads += 1;
        return await afterConsume();
      }
    };
    const client = new BybitV5Client(keys, "futures", authorizer, {
      fetch: fetcher as never,
      now: signingNow,
      requestGuard: guard("Bybit"),
      runtimePolicy: live
    });
    await expect(client.request("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" })).resolves.toMatchObject({ retCode: 0 });
    expect(durableReads).toBe(1);
    expect(signingNow).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects zero, repeated and post-completion continuations", async () => {
    const fetcher = vi.fn(async () => bybitJson({ list: [] }));
    let deferred: (() => Promise<unknown>) | undefined;
    const zeroAuthorizer: SignedRequestAuthorizer = {
      consume<T>(_request: unknown, afterConsume: () => T): T {
        deferred = afterConsume as () => Promise<unknown>;
        return undefined as T;
      }
    };
    const zeroClient = new BybitV5Client(keys, "futures", zeroAuthorizer, {
      fetch: fetcher as never,
      now: () => 20,
      requestGuard: guard("Bybit"),
      runtimePolicy: live
    });
    await expect(zeroClient.request("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" })).rejects.toMatchObject({ code: "SIGNED_REQUEST_DENIED" });
    expect(() => deferred?.()).toThrow(expect.objectContaining({ code: "SIGNED_REQUEST_AUTHORIZER_PROTOCOL" }));
    expect(fetcher).not.toHaveBeenCalled();

    const repeatedAuthorizer: SignedRequestAuthorizer = {
      consume<T>(_request: unknown, afterConsume: () => T): T {
        const first = afterConsume();
        try {
          afterConsume();
        } catch {
          // The gate must remember the protocol violation even if an
          // authorizer attempts to swallow it.
        }
        return first;
      }
    };
    const repeatedClient = new BybitV5Client(keys, "futures", repeatedAuthorizer, {
      fetch: fetcher as never,
      now: () => 20,
      requestGuard: guard("Bybit"),
      runtimePolicy: live
    });
    await expect(repeatedClient.request("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" })).rejects.toMatchObject({ code: "SIGNED_REQUEST_AUTHORIZER_PROTOCOL" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("gives the production signed transport zero fetches when ExecutionAuthority durable revalidation denies", async () => {
    let authorization: ExecutionAuthorizationSnapshot = {
      ownerUserId: "owner-a",
      authorizationRevision: 7,
      authorizationEpoch: 3,
      role: "live-trade"
    };
    const account: TradingAccountAuthorizationState = {
      ownerUserId: "owner-a",
      accountId: "account-a",
      exchange: "bybit",
      enabled: true,
      authorizationRevision: 5,
      credentialRevision: 4,
      credentialsConfigured: true
    };
    const owner: TradingOwnerAuthorityState = { ownerUserId: "owner-a", armed: true, epoch: 9, updatedAt: 1 };
    const source: ExecutionAuthoritySource = {
      loadAuthorization: async () => ({ ...authorization }),
      loadSessionAuthorization: async () => undefined,
      isAuthorizationCurrent: (snapshot) => snapshot.ownerUserId === authorization.ownerUserId && snapshot.authorizationRevision === authorization.authorizationRevision && snapshot.authorizationEpoch === authorization.authorizationEpoch && snapshot.role === authorization.role,
      loadAccount: () => ({ ...account }),
      loadOwnerAuthority: () => ({ ...owner })
    };
    const authority = new ExecutionAuthority(source, live);
    const signedRequest = {
      venue: "bybit",
      market: "futures",
      method: "GET",
      path: "/v5/account/wallet-balance",
      payload: { accountType: "UNIFIED" }
    } as const;
    const issued = await authority.issue({
      ownerUserId: "owner-a",
      accountId: "account-a",
      operation: { kind: "telemetry", operationId: "telemetry-a" },
      signedRequest,
      intentId: "intent-a",
      intentDigest: "a".repeat(64),
      rulesFingerprint: null
    });
    const handed = authority.handoff(issued, authority.expected(issued));
    const authorizer = signedRequestAuthorizerFromExecutionHandoff(authority, handed);
    authorization = { ...authorization, authorizationRevision: authorization.authorizationRevision + 1 };
    const fetcher = vi.fn();
    const client = new BybitV5Client(keys, "futures", authorizer, {
      fetch: fetcher as never,
      runtimePolicy: live
    });

    await expect(client.request("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" })).rejects.toMatchObject({ code: "PERMIT_CURRENT_STATE_CHANGED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bridges one authority handoff and rejects reuse before another fetch", async () => {
    const authorization: ExecutionAuthorizationSnapshot = {
      ownerUserId: "owner-a",
      authorizationRevision: 7,
      authorizationEpoch: 3,
      role: "live-trade"
    };
    const account: TradingAccountAuthorizationState = {
      ownerUserId: "owner-a",
      accountId: "account-a",
      exchange: "bybit",
      enabled: true,
      authorizationRevision: 5,
      credentialRevision: 4,
      credentialsConfigured: true
    };
    const owner: TradingOwnerAuthorityState = { ownerUserId: "owner-a", armed: true, epoch: 9, updatedAt: 1 };
    const authority = new ExecutionAuthority(
      {
        loadAuthorization: async () => ({ ...authorization }),
        loadSessionAuthorization: async () => undefined,
        isAuthorizationCurrent: (snapshot) => snapshot.ownerUserId === authorization.ownerUserId
          && snapshot.authorizationRevision === authorization.authorizationRevision
          && snapshot.authorizationEpoch === authorization.authorizationEpoch
          && snapshot.role === authorization.role,
        loadAccount: () => ({ ...account }),
        loadOwnerAuthority: () => ({ ...owner })
      },
      live
    );
    const signedRequest = {
      venue: "bybit",
      market: "futures",
      method: "GET",
      path: "/v5/account/wallet-balance",
      payload: { accountType: "UNIFIED" }
    } as const;
    const issued = await authority.issue({
      ownerUserId: "owner-a",
      accountId: "account-a",
      operation: { kind: "telemetry", operationId: "telemetry-a" },
      signedRequest,
      intentId: "intent-a",
      intentDigest: "a".repeat(64),
      rulesFingerprint: null
    });
    const authorizer = signedRequestAuthorizerFromExecutionHandoff(
      authority,
      authority.handoff(issued, authority.expected(issued))
    );
    const fetcher = vi.fn(async () => bybitJson({ list: [{ totalEquity: "10", totalAvailableBalance: "8" }] }));
    const client = new BybitV5Client(keys, "futures", authorizer, {
      fetch: fetcher as never,
      runtimePolicy: live
    });

    await expect(client.request("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" })).resolves.toMatchObject({
      result: { list: [{ totalEquity: "10", totalAvailableBalance: "8" }] }
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockClear();
    await expect(client.request("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" })).rejects.toMatchObject({ code: "PERMIT_REUSED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

function guard(exchange: string): ExchangeRequestGuard {
  return new ExchangeRequestGuard(exchange, () => 0, { capacity: 100, reserveRatio: 1 });
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function bybitJson(result: unknown): Response {
  return json({ retCode: 0, retMsg: "OK", result });
}
