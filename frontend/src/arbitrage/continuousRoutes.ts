import { parseContinuousRouteLiveResponse, type ContinuousRouteLiveResponse } from "@saltanatbotv2/arbitrage-sdk";

export type { ContinuousRouteLiveResponse };

export async function fetchContinuousRoutes(signal?: AbortSignal): Promise<ContinuousRouteLiveResponse> {
  const response = await fetch("/api/arbitrage/route-families/live", { signal, headers: { Accept: "application/json" } });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(typeof body.error === "string" ? body.error : `Continuous route API ${response.status}`);
  }
  return parseContinuousRouteLiveResponse(await response.json());
}
