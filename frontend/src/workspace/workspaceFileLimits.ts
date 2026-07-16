export const MAX_WORKSPACE_DOCUMENT_BYTES = 1_048_576;
export const MAX_WORKSPACE_FILE_OVERHEAD_BYTES = 64 * 1_024;
export const MAX_WORKSPACE_FILE_BYTES = MAX_WORKSPACE_DOCUMENT_BYTES + MAX_WORKSPACE_FILE_OVERHEAD_BYTES;

export function workspaceDocumentBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Preserves the newest contiguous history that still fits the server payload contract. */
export function boundWorkspaceHistory<T extends { history: H[] }, H>(workspace: T): T {
  const base = { ...workspace, history: [] as H[] };
  if (workspaceDocumentBytes(base) > MAX_WORKSPACE_DOCUMENT_BYTES) {
    throw new RangeError("Workspace document exceeds the portable payload limit.");
  }
  const history: H[] = [];
  for (let index = workspace.history.length - 1; index >= 0; index -= 1) {
    const candidate = [workspace.history[index]!, ...history];
    if (workspaceDocumentBytes({ ...base, history: candidate }) > MAX_WORKSPACE_DOCUMENT_BYTES) break;
    history.unshift(workspace.history[index]!);
  }
  return { ...base, history } as T;
}
