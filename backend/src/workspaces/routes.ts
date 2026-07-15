import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Pool } from "pg";
import type { IdentityPrincipal } from "../identity/types.js";
import { WorkspaceConflictError, WorkspaceRepository } from "./repository.js";

const inputSchema = z.object({
  clientId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
  name: z.string().trim().min(1).max(120),
  schemaVersion: z.number().int().min(1).max(10_000),
  payload: z.record(z.unknown())
}).strict();

const updateSchema = inputSchema.extend({ revision: z.number().int().min(1) });
const revisionSchema = z.object({
  revision: z.number().int().min(1),
  targetRevision: z.number().int().min(1)
}).strict();
const idSchema = z.string().uuid();

export function createWorkspaceRouter(pool: Pool): Router {
  const repository = new WorkspaceRepository(pool);
  const router = Router();

  router.get("/", asyncRoute(async (_request, response) => {
    response.json({ workspaces: await repository.list(owner(response)) });
  }));

  router.post("/", asyncRoute(async (request, response) => {
    const input = inputSchema.parse(request.body);
    response.status(201).json({ workspace: await repository.create(owner(response), input) });
  }));

  router.get("/:id", asyncRoute(async (request, response) => {
    const workspace = await repository.get(owner(response), idSchema.parse(routeId(request)));
    if (!workspace) return response.status(404).json({ error: "Workspace not found.", code: "workspace_not_found" });
    response.json({ workspace });
  }));

  router.put("/:id", asyncRoute(async (request, response) => {
    const { revision, ...input } = updateSchema.parse(request.body);
    const workspace = await repository.update(owner(response), idSchema.parse(routeId(request)), revision, input);
    response.json({ workspace });
  }));

  router.delete("/:id", asyncRoute(async (request, response) => {
    const revision = z.coerce.number().int().min(1).parse(request.query.revision);
    const removed = await repository.remove(owner(response), idSchema.parse(routeId(request)), revision);
    if (!removed) return response.status(404).json({ error: "Workspace not found.", code: "workspace_not_found" });
    response.json({ ok: true });
  }));

  router.get("/:id/revisions", asyncRoute(async (request, response) => {
    response.json({ revisions: await repository.revisions(owner(response), idSchema.parse(routeId(request))) });
  }));

  router.post("/:id/rollback", asyncRoute(async (request, response) => {
    const input = revisionSchema.parse(request.body);
    const workspace = await repository.rollback(
      owner(response),
      idSchema.parse(routeId(request)),
      input.revision,
      input.targetRevision
    );
    response.json({ workspace });
  }));

  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (error instanceof WorkspaceConflictError) {
      response.status(409).json({ error: error.message, code: "workspace_conflict", current: error.current });
      return;
    }
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: "Invalid workspace request.", code: "invalid_request", details: error.flatten() });
      return;
    }
    if (error instanceof Error && error.message === "workspace_revision_not_found") {
      response.status(404).json({ error: "Workspace revision not found.", code: "workspace_revision_not_found" });
      return;
    }
    next(error);
  });
  return router;
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response).catch(next);
  };
}

function owner(response: Response): string {
  const principal = response.locals.authPrincipal as IdentityPrincipal | undefined;
  if (!principal) throw new Error("Authenticated principal missing");
  return principal.user.id;
}

function routeId(request: Request): string {
  const value = request.params.id;
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
