import { z } from "zod";
import {
  ONBOARDING_GOALS,
  ONBOARDING_MILESTONES
} from "./types.js";

export const onboardingRevisionSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

export const onboardingGoalSelectionSchema = z
  .object({
    revision: onboardingRevisionSchema,
    goal: z.enum(ONBOARDING_GOALS)
  })
  .strict();

export const onboardingMilestoneInputSchema = z
  .object({
    revision: onboardingRevisionSchema,
    milestone: z.enum(ONBOARDING_MILESTONES)
  })
  .strict();

export const onboardingRevisionInputSchema = z
  .object({
    revision: onboardingRevisionSchema
  })
  .strict();
