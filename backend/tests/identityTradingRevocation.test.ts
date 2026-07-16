import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { MemoryIdentityRepository } from "../src/identity/memoryRepository.js";
import { IdentityService } from "../src/identity/service.js";
import { TradeStreamHub } from "../src/trading/tradeStreamHub.js";

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  send(): void {}
  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

describe("trading permission revocation", () => {
  it("revokes every session and websocket ticket before awaiting owner runtime shutdown", async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository, { allowNonAdminTrading: true });
    const admin = await service.bootstrapAdmin("tenant-admin", "temporary-Admin-password-2026");
    await repository.updateUser(admin.id, { mustChangePassword: false, updatedAt: new Date() });
    const trader = await service.register("tenant-trader", "correct-horse-battery-staple");
    const adminPrincipal = (await service.authenticate(
      (await service.login(admin.login, "temporary-Admin-password-2026")).sessionToken
    ))!;

    await service.activateUser(adminPrincipal, trader.id);
    await service.updatePermissions(adminPrincipal, trader.id, { tradingRole: "paper-trade" });

    const firstSession = await service.login(trader.login, "correct-horse-battery-staple");
    const secondSession = await service.login(trader.login, "correct-horse-battery-staple");
    const firstPrincipal = (await service.authenticate(firstSession.sessionToken))!;
    const wsTicket = await service.issueWsTicket(firstPrincipal);
    const hub = new TradeStreamHub();
    const traderSocket = new FakeSocket();
    const otherOwnerSocket = new FakeSocket();
    hub.attach(traderSocket as unknown as WebSocket, trader.id);
    hub.attach(otherOwnerSocket as unknown as WebSocket, "unrelated-owner");
    const shutdownActions: string[] = [];
    service.setTradingAccessChangeHandler(async (ownerUserId, action) => {
      expect(action).toBe("revoke");
      hub.disconnectOwner(ownerUserId);
      shutdownActions.push(`disconnect:${ownerUserId}`);
      await Promise.resolve();
      shutdownActions.push(`stop:${ownerUserId}`);
    });

    await service.updatePermissions(adminPrincipal, trader.id, { tradingRole: "none" });

    expect(await service.authenticate(firstSession.sessionToken)).toBeUndefined();
    expect(await service.authenticate(secondSession.sessionToken)).toBeUndefined();
    expect(await service.consumeWsTicket(wsTicket.ticket)).toBeUndefined();
    expect(shutdownActions).toEqual([`disconnect:${trader.id}`, `stop:${trader.id}`]);
    expect(traderSocket.closes).toEqual([{ code: 1008, reason: "Trading access changed" }]);
    expect(otherOwnerSocket.closes).toEqual([]);
    expect(hub.clientCount(trader.id)).toBe(0);
    expect(hub.clientCount("unrelated-owner")).toBe(1);
  });

  it("disconnects one logged-out session and every password-revoked session without stopping robots", async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository);
    const admin = await service.bootstrapAdmin("stream-admin", "temporary-Admin-password-2026");
    const first = await service.login(admin.login, "temporary-Admin-password-2026");
    const second = await service.login(admin.login, "temporary-Admin-password-2026");
    const firstPrincipal = (await service.authenticate(first.sessionToken))!;
    const secondPrincipal = (await service.authenticate(second.sessionToken))!;
    const hub = new TradeStreamHub();
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const unrelatedSocket = new FakeSocket();
    hub.attach(firstSocket as unknown as WebSocket, admin.id, undefined, firstPrincipal.sessionIdHash);
    hub.attach(secondSocket as unknown as WebSocket, admin.id, undefined, secondPrincipal.sessionIdHash);
    hub.attach(unrelatedSocket as unknown as WebSocket, "unrelated-owner", undefined, "unrelated-session");
    const tradingActions: string[] = [];
    service.setTradingAccessChangeHandler((ownerUserId, action) => {
      tradingActions.push(`${action}:${ownerUserId}`);
    });
    service.setSessionRevocationHandler(({ userId, sessionIdHash, reason }) => {
      if (sessionIdHash) hub.disconnectSession(sessionIdHash, `Session ${reason}`);
      else hub.disconnectOwner(userId, `Session ${reason}`);
    });

    await service.logout(firstPrincipal);

    expect(firstSocket.closes).toEqual([{ code: 1008, reason: "Session logout" }]);
    expect(secondSocket.closes).toEqual([]);
    expect(unrelatedSocket.closes).toEqual([]);
    expect(tradingActions).toEqual([]);

    await service.changePassword(
      secondPrincipal,
      "temporary-Admin-password-2026",
      "permanent-Secure-password-2027"
    );

    expect(secondSocket.closes).toEqual([{ code: 1008, reason: "Session password_changed" }]);
    expect(unrelatedSocket.closes).toEqual([]);
    expect(tradingActions).toEqual([`revoke:${admin.id}`, `restore:${admin.id}`]);
    expect(await service.authenticate(second.sessionToken)).toBeUndefined();
  });
});
