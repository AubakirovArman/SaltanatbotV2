import { z } from "zod";

export const loginSchema = z
  .object({
    login: z.string().min(1).max(128),
    password: z.string().min(1).max(256)
  })
  .strict();

export const registerSchema = loginSchema;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(1).max(256)
  })
  .strict();

export const mutationBaseSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3)
    .max(500)
    .refine((value) => !containsControlCharacter(value)),
  expectedAuthorizationRevision: z.number().int().positive()
});

export const lifecycleSchema = mutationBaseSchema
  .extend({
    appRole: z.enum(["user", "admin"]).optional(),
    tradingRole: z
      .enum(["none", "read-only", "paper-trade", "live-trade"])
      .optional()
  })
  .strict();

export const permissionsSchema = mutationBaseSchema
  .extend({
    appRole: z.enum(["user", "admin"]).optional(),
    tradingRole: z
      .enum(["none", "read-only", "paper-trade", "live-trade"])
      .optional()
  })
  .strict()
  .refine(
    (value) =>
      value.appRole !== undefined || value.tradingRole !== undefined
  );

export const reasonSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(3)
      .max(500)
      .refine((value) => !containsControlCharacter(value))
  })
  .strict();

export const uuidSchema = z.string().uuid().transform((value) => value.toLowerCase());

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}
