import express, {
  Router,
  type NextFunction,
  type Request,
  type Response
} from "express";
import type { Pool } from "pg";
import { z } from "zod";
import type { IdentityPrincipal } from "../identity/types.js";
import {
  createWorkspaceExport,
  parseWorkspaceImport,
  validateWorkspaceInputConsistency,
  WorkspaceImportError,
  workspaceInputObjectSchema,
  workspaceInputSchema,
  workspaceNameSchema
} from "./documentContract.js";
import {
  WorkspaceRepository,
  type WorkspaceListStatus
} from "./repository.js";
import {
  WorkspaceArchivedError,
  WorkspaceAuthorizationChangedError,
  WorkspaceConflictError,
  WorkspaceInvalidTransitionError,
  WorkspaceNotArchivedError,
  WorkspaceNotFoundError
} from "./repositoryErrors.js";
import {
  workspaceListQuerySchema,
  workspaceRevisionListQuerySchema
} from "./routePaginationSchemas.js";
import {
  assertWorkspaceEnvelopeSize,
  loadWorkspaceQuotaLimits,
  workspaceEnvelopeByteLimit,
  WorkspaceQuotaError,
  type WorkspaceQuotaAttempt,
  type WorkspaceQuotaCode,
  type WorkspaceQuotaLimits
} from "./quotas.js";
import {
  WORKSPACE_LIST_PAGE_MAX_ITEMS,
  WORKSPACE_REVISION_PAGE_MAX_ITEMS,
  WorkspaceResponseItemTooLargeError
} from "./workspacePagination.js";

const updateSchema = workspaceInputObjectSchema
  .extend({ revision: safePositiveInteger() })
  .superRefine(validateWorkspaceInputConsistency);
const revisionSchema = z
  .object({
    revision: safePositiveInteger(),
    targetRevision: safePositiveInteger()
  })
  .strict();
const expectedRevisionSchema = z
  .object({ revision: safePositiveInteger() })
  .strict();
const archiveSchema = z
  .object({
    revision: safePositiveInteger(),
    archived: z.boolean().optional()
  })
  .strict();
const renameSchema = z
  .object({
    revision: safePositiveInteger(),
    name: workspaceNameSchema
  })
  .strict();
const duplicateSchema = z
  .object({
    revision: safePositiveInteger(),
    clientId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
    name: workspaceNameSchema.optional()
  })
  .strict();
const idSchema = z.string().uuid();

export interface WorkspaceRouterOptions {
  limits?: WorkspaceQuotaLimits;
}

