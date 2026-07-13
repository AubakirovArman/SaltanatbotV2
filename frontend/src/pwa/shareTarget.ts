import {
  collectPwaLaunchFiles,
  createPwaFileLaunchBatch,
  safePwaFileName,
  type PwaFileLaunchBatch,
  type PwaLaunchRejection,
  type PwaLaunchRejectionReason
} from "./fileLaunch";
import { PWA_SHARE_TARGET, PWA_SHARE_TOKEN_PATTERN } from "./shareTargetContract";

type ShareTargetLaunch = { kind: "none" } | { kind: "token"; token: string } | { kind: "error" };
type ShareTargetAction = "load" | "discard";

interface ShareTargetResponse {
  ok?: boolean;
  files?: Array<{ file?: File; name?: string }>;
  rejected?: Array<{ name?: string; reason?: string }>;
}

const rejectionReasons = new Set<PwaLaunchRejectionReason>(["too_many", "unsupported", "too_large", "unreadable"]);

export function parsePwaShareTargetLaunch(search = window.location.search): ShareTargetLaunch {
  const params = new URLSearchParams(search);
  const tokens = params.getAll("share");
  const errors = params.getAll("share_error");
  if (!tokens.length && !errors.length) return { kind: "none" };
  if (tokens.length === 1 && !errors.length && PWA_SHARE_TOKEN_PATTERN.test(tokens[0] ?? "")) {
    return { kind: "token", token: tokens[0]! };
  }
  return { kind: "error" };
}

export async function loadPwaShareTarget(token: string): Promise<PwaFileLaunchBatch> {
  if (!PWA_SHARE_TOKEN_PATTERN.test(token)) return unavailableBatch();
  const response = await sendShareTargetMessage("load", token);
  if (!response.ok || !Array.isArray(response.files)) return unavailableBatch();

  const handles = response.files.flatMap((item) => {
    if (!(item.file instanceof File) || typeof item.name !== "string") return [];
    return [{ name: item.name, getFile: async () => item.file! }];
  });
  const batch = await collectPwaLaunchFiles(handles, "share_target");
  const rejected = Array.isArray(response.rejected) ? response.rejected.flatMap(validateRejection) : [];
  return { ...batch, rejected: [...rejected, ...batch.rejected] };
}

export async function discardPwaShareTarget(token: string): Promise<boolean> {
  if (!PWA_SHARE_TOKEN_PATTERN.test(token)) return false;
  return (await sendShareTargetMessage("discard", token)).ok === true;
}

export function clearPwaShareTargetLaunch(target: Pick<Window, "location" | "history"> = window) {
  const url = new URL(target.location.href);
  url.searchParams.delete("share");
  url.searchParams.delete("share_error");
  target.history.replaceState(target.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function validateRejection(input: { name?: string; reason?: string }): PwaLaunchRejection[] {
  if (!rejectionReasons.has(input.reason as PwaLaunchRejectionReason)) return [];
  return [{ name: safePwaFileName(input.name), reason: input.reason as PwaLaunchRejectionReason }];
}

function unavailableBatch() {
  return createPwaFileLaunchBatch("share_target", [], [{ reason: "expired" }]);
}

async function sendShareTargetMessage(action: ShareTargetAction, token: string): Promise<ShareTargetResponse> {
  if (!("serviceWorker" in navigator) || typeof MessageChannel === "undefined") return {};
  try {
    const registration = await navigator.serviceWorker.ready;
    const worker = navigator.serviceWorker.controller ?? registration.active;
    if (!worker) return {};
    return await new Promise<ShareTargetResponse>((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = window.setTimeout(() => reject(new Error("share_target_timeout")), 10_000);
      channel.port1.onmessage = (event) => {
        window.clearTimeout(timeout);
        resolve(event.data ?? {});
      };
      worker.postMessage({ type: `${PWA_SHARE_TARGET.messagePrefix}${action}`, token }, [channel.port2]);
    });
  } catch {
    return {};
  }
}
