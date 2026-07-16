import { describe, expect, it } from "vitest";
import { MemoryIdentityRepository } from "../src/identity/memoryRepository.js";
import {
  IdentityError,
  IdentityService,
  type AdminLifecycleMutationInput
} from "../src/identity/service.js";
import type { IdentityPrincipal } from "../src/identity/types.js";

describe("database identity service", () => {
  it("bootstraps exactly one administrator under concurrent attempts", async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository);

    const attempts = await Promise.allSettled([service.bootstrapAdmin("first-operator", "temporary-Secure-password-2026"), service.bootstrapAdmin("second-operator", "temporary-Secure-password-2026")]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejection = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejection).toMatchObject({ reason: { code: "admin_exists" } });
    expect((await repository.listUsers()).filter((user) => user.appRole === "admin")).toHaveLength(1);
  });

  it("keeps one active administrator when two admins disable each other concurrently", async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository);
    const first = await service.bootstrapAdmin("first-admin", "temporary-Secure-password-2026");
    await makeAdminReady(repository, first.id);
    const second = await service.register("second-admin", "correct-horse-battery-staple");
    const firstPrincipal = (await service.authenticate((await service.login(first.login, "temporary-Secure-password-2026")).sessionToken))!;
    await activate(service, repository, firstPrincipal, second.id);
    await permissions(service, repository, firstPrincipal, second.id, { appRole: "admin" });
    const secondPrincipal = (await service.authenticate((await service.login(second.login, "correct-horse-battery-staple")).sessionToken))!;

    const attempts = await Promise.allSettled([
      disable(service, repository, firstPrincipal, second.id),
      disable(service, repository, secondPrincipal, first.id)
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === "rejected")).toMatchObject({
      reason: { code: "admin_required" }
    });
    expect((await repository.listUsers()).filter((user) => user.status === "active" && user.appRole === "admin")).toHaveLength(1);
  });

  it("preserves the explicit self-demotion guard", async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository);
    const admin = await service.bootstrapAdmin("admin", "temporary-Secure-password-2026");
    await makeAdminReady(repository, admin.id);
    const principal = (await service.authenticate((await service.login(admin.login, "temporary-Secure-password-2026")).sessionToken))!;

    await expect(permissions(service, repository, principal, admin.id, { appRole: "user" })).rejects.toMatchObject({
      code: "self_demote"
    });
  });

  it("rejects every mutation from a concurrently disabled stale admin principal", async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository);
    const first = await service.bootstrapAdmin("first-admin", "temporary-Secure-password-2026");
    await makeAdminReady(repository, first.id);
    const second = await service.register("second-admin", "correct-horse-battery-staple");
    const firstPrincipal = (await service.authenticate((await service.login(first.login, "temporary-Secure-password-2026")).sessionToken))!;
    await activate(service, repository, firstPrincipal, second.id);
    await permissions(service, repository, firstPrincipal, second.id, { appRole: "admin" });
    const secondPrincipal = (await service.authenticate((await service.login(second.login, "correct-horse-battery-staple")).sessionToken))!;
    await disable(service, repository, firstPrincipal, second.id);

    await expect(permissions(service, repository, secondPrincipal, first.id, { tradingRole: "read-only" })).rejects.toMatchObject({
      code: "admin_required"
    });
    expect(await repository.findUserById(first.id)).toMatchObject({ status: "active", appRole: "admin" });
  });

  it("atomically revalidates an admin before a concurrent subject activation", async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository);
    const first = await service.bootstrapAdmin("first-admin", "temporary-Secure-password-2026");
    await makeAdminReady(repository, first.id);
    const second = await service.register("second-admin", "correct-horse-battery-staple");
    const pending = await service.register("pending-user", "pending-horse-battery-staple");
    const firstPrincipal = (await service.authenticate((await service.login(first.login, "temporary-Secure-password-2026")).sessionToken))!;
    await activate(service, repository, firstPrincipal, second.id);
    await permissions(service, repository, firstPrincipal, second.id, { appRole: "admin" });
    const secondPrincipal = (await service.authenticate((await service.login(second.login, "correct-horse-battery-staple")).sessionToken))!;

    const [disableAttempt, staleActivation] = await Promise.allSettled([
      disable(service, repository, firstPrincipal, second.id),
      activate(service, repository, secondPrincipal, pending.id)
    ]);

    expect(disableAttempt.status).toBe("fulfilled");
    expect(staleActivation).toMatchObject({ status: "rejected", reason: { code: "admin_required" } });
    const unchanged = await repository.findUserById(pending.id);
    expect(unchanged).toMatchObject({ status: "pending" });
    expect(unchanged?.approvedBy).toBeUndefined();
  });

  it("revalidates the durable temporary-password gate inside the admin mutation", async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository);
    const admin = await service.bootstrapAdmin("temporary-admin", "temporary-Secure-password-2026");
    const pending = await service.register("pending-user", "pending-horse-battery-staple");
    const principal = (await service.authenticate((await service.login(admin.login, "temporary-Secure-password-2026")).sessionToken))!;

    await expect(activate(service, repository, principal, pending.id)).rejects.toMatchObject({ code: "password_change_required" });
    expect(await repository.findUserById(pending.id)).toMatchObject({ status: "pending" });
  });

  it("fails closed while a durable authorization transition is in flight", async () => {
    const repository = new BlockingAdminMutationRepository();
    const service = new IdentityService(repository);
    const admin = await service.bootstrapAdmin("transition-admin", "temporary-Secure-password-2026");
    await makeAdminReady(repository, admin.id);
    const trader = await service.register("transition-trader", "correct-horse-battery-staple");
    const adminPrincipal = (await service.authenticate((await service.login(admin.login, "temporary-Secure-password-2026")).sessionToken))!;
    await activate(service, repository, adminPrincipal, trader.id);
    await permissions(service, repository, adminPrincipal, trader.id, { tradingRole: "paper-trade" });
    const traderPrincipal = (await service.authenticate((await service.login(trader.login, "correct-horse-battery-staple")).sessionToken))!;
    const wsTicket = await service.issueWsTicket(traderPrincipal);
    const barrier = repository.blockNextAdminMutation();

    const downgrade = permissions(service, repository, adminPrincipal, trader.id, { tradingRole: "none" });
    await barrier.entered;
    try {
      expect(await service.revalidatePrincipal(traderPrincipal)).toBeUndefined();
      expect(service.isAuthorizationCurrent(traderPrincipal)).toBe(false);
      expect(await service.consumeWsTicket(wsTicket.ticket)).toBeUndefined();
    } finally {
      barrier.release();
    }
    await expect(downgrade).resolves.toMatchObject({ tradingRole: "none" });
  });

  it("registers pending users and lets only an admin activate them", async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository);
    const admin = await service.bootstrapAdmin("operator", "temporary-Admin-password-2026");
    await makeAdminReady(repository, admin.id);
    const pending = await service.register("Trader.One", "correct-horse-battery-staple");

    expect(pending).toMatchObject({ status: "pending", appRole: "user", tradingRole: "none" });
    await expect(service.login("trader.one", "correct-horse-battery-staple")).rejects.toMatchObject({
      code: "pending_approval"
    });

    const adminCredentials = await service.login(admin.login, "temporary-Admin-password-2026");
    const principal = await service.authenticate(adminCredentials.sessionToken);
    expect(principal?.effectiveTradingRole).toBe("admin");
    await activate(service, repository, principal!, pending.id);

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

  it("assigns non-admin trading roles after owner isolation is available", async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository);
    const admin = await service.bootstrapAdmin("admin", "temporary-Secure-password-2026");
    await makeAdminReady(repository, admin.id);
    const user = await service.register("client", "correct-horse-battery-staple");
    const credentials = await service.login(admin.login, "temporary-Secure-password-2026");
    const principal = (await service.authenticate(credentials.sessionToken))!;

    await activate(service, repository, principal, user.id);
    await expect(permissions(service, repository, principal, user.id, { tradingRole: "read-only" })).resolves.toMatchObject({
      id: user.id,
      tradingRole: "read-only"
    });
    expect(await service.tradingRoleForUser(user.id)).toBe("read-only");
    await disable(service, repository, principal, user.id);
    expect(await service.tradingRoleForUser(user.id)).toBeUndefined();
  });

  it("forbids new live-trading grants before the HTTPS rollout", async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository);
    const admin = await service.bootstrapAdmin("live-admin", "temporary-Secure-password-2026");
    await makeAdminReady(repository, admin.id);
    const user = await service.register("live-client", "correct-horse-battery-staple");
    const principal = (await service.authenticate(
      (await service.login(admin.login, "temporary-Secure-password-2026")).sessionToken
    ))!;
    await activate(service, repository, principal, user.id);

    await expect(
      permissions(service, repository, principal, user.id, {
        tradingRole: "live-trade"
      })
    ).rejects.toMatchObject({ code: "live_trading_role_forbidden" });
  });

  it("fails closed when a legacy live role would survive activation, reactivation or demotion", async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository);
    const admin = await service.bootstrapAdmin("legacy-admin", "temporary-Secure-password-2026");
    await makeAdminReady(repository, admin.id);
    const principal = (await service.authenticate(
      (await service.login(admin.login, "temporary-Secure-password-2026")).sessionToken
    ))!;

    const pending = await service.register("legacy-pending", "correct-horse-battery-staple");
    await repository.updateUser(pending.id, {
      tradingRole: "live-trade",
      updatedAt: new Date()
    });
    await expect(
      activate(service, repository, principal, pending.id)
    ).rejects.toMatchObject({ code: "live_trading_role_forbidden" });

    const disabled = await service.register("legacy-disabled", "correct-horse-battery-staple");
    await repository.updateUser(disabled.id, {
      status: "disabled",
      tradingRole: "live-trade",
      updatedAt: new Date()
    });
    await expect(
      reactivate(service, repository, principal, disabled.id)
    ).rejects.toMatchObject({ code: "live_trading_role_forbidden" });

    const legacyAdmin = await service.register("legacy-second-admin", "correct-horse-battery-staple");
    await activate(service, repository, principal, legacyAdmin.id);
    await permissions(service, repository, principal, legacyAdmin.id, {
      appRole: "admin"
    });
    await repository.updateUser(legacyAdmin.id, {
      tradingRole: "live-trade",
      updatedAt: new Date()
    });
    await expect(
      permissions(service, repository, principal, legacyAdmin.id, {
        appRole: "user"
      })
    ).rejects.toMatchObject({ code: "live_trading_role_forbidden" });
  });

  it("fences execution authorization with durable revision and process epoch", async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository);
    const admin = await service.bootstrapAdmin("permit-admin", "temporary-Secure-password-2026");
    await makeAdminReady(repository, admin.id);
    const user = await service.register("permit-trader", "correct-horse-battery-staple");
    const principal = (await service.authenticate(
      (await service.login(admin.login, "temporary-Secure-password-2026")).sessionToken
    ))!;
    await activate(service, repository, principal, user.id);
    await permissions(service, repository, principal, user.id, { tradingRole: "paper-trade" });

    const snapshot = await service.executionAuthorizationSnapshot(user.id);
    expect(snapshot).toMatchObject({ ownerUserId: user.id, role: "paper-trade" });
    expect(snapshot?.authorizationRevision).toBeGreaterThan(1);
    expect(service.isExecutionAuthorizationCurrent(snapshot!)).toBe(true);

    await permissions(service, repository, principal, user.id, { tradingRole: "none" });
    expect(service.isExecutionAuthorizationCurrent(snapshot!)).toBe(false);
    expect(await service.executionAuthorizationSnapshot(user.id)).toBeUndefined();
    expect((await repository.findUserById(user.id))!.authorizationRevision).toBe(
      snapshot!.authorizationRevision + 1
    );
  });

  it("ignores a persisted non-admin trading role when the migration flag is off", async () => {
    const repository = new MemoryIdentityRepository();
    const enabled = new IdentityService(repository, { allowNonAdminTrading: true });
    const admin = await enabled.bootstrapAdmin("admin", "temporary-Secure-password-2026");
    await makeAdminReady(repository, admin.id);
    const user = await enabled.register("client", "correct-horse-battery-staple");
    const adminPrincipal = (await enabled.authenticate((await enabled.login(admin.login, "temporary-Secure-password-2026")).sessionToken))!;
    await activate(enabled, repository, adminPrincipal, user.id);
    await permissions(enabled, repository, adminPrincipal, user.id, { tradingRole: "paper-trade" });
    const userSession = await enabled.login(user.login, "correct-horse-battery-staple");

    const disabled = new IdentityService(repository, { allowNonAdminTrading: false });
    expect((await disabled.authenticate(userSession.sessionToken))?.effectiveTradingRole).toBeUndefined();
  });

  it("invokes the runtime fail-closed hook on permission changes and disable", async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository);
    const actions: string[] = [];
    service.setTradingAccessChangeHandler((userId, action) => {
      actions.push(`${action}:${userId}`);
    });
    const admin = await service.bootstrapAdmin("admin", "temporary-Secure-password-2026");
    await makeAdminReady(repository, admin.id);
    const user = await service.register("client", "correct-horse-battery-staple");
    const principal = (await service.authenticate((await service.login(admin.login, "temporary-Secure-password-2026")).sessionToken))!;

    await activate(service, repository, principal, user.id);
    await permissions(service, repository, principal, user.id, { tradingRole: "paper-trade" });
    await permissions(service, repository, principal, user.id, { tradingRole: "read-only" });
    await disable(service, repository, principal, user.id);

    expect(actions).toEqual([`revoke:${user.id}`, `restore:${user.id}`, `revoke:${user.id}`, `revoke:${user.id}`]);
  });
});

