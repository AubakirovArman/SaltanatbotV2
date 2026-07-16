import { createHash } from "node:crypto";
import { z } from "zod";
import {
  assertWorkspaceDatabaseDocumentSize,
  assertWorkspaceDocumentSize,
  assertWorkspaceEnvelopeSize,
  type WorkspaceQuotaLimits
} from "./quotas.js";
import { workspaceV7Schema, workspaceV8Schema } from "./workspaceV8Schema.js";
import { inspectWorkspaceJson } from "./workspaceLimits.js";

export {
  MAX_WORKSPACE_JSON_DEPTH,
  MAX_WORKSPACE_JSON_NODES
} from "./workspaceLimits.js";

export const WORKSPACE_FILE_FORMAT = "saltanatbotv2.workspace";
export const WORKSPACE_FILE_VERSION = 1;
export const WORKSPACE_FILE_ALGORITHM = "SHA-256";
export const workspaceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => workspaceJsonSafetyIssue(value) === undefined, {
    message: "Workspace name contains a PostgreSQL-incompatible character"
  });

export const workspaceInputObjectSchema = z
  .object({
    clientId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
    name: workspaceNameSchema,
    schemaVersion: z.number().int().min(1).max(10_000),
    payload: z.record(z.unknown())
  })
  .strict();

export const workspaceInputSchema = workspaceInputObjectSchema.superRefine(
  validateWorkspaceInputConsistency
);

export type WorkspaceInput = z.infer<typeof workspaceInputSchema>;

const exportMetadataSchema = z
  .object({
    clientId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
    name: workspaceNameSchema,
    schemaVersion: z.number().int().min(1).max(10_000)
  })
  .strict();

export const workspaceExportSchema = z
  .object({
    format: z.literal(WORKSPACE_FILE_FORMAT),
    version: z.literal(WORKSPACE_FILE_VERSION),
    algorithm: z.literal(WORKSPACE_FILE_ALGORITHM),
    checksum: z.string().regex(/^[0-9a-f]{64}$/),
    exportedAt: z.number().finite().nonnegative(),
    workspace: z.record(z.unknown()),
    metadata: exportMetadataSchema.optional()
  })
  .strict();

export type WorkspaceExportDocument = z.infer<typeof workspaceExportSchema>;

const importWrapperSchema = z
  .object({
    document: workspaceExportSchema,
    clientId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/)
      .optional(),
    name: workspaceNameSchema.optional()
  })
  .strict();

export class WorkspaceImportError extends Error {
  constructor(readonly code: "invalid_workspace_import" | "workspace_checksum_mismatch") {
    super(
      code === "workspace_checksum_mismatch"
        ? "Workspace import checksum does not match."
        : "Workspace import document is invalid."
    );
    this.name = "WorkspaceImportError";
  }
}

