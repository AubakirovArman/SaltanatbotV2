// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTradingAccount, deleteTradingAccount, parseTradingAccount, parseTradingAccounts, updateTradingAccount } from "../src/trading/accountClient";

const account = {
  id: "bybit:default",
  label: "Primary Bybit",
  exchange: "bybit",
  ownership: "own",
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
  status: "ready",
  credential: { mode: "legacy_exchange_shared", status: "configured", isolated: false },
  capabilities: { liveExecution: true, credentialIsolation: false, multipleCredentialAccounts: false },
  botIds: ["bot-1"]
};

describe("trading account capability boundary", () => {
  it("parses non-secret account metadata and explicit credential limitations", () => {
    expect(parseTradingAccounts({ accounts: [account] })).toEqual([account]);
  });

  it("rejects responses that overstate isolated multi-account credentials", () => {
    expect(() =>
      parseTradingAccounts({
        accounts: [{ ...account, capabilities: { ...account.capabilities, credentialIsolation: true } }]
      })
    ).toThrow(/overstates account credential capabilities/);
    expect(() => parseTradingAccounts({ accounts: [{ ...account, ownership: "customer" }] })).toThrow(/ownership is invalid/);
    expect(() => parseTradingAccount({ account: { ...account, capabilities: { ...account.capabilities, multipleCredentialAccounts: true } } })).toThrow(/overstates account credential capabilities/);
    expect(() => parseTradingAccount({ account: { ...account, id: "bybit:managed" } })).toThrow(/overstates the legacy shared credential binding/);
    expect(() =>
      parseTradingAccount({
        account: {
          ...account,
          id: "desk-1",
          status: "metadata_only",
          credential: { mode: "unsupported", status: "unsupported", isolated: false },
          capabilities: { liveExecution: true, credentialIsolation: false, multipleCredentialAccounts: false }
        }
      })
    ).toThrow(/overstates account runtime capabilities/);
  });

  it("uses the authenticated CSRF transport and validates every mutation response", async () => {
    sessionStorage.setItem("sbv2:session", "1");
    sessionStorage.setItem("sbv2:csrf", "csrf-test");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ account: { ...account, id: "desk/id", label: "Managed desk", status: "metadata_only", credential: { mode: "unsupported", status: "unsupported", isolated: false }, capabilities: { liveExecution: false, credentialIsolation: false, multipleCredentialAccounts: false }, botIds: [] } }, 201)
      )
      .mockResolvedValueOnce(
        jsonResponse({
          account: {
            ...account,
            id: "desk/id",
            label: "Managed desk updated",
            ownership: "managed",
            status: "metadata_only",
            credential: { mode: "unsupported", status: "unsupported", isolated: false },
            capabilities: { liveExecution: false, credentialIsolation: false, multipleCredentialAccounts: false },
            botIds: []
          }
        })
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    expect((await createTradingAccount({ label: "  Managed desk  ", exchange: "bybit", ownership: "managed" })).label).toBe("Managed desk");
    expect((await updateTradingAccount("desk/id", { label: "Managed desk updated", ownership: "managed" })).ownership).toBe("managed");
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
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/trade/accounts/desk%2Fid", expect.objectContaining({ method: "DELETE" }));
  });

  it("rejects invalid mutation input and a non-acknowledged delete", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: false }));
    vi.stubGlobal("fetch", fetchMock);
    expect(() => createTradingAccount({ label: " ", exchange: "bybit", ownership: "own" })).toThrow(/label/);
    expect(() => updateTradingAccount("desk", {})).toThrow(/At least one/);
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