export function createWorkspaceRouter(
  pool: Pool,
  options: WorkspaceRouterOptions = {}
): Router {
  const limits = options.limits ?? loadWorkspaceQuotaLimits();
  const repository = new WorkspaceRepository(pool, limits);
  const router = Router();

  router.use(requireExpectedOwner);
  router.use(
    express.json({
      limit: workspaceEnvelopeByteLimit(limits),
      strict: true,
      verify: (request, _response, buffer) => {
        (
          request as Request & { workspaceRawBodyBytes?: number }
        ).workspaceRawBodyBytes = buffer.byteLength;
      }
    })
  );

  router.get(
    "/quota",
    asyncRoute(async (_request, response) => {
      noStore(response);
      response.json({ quota: await repository.quota(owner(response)) });
    })
  );

  router.get(
    "/",
    asyncRoute(async (request, response) => {
      const query = workspaceListQuerySchema.parse(request.query);
      const status: WorkspaceListStatus =
        query.status ?? (query.includeArchived === "true" ? "all" : "active");
      noStore(response);
      response.json(
        await repository.listPage(
          owner(response),
          status,
          query.cursor,
          query.limit ?? WORKSPACE_LIST_PAGE_MAX_ITEMS
        )
      );
    })
  );

  router.post(
    "/import",
    asyncRoute(async (request, response) => {
      assertWorkspaceEnvelopeSize(
        (
          request as Request & { workspaceRawBodyBytes?: number }
        ).workspaceRawBodyBytes ?? 0,
        limits
      );
      const input = parseWorkspaceImport(request.body, limits);
      const result = await repository.create(
        owner(response),
        input,
        authorizationRevision(response)
      );
      noStore(response);
      response.status(201).json(result);
    })
  );

  router.post(
    "/",
    asyncRoute(async (request, response) => {
      const input = workspaceInputSchema.parse(request.body);
      const result = await repository.create(
        owner(response),
        input,
        authorizationRevision(response)
      );
      noStore(response);
      response.status(201).json(result);
    })
  );

  router.get(
    "/:id/export",
    asyncRoute(async (request, response) => {
      const workspace = await repository.get(
        owner(response),
        idSchema.parse(routeId(request))
      );
      if (!workspace) throw new WorkspaceNotFoundError();
      const document = createWorkspaceExport({
        clientId: workspace.clientId,
        name: workspace.name,
        schemaVersion: workspace.schemaVersion,
        payload: workspace.payload
      });
      noStore(response);
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="${exportFileName(workspace.name)}.saltanat-workspace.json"`
      );
      response.json(document);
    })
  );

  router.get(
    "/:id",
    asyncRoute(async (request, response) => {
      const workspace = await repository.get(
        owner(response),
        idSchema.parse(routeId(request))
      );
      if (!workspace) throw new WorkspaceNotFoundError();
      noStore(response);
      response.json({ workspace });
    })
  );

  router.put(
    "/:id",
    asyncRoute(async (request, response) => {
      const { revision, ...input } = updateSchema.parse(request.body);
      const result = await repository.update(
        owner(response),
        idSchema.parse(routeId(request)),
        revision,
        input,
        authorizationRevision(response)
      );
      noStore(response);
      response.json(result);
    })
  );

  router.patch(
    "/:id/name",
    asyncRoute(async (request, response) => {
      const input = renameSchema.parse(request.body);
      const result = await repository.rename(
        owner(response),
        idSchema.parse(routeId(request)),
        input.revision,
        input.name,
        authorizationRevision(response)
      );
      noStore(response);
      response.json(result);
    })
  );

  router.post(
    "/:id/duplicate",
    asyncRoute(async (request, response) => {
      const input = duplicateSchema.parse(request.body);
      const result = await repository.duplicate(
        owner(response),
        idSchema.parse(routeId(request)),
        input.revision,
        input.clientId,
        input.name,
        authorizationRevision(response)
      );
      noStore(response);
      response.status(201).json(result);
    })
  );

  router.delete(
    "/:id/permanent",
    asyncRoute(async (request, response) => {
      const revision = safePositiveInteger(true).parse(request.query.revision);
      const result = await repository.purge(
        owner(response),
        idSchema.parse(routeId(request)),
        revision,
        authorizationRevision(response)
      );
      noStore(response);
      response.json({ ok: true, ...result });
    })
  );

  router.delete(
    "/:id",
    asyncRoute(async (request, response) => {
      const revision = safePositiveInteger(true).parse(request.query.revision);
      const result = await repository.archive(
        owner(response),
        idSchema.parse(routeId(request)),
        revision,
        authorizationRevision(response)
      );
      noStore(response);
      response.json({ ok: true, ...result });
    })
  );

  router.post(
    "/:id/archive",
    asyncRoute(async (request, response) => {
      const input = archiveSchema.parse(request.body);
      const result =
        input.archived === false
          ? await repository.restore(
              owner(response),
              idSchema.parse(routeId(request)),
              input.revision,
              authorizationRevision(response)
            )
          : await repository.archive(
              owner(response),
              idSchema.parse(routeId(request)),
              input.revision,
              authorizationRevision(response)
            );
      noStore(response);
      response.json(result);
    })
  );

  router.post(
    "/:id/restore",
    asyncRoute(async (request, response) => {
      const input = expectedRevisionSchema.parse(request.body);
      const result = await repository.restore(
        owner(response),
        idSchema.parse(routeId(request)),
        input.revision,
        authorizationRevision(response)
      );
      noStore(response);
      response.json(result);
    })
  );

  router.get(
    "/:id/revisions",
    asyncRoute(async (request, response) => {
      const query = workspaceRevisionListQuerySchema.parse(request.query);
      noStore(response);
      response.json(
        await repository.revisionPage(
          owner(response),
          idSchema.parse(routeId(request)),
          query.cursor,
          query.limit ?? WORKSPACE_REVISION_PAGE_MAX_ITEMS
        )
      );
    })
  );

  router.post(
    "/:id/rollback",
    asyncRoute(async (request, response) => {
      const input = revisionSchema.parse(request.body);
      const result = await repository.rollback(
        owner(response),
        idSchema.parse(routeId(request)),
        input.revision,
        input.targetRevision,
        authorizationRevision(response)
      );
      noStore(response);
      response.json(result);
    })
  );

  router.use(
    (error: unknown, request: Request, response: Response, next: NextFunction) => {
      noStore(response);
      if (error instanceof WorkspaceConflictError) {
        response.status(409).json({
          error: error.message,
          code: "workspace_conflict",
          current: error.current,
          currentMetadata: error.currentMetadata
        });
        return;
      }
      if (error instanceof WorkspaceAuthorizationChangedError) {
        response.status(409).json({
          error: error.message,
          code: "workspace_authorization_changed"
        });
        return;
      }
      if (error instanceof WorkspaceInvalidTransitionError) {
        response.status(400).json({
          error: error.message,
          code: "workspace_invalid_transition",
          currentMetadata: error.currentMetadata
        });
        return;
      }
      if (error instanceof WorkspaceArchivedError) {
        response.status(409).json({
          error: error.message,
          code: "workspace_archived",
          current: error.current,
          currentMetadata: error.currentMetadata
        });
        return;
      }
      if (error instanceof WorkspaceNotArchivedError) {
        response.status(409).json({
          error: error.message,
          code: "workspace_not_archived",
          current: error.current,
          currentMetadata: error.currentMetadata
        });
        return;
      }
      if (error instanceof WorkspaceQuotaError) {
        void sendDurableQuotaError(repository, response, next, {
          status: error.status,
          error: error.message,
          code: error.code,
          attempted: error.attempted
        });
        return;
      }
      if (error instanceof WorkspaceImportError) {
        response.status(400).json({ error: error.message, code: error.code });
        return;
      }
      if (error instanceof WorkspaceNotFoundError) {
        response
          .status(404)
          .json({ error: error.message, code: "workspace_not_found" });
        return;
      }
      if (error instanceof WorkspaceResponseItemTooLargeError) {
        response.status(500).json({ error: error.message, code: error.code });
        return;
      }
      if (isBodyTooLarge(error)) {
        void sendDurableQuotaError(repository, response, next, {
          status: 413,
          error: `Workspace request envelope exceeds ${workspaceEnvelopeByteLimit(limits)} bytes.`,
          code: "workspace_envelope_too_large",
          attempted: bodySizeAttempt(error, request)
        });
        return;
      }
      if (isInvalidJson(error)) {
        response.status(400).json({
          error: "Workspace request body is not valid JSON.",
          code: "invalid_json"
        });
        return;
      }
      if (error instanceof z.ZodError) {
        response.status(400).json({
          error: "Invalid workspace request.",
          code: "invalid_request",
          details: error.flatten()
        });
        return;
      }
      if (
        error instanceof Error &&
        error.message === "workspace_revision_not_found"
      ) {
        response.status(404).json({
          error: "Workspace revision not found.",
          code: "workspace_revision_not_found"
        });
        return;
      }
      next(error);
    }
  );
  return router;
}

function asyncRoute(
  handler: (request: Request, response: Response) => Promise<unknown>
) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response).catch(next);
  };
}

function owner(response: Response): string {
  const principal = response.locals.authPrincipal as IdentityPrincipal | undefined;
  if (!principal) throw new Error("Authenticated principal missing");
  return principal.user.id;
}

function authorizationRevision(response: Response): number {
  const principal = response.locals.authPrincipal as IdentityPrincipal | undefined;
  const revision = principal?.user.authorizationRevision;
  if (!Number.isSafeInteger(revision) || Number(revision) < 1) {
    throw new WorkspaceAuthorizationChangedError();
  }
  return Number(revision);
}

function requireExpectedOwner(
  request: Request,
  response: Response,
  next: NextFunction
): void {
  if (response.locals.authMode !== "database") {
    next();
    return;
  }
  const principal = response.locals.authPrincipal as IdentityPrincipal | undefined;
  const expectedUserId = request.header("X-SBV2-Expected-User");
  if (principal && expectedUserId === principal.user.id) {
    next();
    return;
  }
  noStore(response);
  response.status(409).json({
    error:
      "The authenticated workspace owner changed. Reload before synchronizing workspaces.",
    code: "workspace_owner_mismatch"
  });
}

function routeId(request: Request): string {
  const value = request.params.id;
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function noStore(response: Response): void {
  response.setHeader("Cache-Control", "no-store");
}

function exportFileName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "workspace"
  );
}

function isBodyTooLarge(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    (error as { type?: unknown }).type === "entity.too.large"
  );
}

function isInvalidJson(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    (error as { type?: unknown }).type === "entity.parse.failed"
  );
}

async function sendDurableQuotaError(
  repository: WorkspaceRepository,
  response: Response,
  next: NextFunction,
  input: {
    status: 413 | 429;
    error: string;
    code: WorkspaceQuotaCode;
    attempted?: WorkspaceQuotaAttempt;
  }
): Promise<void> {
  try {
    const quota = await repository.quota(owner(response));
    response.status(input.status).json({
      error: input.error,
      code: input.code,
      quota,
      ...(input.attempted ? { attempted: input.attempted } : {})
    });
  } catch (error) {
    next(error);
  }
}

function bodySizeAttempt(
  error: unknown,
  request: Request
): WorkspaceQuotaAttempt | undefined {
  const declared =
    error && typeof error === "object"
      ? Number((error as { length?: unknown }).length)
      : Number.NaN;
  const measured = (
    request as Request & { workspaceRawBodyBytes?: number }
  ).workspaceRawBodyBytes;
  const envelopeBytes = Number.isSafeInteger(declared)
    ? declared
    : Number.isSafeInteger(measured)
      ? Number(measured)
      : undefined;
  return envelopeBytes === undefined ? undefined : { envelopeBytes };
}

function safePositiveInteger(coerce = false): z.ZodNumber {
  const number = coerce ? z.coerce.number() : z.number();
  return number.int().min(1).max(Number.MAX_SAFE_INTEGER);
}
