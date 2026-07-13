export type OfflineResearchStatus = {
  supported: boolean;
  installed: boolean;
  files: number;
  bytes: number;
};

type ResearchMessage = "status" | "install" | "remove";

export async function queryOfflineResearch(): Promise<OfflineResearchStatus> {
  return sendResearchMessage("status");
}

export async function installOfflineResearch(): Promise<OfflineResearchStatus> {
  return sendResearchMessage("install");
}

export async function removeOfflineResearch(): Promise<OfflineResearchStatus> {
  return sendResearchMessage("remove");
}

async function sendResearchMessage(action: ResearchMessage): Promise<OfflineResearchStatus> {
  if (!("serviceWorker" in navigator) || typeof MessageChannel === "undefined") return unsupportedStatus();
  try {
    const registration = await navigator.serviceWorker.ready;
    const worker = navigator.serviceWorker.controller ?? registration.active;
    if (!worker) return unsupportedStatus();
    const response = await new Promise<{ ok?: boolean; installed?: boolean; files?: number; bytes?: number }>((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = window.setTimeout(() => reject(new Error("offline_research_timeout")), 30_000);
      channel.port1.onmessage = (event) => {
        window.clearTimeout(timeout);
        resolve(event.data ?? {});
      };
      worker.postMessage({ type: `saltanat:offline-research:${action}` }, [channel.port2]);
    });
    if (!response.ok) throw new Error("offline_research_failed");
    return { supported: true, installed: response.installed === true, files: response.files ?? 0, bytes: response.bytes ?? 0 };
  } catch {
    return unsupportedStatus();
  }
}

function unsupportedStatus(): OfflineResearchStatus {
  return { supported: false, installed: false, files: 0, bytes: 0 };
}
