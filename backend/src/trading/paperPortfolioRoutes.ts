import type { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import { roleAllows } from "../auth.js";
import {
  PAPER_PORTFOLIO_COMMAND_VERSION,
  PaperPortfolioCommandInputError,
  deterministicPaperPortfolioId,
  paperPortfolioRequestHash,
  parseCanonicalPaperMoneyMicros,
  type PaperPortfolioMutationPayload
} from "./paperPortfolioCommandContract.js";
import {
  PaperPortfolioHttpError,
  type PaperPortfolioMutationGateway
} from "./paperPortfolioGatewayTypes.js";
import {
  assertExpectedPaperOwner,
  paperCommandPrincipal,
  paperIdempotencyKey
} from "./paperPortfolioHttpContext.js";
import type { PaperPortfolioReadService } from "./paperPortfolioReadService.js";
import { PaperPortfolioStoreError } from "./paperPortfolioStoreSupport.js";
import { tradingOwnerFromResponse } from "./ownership.js";
import type { AuthRole } from "./types.js";

/** These REST routes always mutate one portfolio; owner-level kinds never travel through them. */
type PortfolioScopedMutationPayload = Extract<PaperPortfolioMutationPayload, { portfolioId: string }>;

const portfolioIdSchema = z.string().trim().min(1).max(200);
const nameSchema = z.string().trim().min(1).max(120);
const revisionSchema = z.number().int().positive().safe();
const moneySchema = z.string().trim().regex(/^(?:0|[1-9]\d*)\.\d{6}$/);
const expectedSchema = {
  expectedPortfolioRevision: revisionSchema,
  expectedLedgerEpoch: revisionSchema
};

const createSchema = z.object({
  name: nameSchema,
  initialCapital: moneySchema,
  currency: z.literal("USDT").default("USDT")
}).strict();
const renameSchema = z.object({ ...expectedSchema, name: nameSchema }).strict();
const expectedBodySchema = z.object(expectedSchema).strict();
const archiveSchema = z.object({
  ...expectedSchema,
  confirm: z.literal("ARCHIVE_PAPER_PORTFOLIO"),
  confirmName: nameSchema
}).strict();
const resetSchema = z.object({
  ...expectedSchema,
  confirm: z.literal("RESET_PAPER_PORTFOLIO"),
  confirmName: nameSchema,
  initialCapital: moneySchema.optional()
}).strict();
const robotActionSchema = z.object({
  ...expectedSchema,
  expectedBotRevision: revisionSchema,
  action: z.enum(["start", "pause", "resume", "stop"]),
  confirm: z.literal(true)
}).strict();

export function registerPaperPortfolioRoutes(
  router: Router,
  reads: PaperPortfolioReadService,
  commands: PaperPortfolioMutationGateway
): void {
  router.get("/paper-portfolios", (request, response, next) => {
    noStore(response);
    try {
      const owner = expectedOwner(request, response);
      if (!owner) return;
      response.json(reads.list(owner));
    } catch (error) {
      handleError(error, response, next);
    }
  });

  router.get("/paper-portfolios/:portfolioId", (request, response, next) => {
    noStore(response);
    try {
      const owner = expectedOwner(request, response);
      if (!owner) return;
      const portfolioId = portfolioIdSchema.parse(routeParam(request, "portfolioId"));
      response.json(reads.detail(owner, portfolioId));
    } catch (error) {
      handleError(error, response, next);
    }
  });

  router.post("/paper-portfolios", async (request, response, next) => {
    const owner = mutationOwner(request, response);
    if (!owner) return;
    try {
      const body = createSchema.parse(request.body);
      const key = paperIdempotencyKey(request);
      const payload: PortfolioScopedMutationPayload = {
        version: PAPER_PORTFOLIO_COMMAND_VERSION,
        kind: "paper-portfolio.create",
        portfolioId: deterministicPaperPortfolioId(owner, key),
        name: body.name,
        initialCapitalMicros: parseCanonicalPaperMoneyMicros(body.initialCapital),
        makeDefault: false
      };
      await executeAndRespond(request, response, commands, reads, owner, key, payload);
    } catch (error) {
      handleError(error, response, next);
    }
  });

  router.patch("/paper-portfolios/:portfolioId", async (request, response, next) => {
    await mutateExisting(request, response, next, commands, reads, renameSchema, (owner, portfolioId, body) => ({
      version: 1,
      kind: "paper-portfolio.rename",
      portfolioId,
      name: body.name,
      expectedPortfolioRevision: body.expectedPortfolioRevision,
      expectedLedgerEpoch: body.expectedLedgerEpoch
    }));
  });

  router.post("/paper-portfolios/:portfolioId/default", async (request, response, next) => {
    await mutateExisting(request, response, next, commands, reads, expectedBodySchema, (_owner, portfolioId, body) => ({
      version: 1,
      kind: "paper-portfolio.default",
      portfolioId,
      expectedPortfolioRevision: body.expectedPortfolioRevision,
      expectedLedgerEpoch: body.expectedLedgerEpoch
    }));
  });

  router.post("/paper-portfolios/:portfolioId/archive", async (request, response, next) => {
    await mutateExisting(request, response, next, commands, reads, archiveSchema, (_owner, portfolioId, body) => ({
      version: 1,
      kind: "paper-portfolio.archive",
      portfolioId,
      expectedPortfolioRevision: body.expectedPortfolioRevision,
      expectedLedgerEpoch: body.expectedLedgerEpoch,
      confirmName: body.confirmName,
      confirmation: body.confirm
    }));
  });

  router.post("/paper-portfolios/:portfolioId/reset", async (request, response, next) => {
    await mutateExisting(request, response, next, commands, reads, resetSchema, (_owner, portfolioId, body) => ({
      version: 1,
      kind: "paper-portfolio.reset",
      portfolioId,
      expectedPortfolioRevision: body.expectedPortfolioRevision,
      expectedLedgerEpoch: body.expectedLedgerEpoch,
      confirmName: body.confirmName,
      confirmation: body.confirm,
      ...(body.initialCapital ? { initialCapitalMicros: parseCanonicalPaperMoneyMicros(body.initialCapital) } : {})
    }));
  });

  router.post("/paper-portfolios/:portfolioId/robots/:botId/actions", async (request, response, next) => {
    noStore(response);
    const owner = mutationOwner(request, response);
    if (!owner) return;
    try {
      const body = robotActionSchema.parse(request.body);
      const portfolioId = portfolioIdSchema.parse(routeParam(request, "portfolioId"));
      const botId = portfolioIdSchema.parse(routeParam(request, "botId"));
      const key = paperIdempotencyKey(request);
      const payload: PortfolioScopedMutationPayload = {
        version: 1,
        kind: "paper-robot.action",
        portfolioId,
        botId,
        expectedPortfolioRevision: body.expectedPortfolioRevision,
        expectedLedgerEpoch: body.expectedLedgerEpoch,
        expectedBotRevision: body.expectedBotRevision,
        action: body.action,
        confirm: true
      };
      await executeAndRespond(request, response, commands, reads, owner, key, payload);
    } catch (error) {
      handleError(error, response, next);
    }
  });
}

async function mutateExisting<T extends z.ZodType>(
  request: Request,
  response: Response,
  next: NextFunction,
  commands: PaperPortfolioMutationGateway,
  reads: PaperPortfolioReadService,
  schema: T,
  payload: (owner: string, portfolioId: string, body: z.infer<T>) => PortfolioScopedMutationPayload
): Promise<void> {
  noStore(response);
  const owner = mutationOwner(request, response);
  if (!owner) return;
  try {
    const body = schema.parse(request.body);
    const portfolioId = portfolioIdSchema.parse(routeParam(request, "portfolioId"));
    const key = paperIdempotencyKey(request);
    await executeAndRespond(request, response, commands, reads, owner, key, payload(owner, portfolioId, body));
  } catch (error) {
    handleError(error, response, next);
  }
}

async function executeAndRespond(
  request: Request,
  response: Response,
  commands: PaperPortfolioMutationGateway,
  reads: PaperPortfolioReadService,
  owner: string,
  key: string,
  payload: PortfolioScopedMutationPayload
): Promise<void> {
  const outcome = await commands.execute({
    principal: paperCommandPrincipal(response, owner),
    idempotencyKey: key,
    requestHash: paperPortfolioRequestHash(owner, payload),
    payload
  });
  const detail = reads.detail(owner, payload.portfolioId);
  response.json({ ...detail, replayed: outcome.replayed });
}

function expectedOwner(request: Request, response: Response): string | undefined {
  const owner = tradingOwnerFromResponse(response);
  try { assertExpectedPaperOwner(request, owner); } catch (error) {
    if (error instanceof PaperPortfolioHttpError) {
      response.status(error.status).json({ error: error.message, code: error.code });
      return undefined;
    }
    throw error;
  }
  return owner;
}

function mutationOwner(request: Request, response: Response): string | undefined {
  noStore(response);
  const owner = expectedOwner(request, response);
  if (!owner) return undefined;
  if (roleAllows(response.locals.authRole as AuthRole | undefined, "paper-trade")) return owner;
  response.status(403).json({ error: "Paper trading access is required.", code: "trading_not_allowed" });
  return undefined;
}

function routeParam(request: Request, name: string): string {
  const value = request.params[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function noStore(response: Response): void {
  response.setHeader("Cache-Control", "no-store");
}

function handleError(error: unknown, response: Response, next: NextFunction): void {
  if (response.headersSent) return;
  if (error instanceof PaperPortfolioHttpError) {
    response.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof PaperPortfolioCommandInputError) {
    response.status(400).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof PaperPortfolioStoreError) {
    const status = error.code === "NOT_FOUND" ? 404 : 409;
    response.status(status).json({ error: error.message, code: error.code.toLowerCase() });
    return;
  }
  if (error instanceof z.ZodError) {
    response.status(400).json({ error: "Invalid paper portfolio request.", code: "invalid_request", details: error.flatten() });
    return;
  }
  next(error);
}
