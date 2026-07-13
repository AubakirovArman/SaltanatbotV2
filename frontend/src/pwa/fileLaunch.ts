export type PwaLaunchFileKind = "pine" | "strategy" | "plugin";

export type PwaLaunchRejectionReason = "too_many" | "unsupported" | "too_large" | "unreadable";

export interface PwaLaunchFile {
  file: File;
  name: string;
  kind: PwaLaunchFileKind;
}

export interface PwaLaunchRejection {
  name?: string;
  reason: PwaLaunchRejectionReason;
}

export interface PwaFileLaunchBatch {
  id: number;
  files: PwaLaunchFile[];
  rejected: PwaLaunchRejection[];
}

export interface PwaFileHandle {
  name?: string;
  getFile(): Promise<File>;
}

export interface PwaLaunchParams {
  files?: readonly PwaFileHandle[];
  targetURL?: string;
}

export interface PwaLaunchQueue {
  setConsumer(consumer: (params: PwaLaunchParams) => void): void;
}

export interface PwaLaunchWindow {
  launchQueue?: PwaLaunchQueue;
}

const MAX_FILES_PER_LAUNCH = 10;
const MAX_FILE_BYTES: Record<PwaLaunchFileKind, number> = {
  pine: 1_000_000,
  strategy: 2_000_000,
  plugin: 5_000_000
};

let nextBatchId = 1;

/**
 * Registers the installed-PWA launch consumer when the browser exposes it. Manual
 * file inputs remain the complete fallback in browsers without File Handling API.
 */
export function registerPwaFileLaunch(
  target: PwaLaunchWindow,
  onLaunch: (batch: PwaFileLaunchBatch) => void
): boolean {
  if (!target.launchQueue?.setConsumer) return false;
  try {
    target.launchQueue.setConsumer((params) => {
      const handles = params.files ?? [];
      if (!handles.length) return;
      void collectPwaLaunchFiles(handles).then(onLaunch);
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads only File metadata/handles. Contents are deliberately left unread until the
 * user confirms the in-app review step in Strategy Studio.
 */
export async function collectPwaLaunchFiles(handles: readonly PwaFileHandle[]): Promise<PwaFileLaunchBatch> {
  const acceptedHandles = handles.slice(0, MAX_FILES_PER_LAUNCH);
  const rejected: PwaLaunchRejection[] = [];
  if (handles.length > acceptedHandles.length) {
    rejected.push({ reason: "too_many" });
  }

  const settled = await Promise.allSettled(acceptedHandles.map(async (handle) => {
    const handleName = safeFileName(handle.name);
    const expectedKind = classifyPwaLaunchFile(handleName);
    if (!expectedKind) return { rejection: { name: handleName, reason: "unsupported" } as PwaLaunchRejection };
    const file = await handle.getFile();
    const name = safeFileName(file.name || handleName);
    const kind = classifyPwaLaunchFile(name);
    if (!kind || kind !== expectedKind) return { rejection: { name, reason: "unsupported" } as PwaLaunchRejection };
    if (file.size > MAX_FILE_BYTES[kind]) return { rejection: { name, reason: "too_large" } as PwaLaunchRejection };
    return { file: { file, name: name ?? handleName ?? "unnamed", kind } satisfies PwaLaunchFile };
  }));

  const files: PwaLaunchFile[] = [];
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];
    if (result.status === "rejected") {
      rejected.push({ name: safeFileName(acceptedHandles[index]?.name), reason: "unreadable" });
    } else if (result.value.file) {
      files.push(result.value.file);
    } else {
      rejected.push(result.value.rejection);
    }
  }

  return { id: nextBatchId++, files, rejected };
}

export function classifyPwaLaunchFile(name?: string): PwaLaunchFileKind | undefined {
  const normalized = name?.trim().toLowerCase();
  if (normalized?.endsWith(".pine")) return "pine";
  if (normalized?.endsWith(".strategy")) return "strategy";
  if (normalized?.endsWith(".saltanat-plugin")) return "plugin";
  return undefined;
}

export function pwaLaunchFileLimit(kind: PwaLaunchFileKind): number {
  return MAX_FILE_BYTES[kind];
}

function safeFileName(name?: string): string | undefined {
  if (!name) return undefined;
  const normalized = Array.from(name)
    .filter((character) => character.codePointAt(0)! >= 32 && character.codePointAt(0) !== 127)
    .join("")
    .trim();
  if (!normalized) return undefined;
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}…`;
}