export function workspacePayloadBytes(payload: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

export function assertWorkspaceInputSize(
  input: WorkspaceInput,
  limits: WorkspaceQuotaLimits
): void {
  const inspection = inspectWorkspaceJson(input.payload);
  if (inspection.issue) {
    throw new Error(`Invalid workspace JSON: ${inspection.issue}`);
  }
  assertWorkspaceDocumentSize(inspection.compactBytes, limits);
  assertWorkspaceDatabaseDocumentSize(
    inspection.databaseBytesUpperBound,
    limits
  );
}

export function createWorkspaceExport(
  input: WorkspaceInput,
  exportedAt = Date.now()
): WorkspaceExportDocument {
  return {
    format: WORKSPACE_FILE_FORMAT,
    version: WORKSPACE_FILE_VERSION,
    algorithm: WORKSPACE_FILE_ALGORITHM,
    checksum: workspaceChecksum(input.payload),
    exportedAt,
    workspace: input.payload
  };
}

export function parseWorkspaceImport(
  value: unknown,
  limits: WorkspaceQuotaLimits
): WorkspaceInput {
  if (workspaceJsonSafetyIssue(value)) {
    throw new WorkspaceImportError("invalid_workspace_import");
  }
  assertWorkspaceEnvelopeSize(
    Buffer.byteLength(JSON.stringify(value), "utf8"),
    limits
  );
  const direct = workspaceExportSchema.safeParse(value);
  const wrapped = direct.success ? undefined : importWrapperSchema.safeParse(value);
  if (!direct.success && !wrapped?.success) throw new WorkspaceImportError("invalid_workspace_import");
  const document = direct.success
    ? direct.data
    : wrapped?.success
      ? wrapped.data.document
      : undefined;
  if (!document) throw new WorkspaceImportError("invalid_workspace_import");
  if (!safeChecksumEqual(document.checksum, workspaceChecksum(document.workspace))) {
    throw new WorkspaceImportError("workspace_checksum_mismatch");
  }

  const wrapper = wrapped?.success ? wrapped.data : undefined;
  const input = workspaceInputSchema.safeParse({
    clientId:
      wrapper?.clientId ??
      document.metadata?.clientId ??
      stringField(document.workspace, "id"),
    name:
      wrapper?.name ??
      document.metadata?.name ??
      stringField(document.workspace, "name"),
    schemaVersion:
      document.metadata?.schemaVersion ??
      numberField(document.workspace, "schemaVersion"),
    payload: applyImportOverrides(document.workspace, wrapper?.clientId, wrapper?.name)
  });
  if (!input.success) throw new WorkspaceImportError("invalid_workspace_import");
  if (input.data.schemaVersion !== 7 && input.data.schemaVersion !== 8) {
    throw new WorkspaceImportError("invalid_workspace_import");
  }
  assertWorkspaceInputSize(input.data, limits);
  return input.data;
}

export function workspaceChecksum(payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(canonicalStringify(payload), "utf8")
    .digest("hex");
}

export function withWorkspaceIdentity(
  payload: Record<string, unknown>,
  identity: { clientId?: string; name?: string; resetRevision?: boolean; now?: number }
): Record<string, unknown> {
  const next = structuredClone(payload);
  if (identity.clientId !== undefined && typeof next.id === "string") next.id = identity.clientId;
  if (identity.name !== undefined && typeof next.name === "string") next.name = identity.name;
  if (identity.resetRevision) {
    const now = identity.now ?? Date.now();
    if (typeof next.revision === "number") next.revision = 1;
    if (Array.isArray(next.history)) next.history = [];
    if (typeof next.createdAt === "number") next.createdAt = now;
    if (typeof next.updatedAt === "number") next.updatedAt = now;
    if (typeof next.savedAt === "number") next.savedAt = now;
    next.archivedAt = undefined;
  }
  return next;
}

export function advanceWorkspaceV8Content(
  target: Record<string, unknown>,
  current: Record<string, unknown>,
  now = Date.now()
): Record<string, unknown> {
  if (target.schemaVersion !== 8) return target;
  const currentRevision = current.revision;
  if (
    !Number.isSafeInteger(currentRevision) ||
    Number(currentRevision) < 1 ||
    !Number.isSafeInteger(now) ||
    now < 0
  ) {
    throw new Error("Invalid workspace content revision; refusing the mutation.");
  }
  return {
    ...target,
    revision: Number(currentRevision) + 1,
    savedAt: now,
    updatedAt: now
  };
}

export function validateWorkspaceInputConsistency(
  input: z.infer<typeof workspaceInputObjectSchema>,
  context: z.RefinementCtx
): void {
  const jsonSafetyIssue = workspaceJsonSafetyIssue(input.payload);
  if (jsonSafetyIssue) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payload"],
      message: jsonSafetyIssue
    });
    return;
  }
  consistentPayloadField(context, input.payload, "id", input.clientId);
  consistentPayloadField(context, input.payload, "name", input.name);
  consistentPayloadField(
    context,
    input.payload,
    "schemaVersion",
    input.schemaVersion
  );
  if (input.schemaVersion > 8) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["schemaVersion"],
      message: `Unsupported workspace schema version ${input.schemaVersion}`
    });
    return;
  }
  if (input.schemaVersion === 7 || input.schemaVersion === 8) {
    const parsed =
      input.schemaVersion === 8
        ? workspaceV8Schema.safeParse(input.payload)
        : workspaceV7Schema.safeParse(input.payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["payload", ...issue.path],
          message: issue.message
        });
      }
    }
    if (input.schemaVersion === 8 && input.payload.archivedAt !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "archivedAt"],
        message: "Archive state is server wrapper metadata, not workspace payload data"
      });
    }
  }
  const contentRevision = input.payload.revision;
  if (
    typeof contentRevision === "number" &&
    (!Number.isSafeInteger(contentRevision) || contentRevision < 1)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payload", "revision"],
      message: "Workspace content revision must be a positive safe integer"
    });
  }
}

function applyImportOverrides(
  payload: Record<string, unknown>,
  clientId?: string,
  name?: string
): Record<string, unknown> {
  if (clientId === undefined && name === undefined) return payload;
  return withWorkspaceIdentity(payload, { clientId, name });
}

function consistentPayloadField(
  context: z.RefinementCtx,
  payload: Record<string, unknown>,
  field: string,
  expected: string | number
): void {
  const value = payload[field];
  if (value !== undefined && value !== expected) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payload", field],
      message: `payload.${field} must match the workspace document metadata`
    });
  }
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  return typeof value[field] === "string" ? value[field] : undefined;
}

function numberField(value: Record<string, unknown>, field: string): number | undefined {
  return typeof value[field] === "number" ? value[field] : undefined;
}

function safeChecksumEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function workspaceJsonSafetyIssue(value: unknown): string | undefined {
  return inspectWorkspaceJson(value).issue;
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
