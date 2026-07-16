import {
  MAX_CONFIGURED_WORKSPACE_DOCUMENT_BYTES,
  minimumWorkspaceRetainedPayloadBytes,
  WORKSPACE_DATABASE_PAYLOAD_BYTE_LIMIT
} from "./workspaceLimits.js";

export interface WorkspaceQuotaLimits {
  maxActiveWorkspaces: number;
  maxTotalWorkspaces: number;
  maxRevisionsPerWorkspace: number;
  maxDocumentBytes: number;
  maxRetainedPayloadBytesPerOwner: number;
}

export interface WorkspaceQuotaUsage {
  activeCount: number;
  totalCount: number;
  payloadBytesUsed: number;
}

export interface WorkspaceQuotaSnapshot {
  activeCount: number;
  activeLimit: number;
  totalCount: number;
  totalLimit: number;
  payloadBytesUsed: number;
  payloadBytesLimit: number;
  maxDocumentBytes: number;
  maxDatabaseDocumentBytes: number;
  maxRevisions: number;
}

export interface WorkspaceQuotaAttempt {
  activeCount?: number;
  totalCount?: number;
  payloadBytesUsed?: number;
  documentBytes?: number;
  databaseDocumentBytes?: number;
  envelopeBytes?: number;
}

export const WORKSPACE_ENVELOPE_OVERHEAD_BYTES = 64 * 1_024;

export const DEFAULT_WORKSPACE_QUOTA_LIMITS: Readonly<WorkspaceQuotaLimits> = Object.freeze({
  maxActiveWorkspaces: 25,
  maxTotalWorkspaces: 75,
  maxRevisionsPerWorkspace: 20,
  maxDocumentBytes: 1_048_576,
  maxRetainedPayloadBytesPerOwner: 67_108_864
});

export type WorkspaceQuotaCode =
  | "workspace_active_quota_exceeded"
  | "workspace_total_quota_exceeded"
  | "workspace_storage_quota_exceeded"
  | "workspace_document_too_large"
  | "workspace_database_document_too_large"
  | "workspace_envelope_too_large";

export class WorkspaceQuotaError extends Error {
  constructor(
    readonly code: WorkspaceQuotaCode,
    readonly quota: WorkspaceQuotaSnapshot,
    readonly status: 413 | 429,
    readonly attempted?: WorkspaceQuotaAttempt
  ) {
    super(quotaMessage(code, quota));
    this.name = "WorkspaceQuotaError";
  }
}

export function loadWorkspaceQuotaLimits(env: NodeJS.ProcessEnv = process.env): WorkspaceQuotaLimits {
  const limits = {
    maxActiveWorkspaces: positiveInteger(
      env,
      "WORKSPACE_MAX_ACTIVE_PER_USER",
      DEFAULT_WORKSPACE_QUOTA_LIMITS.maxActiveWorkspaces,
      1_000
    ),
    maxTotalWorkspaces: positiveInteger(
      env,
      "WORKSPACE_MAX_TOTAL_PER_USER",
      DEFAULT_WORKSPACE_QUOTA_LIMITS.maxTotalWorkspaces,
      3_200
    ),
    maxRevisionsPerWorkspace: positiveInteger(
      env,
      "WORKSPACE_MAX_REVISIONS_PER_WORKSPACE",
      DEFAULT_WORKSPACE_QUOTA_LIMITS.maxRevisionsPerWorkspace,
      100
    ),
    maxDocumentBytes: positiveInteger(
      env,
      "WORKSPACE_MAX_DOCUMENT_BYTES",
      DEFAULT_WORKSPACE_QUOTA_LIMITS.maxDocumentBytes,
      MAX_CONFIGURED_WORKSPACE_DOCUMENT_BYTES
    ),
    maxRetainedPayloadBytesPerOwner: positiveInteger(
      env,
      "WORKSPACE_MAX_RETAINED_PAYLOAD_BYTES_PER_USER",
      DEFAULT_WORKSPACE_QUOTA_LIMITS.maxRetainedPayloadBytesPerOwner,
      DEFAULT_WORKSPACE_QUOTA_LIMITS.maxRetainedPayloadBytesPerOwner
    )
  };
  if (limits.maxActiveWorkspaces > limits.maxTotalWorkspaces) {
    throw new Error("WORKSPACE_MAX_ACTIVE_PER_USER cannot exceed WORKSPACE_MAX_TOTAL_PER_USER");
  }
  if (
    limits.maxRetainedPayloadBytesPerOwner <
    minimumWorkspaceRetainedPayloadBytes()
  ) {
    throw new Error(
      "WORKSPACE_MAX_RETAINED_PAYLOAD_BYTES_PER_USER must retain at least one current document and its first revision"
    );
  }
  return limits;
}

