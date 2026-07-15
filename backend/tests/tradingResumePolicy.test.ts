import { describe, expect, it } from "vitest";
import { MemoryIdentityRepository } from "../src/identity/memoryRepository.js";
import { IdentityService } from "../src/identity/service.js";
import { createTradingResumeAuthorization } from "../src/identity/tradingResumePolicy.js";
import type { IdentityRuntime } from "../src/identity/runtime.js";
import type { BotConfig } from "../src/trading/types.js";

const bot = (ownerUserId: string, exchange: BotConfig["exchange"]): BotConfig => ({
  id: `${ownerUserId}-${exchange}`,
  ownerUserId,
  accountId: exchange === "paper" ? `paper:${ownerUserId}` : `${exchange}-account`,
  name: "resume-policy",
  strategyName: "resume-policy",
  ir: { name: "resume-policy", inputs: [], body: [] },
  symbol: "BTCUSDT",
  timeframe: "1m",
  exchange,
  market: "futures",
  sizeMode: "quote",
  sizeValue: 100,
  leverage: 1,
  notifyMarkers: false,
  status: "running",
  createdAt: 1,
  updatedAt: 1
});

describe("boot-time trading resume authorization", () => {
  it("uses the current durable user status and required bot role", async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository);
    const admin = await service.bootstrapAdmin("resume-admin", "temporary-Admin-password-2026");
    await repository.updateUser(admin.id, { mustChangePassword: false, updatedAt: new Date() });
    const user = await service.register("resume-user", "correct-horse-battery-staple");
    const adminPrincipal = (await service.authenticate((await service.login(admin.login, "temporary-Admin-password-2026")).sessionToken))!;
    await service.activateUser(adminPrincipal, user.id);
    await service.updatePermissions(adminPrincipal, user.id, { tradingRole: "paper-trade" });
    const authorize = createTradingResumeAuthorization({ mode: "database", service, async close() {} });

    expect(await authorize(bot(user.id, "paper"))).toBe(true);
    expect(await authorize(bot(user.id, "bybit"))).toBe(false);
    expect(await authorize(bot(admin.id, "bybit"))).toBe(true);

    await service.disableUser(adminPrincipal, user.id);
    expect(await authorize(bot(user.id, "paper"))).toBe(false);
  });

  it("keeps explicit legacy single-operator mode compatible", async () => {
    const runtime: IdentityRuntime = { mode: "legacy", async close() {} };
    expect(await createTradingResumeAuthorization(runtime)(bot("legacy-operator", "paper"))).toBe(true);
  });
});
