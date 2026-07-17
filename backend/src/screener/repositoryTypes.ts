import type { ScreenerDefinitionV1 } from "@saltanatbotv2/contracts";

export const MAX_ACTIVE_SCREENER_PRESETS_PER_OWNER = 40;
// A single-host beta bound: presets are inert documents, so this only caps
// durable storage growth. R6+ must raise it deliberately, not by accident.
export const MAX_ACTIVE_SCREENER_PRESETS_GLOBAL = 400;
// The per-owner quota and the management-list ceiling are intentionally larger
// than the quota so archived history stays visible without hidden rows.
export const SCREENER_REPOSITORY_DEFAULT_LIST_LIMIT = 100;
export const SCREENER_REPOSITORY_MAX_LIST_LIMIT = 100;

// Distinct from the alert (1_895_696_368/370) and compute-job (1_932_088_610)
// advisory namespaces so screener serialization never blocks other domains.
export const SCREENER_OWNER_ADVISORY_LOCK_NAMESPACE = 1_895_696_400;
export const SCREENER_GLOBAL_CAPACITY_LOCK = 1_895_696_401;

export interface ScreenerPresetRecord {
  id: string;
  ownerUserId: string;
  clientId: string;
  revision: number;
  authorizationRevision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  definitionHash: string;
  definition: ScreenerDefinitionV1;
}

export interface CreateScreenerPresetInput {
  ownerUserId: string;
  actorUserId: string;
  authorizationRevision: number;
  clientId: string;
  definition: unknown;
}

export interface UpdateScreenerPresetInput {
  ownerUserId: string;
  actorUserId: string;
  presetId: string;
  expectedRevision: number;
  authorizationRevision: number;
  definition: unknown;
}

export interface ArchiveScreenerPresetInput {
  ownerUserId: string;
  actorUserId: string;
  presetId: string;
  expectedRevision: number;
  authorizationRevision: number;
}

export interface ScreenerRepositoryContract {
  create(input: CreateScreenerPresetInput): Promise<ScreenerPresetRecord>;
  list(ownerUserId: string, limit?: number): Promise<ScreenerPresetRecord[]>;
  get(ownerUserId: string, presetId: string): Promise<ScreenerPresetRecord | undefined>;
  update(input: UpdateScreenerPresetInput): Promise<ScreenerPresetRecord>;
  archive(input: ArchiveScreenerPresetInput): Promise<ScreenerPresetRecord>;
}

export class ScreenerNotFoundError extends Error {}

export class ScreenerQuotaError extends Error {}

export class ScreenerCapacityError extends Error {}

export class ScreenerIdempotencyConflictError extends Error {}

export class ScreenerRevisionConflictError extends Error {}

export class ScreenerAuthorizationConflictError extends Error {}