export function quotaSnapshot(
  usage: WorkspaceQuotaUsage,
  limits: WorkspaceQuotaLimits
): WorkspaceQuotaSnapshot {
  return {
    activeCount: safeUsage(usage.activeCount, "active workspace count"),
    activeLimit: limits.maxActiveWorkspaces,
    totalCount: safeUsage(usage.totalCount, "total workspace count"),
    totalLimit: limits.maxTotalWorkspaces,
    payloadBytesUsed: safeUsage(usage.payloadBytesUsed, "workspace payload bytes"),
    payloadBytesLimit: limits.maxRetainedPayloadBytesPerOwner,
    maxDocumentBytes: limits.maxDocumentBytes,
    maxDatabaseDocumentBytes: WORKSPACE_DATABASE_PAYLOAD_BYTE_LIMIT,
    maxRevisions: limits.maxRevisionsPerWorkspace
  };
}

export function assertWorkspaceQuota(snapshot: WorkspaceQuotaSnapshot): void {
  if (snapshot.activeCount > snapshot.activeLimit) {
    throw new WorkspaceQuotaError(
      "workspace_active_quota_exceeded",
      snapshot,
      429,
      attemptedUsage(snapshot)
    );
  }
  if (snapshot.totalCount > snapshot.totalLimit) {
    throw new WorkspaceQuotaError(
      "workspace_total_quota_exceeded",
      snapshot,
      429,
      attemptedUsage(snapshot)
    );
  }
  if (snapshot.payloadBytesUsed > snapshot.payloadBytesLimit) {
    throw new WorkspaceQuotaError(
      "workspace_storage_quota_exceeded",
      snapshot,
      429,
      attemptedUsage(snapshot)
    );
  }
}

export function assertWorkspaceDocumentSize(
  bytes: number,
  limits: WorkspaceQuotaLimits,
  usage: WorkspaceQuotaUsage = { activeCount: 0, totalCount: 0, payloadBytesUsed: 0 }
): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error("Workspace document byte size is invalid; refusing the mutation.");
  }
  if (bytes > limits.maxDocumentBytes) {
    throw new WorkspaceQuotaError(
      "workspace_document_too_large",
      quotaSnapshot(usage, limits),
      413,
      { documentBytes: bytes }
    );
  }
}

export function assertWorkspaceDatabaseDocumentSize(
  bytes: number,
  limits: WorkspaceQuotaLimits,
  usage: WorkspaceQuotaUsage = {
    activeCount: 0,
    totalCount: 0,
    payloadBytesUsed: 0
  }
): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error("Workspace database byte bound is invalid; refusing the mutation.");
  }
  if (bytes > WORKSPACE_DATABASE_PAYLOAD_BYTE_LIMIT) {
    throw new WorkspaceQuotaError(
      "workspace_database_document_too_large",
      quotaSnapshot(usage, limits),
      413,
      { databaseDocumentBytes: bytes }
    );
  }
}

export function workspaceEnvelopeByteLimit(limits: WorkspaceQuotaLimits): number {
  return limits.maxDocumentBytes + WORKSPACE_ENVELOPE_OVERHEAD_BYTES;
}

export function assertWorkspaceEnvelopeSize(
  bytes: number,
  limits: WorkspaceQuotaLimits,
  usage: WorkspaceQuotaUsage = { activeCount: 0, totalCount: 0, payloadBytesUsed: 0 }
): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error("Workspace envelope byte size is invalid; refusing the mutation.");
  }
  if (bytes > workspaceEnvelopeByteLimit(limits)) {
    throw new WorkspaceQuotaError(
      "workspace_envelope_too_large",
      quotaSnapshot(usage, limits),
      413,
      { envelopeBytes: bytes }
    );
  }
}

function attemptedUsage(
  snapshot: WorkspaceQuotaSnapshot
): WorkspaceQuotaAttempt {
  return {
    activeCount: snapshot.activeCount,
    totalCount: snapshot.totalCount,
    payloadBytesUsed: snapshot.payloadBytesUsed
  };
}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

function safeUsage(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label} in database`);
  }
  return value;
}

function quotaMessage(code: WorkspaceQuotaCode, quota: WorkspaceQuotaSnapshot): string {
  switch (code) {
    case "workspace_active_quota_exceeded":
      return `Active workspace limit reached (${quota.activeLimit} per user).`;
    case "workspace_total_quota_exceeded":
      return `Total workspace limit reached (${quota.totalLimit} per user).`;
    case "workspace_storage_quota_exceeded":
      return `Workspace storage limit reached (${quota.payloadBytesLimit} bytes per user).`;
    case "workspace_document_too_large":
      return `Workspace document exceeds ${quota.maxDocumentBytes} bytes.`;
    case "workspace_database_document_too_large":
      return `Workspace PostgreSQL representation exceeds ${quota.maxDatabaseDocumentBytes} bytes.`;
    case "workspace_envelope_too_large":
      return `Workspace request envelope exceeds ${
        quota.maxDocumentBytes + WORKSPACE_ENVELOPE_OVERHEAD_BYTES
      } bytes.`;
  }
}
