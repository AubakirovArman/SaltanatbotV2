import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Server } from "node:http";
import express, { Router } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PaperPortfolioCommandHandler,
  type PaperPortfolioCommandRuntime
} from "../src/trading/paperPortfolioCommandHandler.js";
import type { PaperPortfolioMutationGateway } from "../src/trading/paperPortfolioGatewayTypes.js";
import { PaperPortfolioReadService } from "../src/trading/paperPortfolioReadService.js";
import { registerPaperPortfolioRoutes } from "../src/trading/paperPortfolioRoutes.js";
import { migrateTradingStore } from "../src/trading/storeSchema.js";

const OWNER = "route-owner";
const NOW = 1_700_000_000_000;

class Runtime implements PaperPortfolioCommandRuntime {
  isRunning() { return false; }
  isPaused() { return false; }
  async start() {}
  async pause() { return false; }
  async resume() { return false; }
  async stop() {}
}

let database: DatabaseSync;
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  database = new DatabaseSync(":memory:");
  migrateTradingStore(database, () => NOW, { legacyOwnerUserId: OWNER });
  const runtime = new Runtime();
  const handler = new PaperPortfolioCommandHandler(database, runtime, () => NOW + 1);
  const commands: PaperPortfolioMutationGateway = {
    async execute(input) {
      const commandId = `route-${createHash("sha256")
        .update(`${input.principal.ownerUserId}\0${input.idempotencyKey}`)
        .digest("hex")}`;
      const applied = await handler.apply({
        commandId,
        ownerUserId: input.principal.ownerUserId,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        payload: input.payload
      });
      return { replayed: applied.replayed };
    }
  };
  const app = express();
  app.use(express.json());
  app.use((request, response, next) => {
    response.locals.authUserId = typeof request.headers["x-test-owner"] === "string"
      ? request.headers["x-test-owner"]
      : OWNER;
    response.locals.authRole = "paper-trade";
    next();
  });
  const router = Router();
  registerPaperPortfolioRoutes(router, new PaperPortfolioReadService(database, runtime), commands);
  app.use("/api/trade", router);
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(500).json({ error: error instanceof Error ? error.message : "unexpected" });
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}/api/trade`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  database.close();
});

function headers(idempotencyKey?: string, owner = OWNER): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-sbv2-expected-user": owner,
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
  };
}

describe("paper portfolio routes", () => {
  it("creates, reads, renames and exactly replays an owner-scoped portfolio", async () => {
    const createdResponse = await fetch(`${baseUrl}/paper-portfolios`, {
      method: "POST",
      headers: headers("create-key"),
      body: JSON.stringify({
        name: "Primary",
        initialCapital: "100000.000000",
        currency: "USDT"
      })
    });
    const createdBody = await createdResponse.json();
    expect(createdResponse.status, JSON.stringify(createdBody)).toBe(200);
    const created = createdBody as {
      portfolio: { id: string; revision: number; currentEpoch: number };
      snapshot: { aggregates: { cashBalance: string } };
      replayed: boolean;
    };
    expect(created).toMatchObject({
      portfolio: { revision: 1, currentEpoch: 1 },
      snapshot: { aggregates: { cashBalance: "100000.000000" } },
      replayed: false
    });

    const list = await fetch(`${baseUrl}/paper-portfolios`, { headers: headers() });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      schemaVersion: "paper-portfolio-list-v1",
      portfolios: [{ id: created.portfolio.id, name: "Primary", isDefault: true }]
    });

    const renamedResponse = await fetch(`${baseUrl}/paper-portfolios/${created.portfolio.id}`, {
      method: "PATCH",
      headers: headers("rename-key"),
      body: JSON.stringify({
        expectedPortfolioRevision: 1,
        expectedLedgerEpoch: 1,
        name: "Renamed"
      })
    });
    expect(renamedResponse.status).toBe(200);
    expect(await renamedResponse.json()).toMatchObject({
      portfolio: { name: "Renamed", revision: 2 },
      replayed: false
    });

    const replay = await fetch(`${baseUrl}/paper-portfolios/${created.portfolio.id}`, {
      method: "PATCH",
      headers: headers("rename-key"),
      body: JSON.stringify({
        expectedPortfolioRevision: 1,
        expectedLedgerEpoch: 1,
        name: "Renamed"
      })
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      portfolio: { name: "Renamed", revision: 2 },
      replayed: true
    });
  });

  it("fails closed on owner drift, missing idempotency and conflicting replay", async () => {
    expect((await fetch(`${baseUrl}/paper-portfolios`, {
      headers: headers(undefined, "another-owner")
    })).status).toBe(409);
    expect((await fetch(`${baseUrl}/paper-portfolios`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: "No key", initialCapital: "1.000000", currency: "USDT" })
    })).status).toBe(400);

    const first = await fetch(`${baseUrl}/paper-portfolios`, {
      method: "POST",
      headers: headers("conflict-key"),
      body: JSON.stringify({ name: "First", initialCapital: "100.000000", currency: "USDT" })
    });
    const firstBody = await first.clone().json();
    expect(first.status, JSON.stringify(firstBody)).toBe(200);
    const conflict = await fetch(`${baseUrl}/paper-portfolios`, {
      method: "POST",
      headers: headers("conflict-key"),
      body: JSON.stringify({ name: "Different", initialCapital: "100.000000", currency: "USDT" })
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "idempotency_conflict" });
  });

  it("requires exact six-decimal positive capital and explicit destructive confirmation", async () => {
    const invalidMoney = await fetch(`${baseUrl}/paper-portfolios`, {
      method: "POST",
      headers: headers("invalid-money"),
      body: JSON.stringify({ name: "Invalid", initialCapital: "100", currency: "USDT" })
    });
    expect(invalidMoney.status).toBe(400);
    const zeroMoney = await fetch(`${baseUrl}/paper-portfolios`, {
      method: "POST",
      headers: headers("zero-money"),
      body: JSON.stringify({ name: "Zero", initialCapital: "0.000000", currency: "USDT" })
    });
    expect(zeroMoney.status).toBe(400);
    expect(await zeroMoney.json()).toMatchObject({ code: "invalid_money" });
    const excessiveMoney = await fetch(`${baseUrl}/paper-portfolios`, {
      method: "POST",
      headers: headers("excessive-money"),
      body: JSON.stringify({
        name: "Excessive",
        initialCapital: "999999999999999999999999.000000",
        currency: "USDT"
      })
    });
    expect(excessiveMoney.status).toBe(400);
    expect(await excessiveMoney.json()).toMatchObject({ code: "invalid_money" });

    const createdResponse = await fetch(`${baseUrl}/paper-portfolios`, {
      method: "POST",
      headers: headers("destructive-create"),
      body: JSON.stringify({ name: "Destructive", initialCapital: "100.000000", currency: "USDT" })
    });
    const created = await createdResponse.json() as { portfolio: { id: string } };
    expect(createdResponse.status, JSON.stringify(created)).toBe(200);
    const archive = await fetch(`${baseUrl}/paper-portfolios/${created.portfolio.id}/archive`, {
      method: "POST",
      headers: headers("archive-key"),
      body: JSON.stringify({
        expectedPortfolioRevision: 1,
        expectedLedgerEpoch: 1,
        confirm: "ARCHIVE_PAPER_PORTFOLIO",
        confirmName: "Wrong"
      })
    });
    expect(archive.status).toBe(409);
    expect(await archive.json()).toMatchObject({ code: "confirmation_mismatch" });
  });
});
