import { describe, expect, it } from "vitest";
import { MemoryIdentityRepository } from "../src/identity/memoryRepository.js";
import type { IdentitySession } from "../src/identity/types.js";

describe("identity session page contract", () => {
  it("reports revocable sessions globally instead of counting page history", async () => {
    const repository = new MemoryIdentityRepository();
    const now = new Date("2026-07-16T12:00:00.000Z");
    const sessions: IdentitySession[] = [
      session("active-a", new Date(now.getTime() + 60_000)),
      session("active-b", new Date(now.getTime() + 120_000)),
      session("expired", new Date(now.getTime() - 1)),
      {
        ...session("revoked", new Date(now.getTime() + 180_000)),
        revokedAt: new Date(now.getTime() - 1),
        revokeReason: "test"
      }
    ];
    for (const value of sessions) await repository.createSession(value);

    await expect(
      repository.listSessions("owner", { page: 1, pageSize: 1, now })
    ).resolves.toMatchObject({
      total: 4,
      revocableSessionCount: 2,
      items: [{ userId: "owner" }]
    });
  });
});

function session(publicId: string, expiresAt: Date): IdentitySession {
  return {
    publicId,
    idHash: publicId.padEnd(64, "0"),
    userId: "owner",
    csrfHash: publicId.padEnd(64, "1"),
    expiresAt,
    lastSeenAt: new Date("2026-07-16T11:00:00.000Z"),
    createdAt: new Date("2026-07-16T10:00:00.000Z")
  };
}
