import type {
  WorkspaceCurrentMetadata,
  WorkspaceDocument
} from "./repository.js";
import { workspaceMetadata } from "./repositorySupport.js";

export class WorkspaceConflictError extends Error {
  readonly currentMetadata?: WorkspaceCurrentMetadata;

  constructor(readonly current?: WorkspaceDocument) {
    super("Workspace revision conflict");
    this.name = "WorkspaceConflictError";
    this.currentMetadata = current && workspaceMetadata(current);
  }
}

export class WorkspaceArchivedError extends Error {
  readonly currentMetadata: WorkspaceCurrentMetadata;

  constructor(readonly current: WorkspaceDocument) {
    super("Workspace is archived.");
    this.name = "WorkspaceArchivedError";
    this.currentMetadata = workspaceMetadata(current);
  }
}

export class WorkspaceNotArchivedError extends Error {
  readonly currentMetadata: WorkspaceCurrentMetadata;

  constructor(readonly current: WorkspaceDocument) {
    super("Workspace must be archived before permanent deletion.");
    this.name = "WorkspaceNotArchivedError";
    this.currentMetadata = workspaceMetadata(current);
  }
}

export class WorkspaceAuthorizationChangedError extends Error {
  constructor() {
    super("Workspace authorization changed. Reload before retrying.");
    this.name = "WorkspaceAuthorizationChangedError";
  }
}

export class WorkspaceInvalidTransitionError extends Error {
  readonly currentMetadata: WorkspaceCurrentMetadata;

  constructor(readonly current: WorkspaceDocument) {
    super("Workspace rollback requires the current and target schema versions to match.");
    this.name = "WorkspaceInvalidTransitionError";
    this.currentMetadata = workspaceMetadata(current);
  }
}

export class WorkspaceNotFoundError extends Error {
  constructor() {
    super("Workspace not found.");
    this.name = "WorkspaceNotFoundError";
  }
}
