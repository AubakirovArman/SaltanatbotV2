// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTradingAccount, deleteTradingAccount, deleteTradingAccountCredentials, parseTradingAccount, parseTradingAccounts, setTradingAccountCredentials, updateTradingAccount } from "../src/trading/accountClient";

const account = {
  id: "account-1",
  label: "Primary Bybit",
  exchange: "bybit",
  ownership: "own",
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
  status: "ready",
  credential: { mode: "account_isolated", status: "configured", isolated: true },
  capabilities: { liveExecution: true, credentialIsolation: true, multipleCredentialAccounts: true },
  botIds: ["bot-1"]
} as const;

const missingAccount = {
  ...account,
  status: "credentials_missing",
  credential: { ...account.credential, status: "missing" },
  capabilities: { ...account.capabilities, liveExecution: false },
  botIds: []
} as const;

describe("per-user trading account capability boundary", () => {
  it("parses account-isolated credential status without secrets", () => {
    expect(parseTradingAccounts({ accounts: [account] })).toEqual([account]);
    expect(parseTradingAccount({ account }).credential).toEqual({ mode: "account_isolated", status: "configured", isolated: true });
  });

  it("rejects shared, understated, inconsistent or secret-bearing responses", () => {
    expect(() => parseTradingAccounts({ accounts: [{ ...account, credential: { ...account.credential, isolated: false } }] })).toThrow(/understates account credential capabilities/);
    expect(() => parseTradingAccount({ account: { ...account, credential: { mode: "legacy_exchange_shared", status: "configured", isolated: false } } })).toThrow(/credential.mode is invalid/);
    expect(() => parseTradingAccount({ account: { ...account, capabilities: { ...account.capabilities, credentialIsolation: false } } })).toThrow(/understates account credential capabilities/);
    expect(() => parseTradingAccount({ account: { ...account, capabilities: { ...account.capabilities, liveExecution: false } } })).toThrow(/inconsistent runtime capabilities/);
    expect(() => parseTradingAccount({ account: { ...account, apiSecret: "must-never-return" } })).toThrow(/must not contain exchange secrets/);
    expect(() => parseTradingAccount({ account: { ...account, credential: { ...account.credential, apiKey: "must-never-return" } } })).toThrow(/must not contain exchange secrets/);
    expect(() => parseTradingAccounts({ accounts: [{ ...account, ownership: "customer" }] })).toThrow(/ownership is invalid/);
  });

  it("uses the authenticated CSRF transport for account and credential mutations", async () => {
    sessionStorage.setItem("sbv2:session", "1");
    sessionStorage.setItem("sbv2:csrf", "csrf-test");
    const created = { ...missingAccount, id: "desk/id", label: "Managed desk", ownership: "managed" } as const;
    const updated = { ...created, label: "Managed desk updated" } as const;
    const configured = { ...updated, status: "ready", credential: { ...updated.credential, status: "configured" }, capabilities: { ...updated.capabilities, liveExecution: true } } as const;
    const cleared = { ...configured, status: "credentials_missing", credential: { ...configured.credential, status: "missing" }, capabilities: { ...configured.capabilities, liveExecution: false } } as const;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ account: created }, 201))
      .mockResolvedValueOnce(jsonResponse({ account: updated }))
      .mockResolvedValueOnce(jsonResponse({ account: configured }))
      .mockResolvedValueOnce(jsonResponse({ account: cleared }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    expect((await createTradingAccount({ label: "  Managed desk  ", exchange: "bybit", ownership: "managed" })).label).toBe("Managed desk");
    expect((await updateTradingAccount("desk/id", { label: "Managed desk updated", ownership: "managed" })).ownership).toBe("managed");
    expect((await setTradingAccountCredentials("desk/id", { apiKey: "  key-12345  ", apiSecret: "  secret-12345  " })).credential.status).toBe("configured");
    expect((await deleteTradingAccountCredentials("desk/id")).credential.status).toBe("missing");
    await expect(deleteTradingAccount("desk/id")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/trade/accounts",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ label: "Managed desk", exchange: "bybit", ownership: "managed", enabled: true }),
        headers: expect.objectContaining({ "X-CSRF-Token": "csrf-test" })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/trade/accounts/desk%2Fid", expect.objectContaining({ method: "PATCH" }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/trade/accounts/desk%2Fid/credentials", expect.objectContaining({ method: "PUT", body: JSON.stringify({ apiKey: "key-12345", apiSecret: "secret-12345" }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/trade/accounts/desk%2Fid/credentials", expect.objectContaining({ method: "DELETE" }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/trade/accounts/desk%2Fid", expect.objectContaining({ method: "DELETE" }));
  });

  it("rejects invalid mutation input and a non-acknowledged delete", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: false }));
    vi.stubGlobal("fetch", fetchMock);
    expect(() => createTradingAccount({ label: " ", exchange: "bybit", ownership: "own" })).toThrow(/label/);
    expect(() => updateTradingAccount("desk", {})).toThrow(/At least one/);
    expect(() => setTradingAccountCredentials("desk", { apiKey: "short", apiSecret: "also-short" })).toThrow(/API key/);
    await expect(deleteTradingAccount("desk")).rejects.toThrow(/Invalid delete/);
  });
});

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
