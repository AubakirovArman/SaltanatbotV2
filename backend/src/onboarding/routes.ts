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
  OnboardingAuthorizationChangedError,
  OnboardingConflictError
} from "./errors.js";
import {
  OnboardingRepository,
  type OnboardingRepositoryContract
} from "./repository.js";
import {
  onboardingGoalSelectionSchema,
  onboardingMilestoneInputSchema,
  onboardingRevisionInputSchema
} from "./schemas.js";

export const ONBOARDING_REQUEST_BODY_BYTE_LIMIT = 16_384;

export interface OnboardingRouterOptions {
  repository?: OnboardingRepositoryContract;
}

export function createOnboardingRouter(
  pool: Pool,
  options: OnboardingRouterOptions = {}
): Router {
  const repository = options.repository ?? new OnboardingRepository(pool);
  const router = Router();

  router.use(requireExpectedOwner);
  router.use(
    express.json({
      limit: ONBOARDING_REQUEST_BODY_BYTE_LIMIT,
      strict: true
    })
  );

  router.get(
    "/",
    asyncRoute(async (_request, response) => {
      noStore(response);
      response.json({
        onboarding: await repository.get(owner(response))
      });
    })
  );

  router.put(
    "/goal",
    asyncRoute(async (request, response) => {
      const input = onboardingGoalSelectionSchema.parse(request.body);
      const onboarding = await repository.selectGoal(
        owner(response),
        input.revision,
        input.goal,
        authorizationRevision(response)
      );
      noStore(response);
      response.json({ onboarding });
    })
  );

  router.post(
    "/milestones",
    asyncRoute(async (request, response) => {
      const input = onboardingMilestoneInputSchema.parse(request.body);
      const onboarding = await repository.recordMilestone(
        owner(response),
        input.revision,
        input.milestone,
        authorizationRevision(response)
      );
      noStore(response);
      response.json({ onboarding });
    })
  );

  router.post(
    "/dismiss",
    asyncRoute(async (request, response) => {
      const input = onboardingRevisionInputSchema.parse(request.body);
      const onboarding = await repository.dismiss(
        owner(response),
        input.revision,
        authorizationRevision(response)
      );
      noStore(response);
      response.json({ onboarding });
    })
  );

  router.post(
    "/restart",
    asyncRoute(async (request, response) => {
      const input = onboardingRevisionInputSchema.parse(request.body);
      const onboarding = await repository.restart(
        owner(response),
        input.revision,
        authorizationRevision(response)
      );
      noStore(response);
      response.json({ onboarding });
    })
  );

  router.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: NextFunction
    ) => {
      noStore(response);
      if (error instanceof OnboardingConflictError) {
        response.status(409).json({
          error: error.message,
          code: "onboarding_conflict",
          current: error.current
        });
        return;
      }
      if (error instanceof OnboardingAuthorizationChangedError) {
        response.status(409).json({
          error: error.message,
          code: "onboarding_authorization_changed"
        });
        return;
      }
      if (isBodyTooLarge(error)) {
        response.status(413).json({
          error: `Onboarding request body exceeds ${ONBOARDING_REQUEST_BODY_BYTE_LIMIT} bytes.`,
          code: "onboarding_envelope_too_large"
        });
        return;
      }
      if (isInvalidJson(error)) {
        response.status(400).json({
          error: "Onboarding request body is not valid JSON.",
          code: "invalid_json"
        });
        return;
      }
      if (error instanceof z.ZodError) {
        response.status(400).json({
          error: "Invalid onboarding request.",
          code: "invalid_request",
          details: error.flatten()
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
    throw new OnboardingAuthorizationChangedError();
  }
  return Number(revision);
}

function requireExpectedOwner(
  request: Request,
  response: Response,
  next: NextFunction
): void {
  const principal = response.locals.authPrincipal as IdentityPrincipal | undefined;
  const expectedUserId = request.header("X-SBV2-Expected-User");
  if (
    response.locals.authMode === "database" &&
    principal &&
    expectedUserId === principal.user.id
  ) {
    next();
    return;
  }
  noStore(response);
  response.status(409).json({
    error:
      "The authenticated onboarding owner changed. Reload before saving onboarding progress.",
    code: "onboarding_owner_mismatch"
  });
}

function noStore(response: Response): void {
  response.setHeader("Cache-Control", "no-store");
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
