import { parseContinuousFeedHealthResponse, type ContinuousFeedHealthResponse } from "@saltanatbotv2/arbitrage-sdk";

export type { ContinuousFeedHealthResponse };

export async function fetchContinuousFeedHealth(signal?: AbortSignal): Promise<ContinuousFeedHealthResponse> {
  const response = await fetch("/api/arbitrage/continuous-feed-health", { signal, headers: { Accept: "application/json" } });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(typeof body.error === "string" ? body.error : `Continuous feed health API ${response.status}`);
  }
  return parseContinuousFeedHealthResponse(await response.json());
}
