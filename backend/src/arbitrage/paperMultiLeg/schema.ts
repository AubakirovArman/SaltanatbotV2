import { z } from "zod";
import { ROUTE_FAMILIES } from "../routeFamilies/index.js";
import { PAPER_MULTI_LEG_MAX_LEGS, PAPER_MULTI_LEG_MAX_PLAN_LIFETIME_MS, PAPER_MULTI_LEG_MAX_SOURCE_AGE_MS, type PaperMultiLegPlan } from "./types.js";

const safeId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._/@-]*$/);
const marketIdentifier = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._/@#|+=>-]*$/);
const boundedOpaque = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine(
      (value) =>
        [...value].every((character) => {
          const code = character.codePointAt(0) ?? 0;
          return code >= 32 && code !== 127;
        }),
      "control characters are not allowed"
    );
const runId = z
  .string()
  .trim()
  .min(8)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/);
const timestamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const positive = z.number().finite().positive().max(1e15);
const quantity = z.number().finite().min(1e-12).max(1e15);
const nonNegative = z.number().finite().min(0).max(1e15);
const ratio = z.number().int().min(0).max(10_000);
const provenanceHash = z.string().regex(/^[a-f0-9]{64}$/);

const sourceBase = {
  opportunityId: boundedOpaque(16_384),
  evaluatedAt: timestamp,
  provenanceHash
} as const;

const source = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("route-family"),
      engine: z.literal("route-families-v1"),
      family: z.enum(ROUTE_FAMILIES),
      ...sourceBase
    })
    .strict(),
  z
    .object({
      kind: z.literal("n-leg"),
      engine: z.literal("n-leg-v1"),
      ...sourceBase
    })
    .strict()
]);

const leg = z
  .object({
    legId: safeId,
    venue: safeId,
    instrumentId: marketIdentifier,
    side: z.enum(["buy", "sell"]),
    quantityUnit: z.enum(["base", "quote", "contract", "native"]),
    plannedQuantity: quantity,
    referencePrice: positive,
    feeBps: nonNegative.max(10_000),
    paperFillRatioBps: ratio,
    paperCompensationFillRatioBps: ratio,
    paperCompensationPrice: positive,
    paperCompensationFeeBps: nonNegative.max(10_000),
    evidenceId: boundedOpaque(1_024)
  })
  .strict();

export const paperMultiLegPlanSchema = z
  .object({
    schemaVersion: z.literal("paper-multi-leg-plan-v1"),
    runId,
    source,
    createdAt: timestamp,
    expiresAt: timestamp,
    executionMode: z.literal("paper-sequential-legs"),
    simulationPolicy: z.literal("explicit-deterministic-fill-ratios-v1"),
    legs: z.array(leg).min(2).max(PAPER_MULTI_LEG_MAX_LEGS)
  })
  .strict()
  .superRefine((plan, context) => {
    if (plan.expiresAt <= plan.createdAt || plan.expiresAt - plan.createdAt > PAPER_MULTI_LEG_MAX_PLAN_LIFETIME_MS) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "plan lifetime must be positive and at most five minutes" });
    }
    if (plan.source.evaluatedAt > plan.createdAt + 1_000 || plan.createdAt - plan.source.evaluatedAt > PAPER_MULTI_LEG_MAX_SOURCE_AGE_MS) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["source", "evaluatedAt"], message: "source evidence must be no more than 60 seconds old" });
    }
    const ids = new Set<string>();
    for (const [index, value] of plan.legs.entries()) {
      if (ids.has(value.legId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["legs", index, "legId"], message: "legId must be unique" });
      ids.add(value.legId);
    }
    if (plan.source.kind === "route-family" && plan.legs.length !== 2) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["legs"], message: "route-family paper plans require exactly two legs" });
    }
    if (plan.source.kind === "n-leg" && plan.legs.length < 4) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["legs"], message: "N-leg paper plans require four through eight legs" });
    }
  });

export function parsePaperMultiLegPlan(input: unknown): PaperMultiLegPlan {
  return paperMultiLegPlanSchema.parse(input) as PaperMultiLegPlan;
}

export function validatePaperMultiLegPlanAt(plan: PaperMultiLegPlan, now: number): void {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("now must be a positive safe integer timestamp");
  if (now < plan.createdAt - 1_000) throw new Error("Paper multi-leg plan was created in the future");
  if (now > plan.expiresAt) throw new PaperMultiLegExpiredError("Paper multi-leg plan has expired");
  if (plan.source.evaluatedAt > now + 1_000 || now - plan.source.evaluatedAt > PAPER_MULTI_LEG_MAX_SOURCE_AGE_MS) {
    throw new PaperMultiLegExpiredError("Paper multi-leg source evidence is stale");
  }
}

export function parsePaperMultiLegIdempotencyKey(input: unknown): string {
  return z
    .string()
    .trim()
    .min(8)
    .max(160)
    .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/)
    .parse(input);
}

export class PaperMultiLegExpiredError extends Error {}
