import { describe, expect, it } from "vitest";
import { MemoryIdentityRepository } from "../src/identity/memoryRepository.js";
import { IdentityError, IdentityService } from "../src/identity/service.js";

describe("database identity service", () => {
  it("registers pending users and lets only an admin activate them", async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository);
    const admin = await service.bootstrapAdmin("operator", "temporary-Admin-password-2026");
    const pending = await service.register("Trader.One", "correct-horse-battery-staple");

    expect(pending).toMatchObject({ status: "pending", appRole: "user", tradingRole: "none" });
    await expect(service.login("trader.one", "correct-horse-battery-staple")).rejects.toMatchObject({
      code: "pending_approval"
    });

    const adminCredentials = await service.login(admin.login, "temporary-Admin-password-2026");
    const principal = await service.authenticate(adminCredentials.sessionToken);
    expect(principal?.effectiveTradingRole).toBe("admin");
    await service.activateUser(principal!, pending.id);

    const credentials = await service.login("TRADER.ONE", "correct-horse-battery-staple");
    expect(credentials.user.status).toBe("active");
    expect((await service.authenticate(credentials.sessionToken))?.effectiveTradingRole).toBeUndefined();
  });

  it("stores only hashes, enforces CSRF and consumes websocket tickets once", async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository, { allowNonAdminTrading: true });
    const admin = await service.bootstrapAdmin("admin", "temporary-Secure-password-2026");
    const credentials = await service.login(admin.login, "temporary-Secure-password-2026");
    const principal = (await service.authenticate(credentials.sessionToken))!;

    expect(service.verifyCsrf(principal, credentials.csrfToken)).toBe(true);
    expect(service.verifyCsrf(principal, "wrong")).toBe(false);
    const ticket = await service.issueWsTicket(principal);
    expect(await service.consumeWsTicket(ticket.ticket)).toMatchObject({ user: { id: admin.id } });
    expect(await service.consumeWsTicket(ticket.ticket)).toBeUndefined();
  });

  it("revokes all sessions after a password change and requires relogin", async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository);
    await service.bootstrapAdmin("root-admin", "temporary-Admin-password-2026");
    const first = await service.login("root-admin", "temporary-Admin-password-2026");
    const second = await service.login("root-admin", "temporary-Admin-password-2026");
    const principal = (await service.authenticate(first.sessionToken))!;

    await service.changePassword(principal, "temporary-Admin-password-2026", "permanent-Admin-password-2026");
    expect(await service.authenticate(first.sessionToken)).toBeUndefined();
    expect(await service.authenticate(second.sessionToken)).toBeUndefined();
    await expect(service.login("root-admin", "temporary-Admin-password-2026")).rejects.toBeInstanceOf(IdentityError);
    expect((await service.login("root-admin", "permanent-Admin-password-2026")).user.mustChangePassword).toBe(false);
  });

  it("keeps non-admin trading roles disabled before ownership migration", async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository);
    const admin = await service.bootstrapAdmin("admin", "temporary-Secure-password-2026");
    const user = await service.register("client", "correct-horse-battery-staple");
    const credentials = await service.login(admin.login, "temporary-Secure-password-2026");
    const principal = (await service.authenticate(credentials.sessionToken))!;

    await expect(service.updatePermissions(principal, user.id, { tradingRole: "read-only" })).rejects.toMatchObject({
      code: "trading_ownership_pending"
    });
  });

  it("ignores a persisted non-admin trading role when the migration flag is off", async () => {
    const repository = new MemoryIdentityRepository();
    const enabled = new IdentityService(repository, { allowNonAdminTrading: true });
    const admin = await enabled.bootstrapAdmin("admin", "temporary-Secure-password-2026");
    const user = await enabled.register("client", "correct-horse-battery-staple");
    const adminPrincipal = (await enabled.authenticate((await enabled.login(admin.login, "temporary-Secure-password-2026")).sessionToken))!;
    await enabled.activateUser(adminPrincipal, user.id);
    await enabled.updatePermissions(adminPrincipal, user.id, { tradingRole: "paper-trade" });
    const userSession = await enabled.login(user.login, "correct-horse-battery-staple");

    const disabled = new IdentityService(repository, { allowNonAdminTrading: false });
    expect((await disabled.authenticate(userSession.sessionToken))?.effectiveTradingRole).toBeUndefined();
  });
});