async function makeAdminReady(repository: MemoryIdentityRepository, userId: string): Promise<void> {
  await repository.updateUser(userId, { mustChangePassword: false, updatedAt: new Date() });
}

async function mutationInput(
  repository: MemoryIdentityRepository,
  userId: string,
  overrides: Pick<AdminLifecycleMutationInput, "appRole" | "tradingRole"> = {}
): Promise<AdminLifecycleMutationInput> {
  const user = await repository.findUserById(userId);
  if (!user) throw new Error("test user not found");
  return {
    reason: "identity service test mutation",
    expectedAuthorizationRevision: user.authorizationRevision,
    ...overrides
  };
}

async function activate(
  service: IdentityService,
  repository: MemoryIdentityRepository,
  actor: IdentityPrincipal,
  userId: string
) {
  return service.activateUser(
    actor,
    userId,
    await mutationInput(repository, userId)
  );
}

async function reactivate(
  service: IdentityService,
  repository: MemoryIdentityRepository,
  actor: IdentityPrincipal,
  userId: string
) {
  return service.reactivateUser(
    actor,
    userId,
    await mutationInput(repository, userId)
  );
}

async function disable(
  service: IdentityService,
  repository: MemoryIdentityRepository,
  actor: IdentityPrincipal,
  userId: string
) {
  return service.disableUser(
    actor,
    userId,
    await mutationInput(repository, userId)
  );
}

async function permissions(
  service: IdentityService,
  repository: MemoryIdentityRepository,
  actor: IdentityPrincipal,
  userId: string,
  overrides: Pick<AdminLifecycleMutationInput, "appRole" | "tradingRole">
) {
  return service.updatePermissions(
    actor,
    userId,
    await mutationInput(repository, userId, overrides)
  );
}

class BlockingAdminMutationRepository extends MemoryIdentityRepository {
  private nextBarrier?: { entered(): void; gate: Promise<void> };

  blockNextAdminMutation(): { entered: Promise<void>; release(): void } {
    let markEntered = () => {};
    let release = () => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextBarrier = { entered: markEntered, gate };
    return { entered, release };
  }

  override async mutateUserAsAdmin(actorUserId: string, subjectUserId: string, mutation: Parameters<MemoryIdentityRepository["mutateUserAsAdmin"]>[2]) {
    const barrier = this.nextBarrier;
    this.nextBarrier = undefined;
    if (barrier) {
      barrier.entered();
      await barrier.gate;
    }
    return super.mutateUserAsAdmin(actorUserId, subjectUserId, mutation);
  }
}
