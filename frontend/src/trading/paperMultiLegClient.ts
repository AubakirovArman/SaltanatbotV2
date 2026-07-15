import { tradeApiRequest } from "./tradeClient";
import { parsePaperMultiLegListResponse, parsePaperMultiLegRecoveryResponse, parsePaperMultiLegRunResponse, parsePaperMultiLegSubmissionResponse } from "./paperMultiLegParser";
import type { PaperMultiLegPlan } from "./paperMultiLegTypes";

const BASE = "/paper-multi-leg";

export const listPaperMultiLegRuns = (limit = 50, signal?: AbortSignal) => tradeApiRequest<unknown>(`${BASE}/runs?limit=${encodeURIComponent(String(limit))}`, { signal }).then(parsePaperMultiLegListResponse);

export const getPaperMultiLegRun = (runId: string, signal?: AbortSignal) => tradeApiRequest<unknown>(`${BASE}/runs/${encodeURIComponent(runId)}`, { signal }).then(parsePaperMultiLegRunResponse);

export const getPaperMultiLegRecovery = (signal?: AbortSignal) => tradeApiRequest<unknown>(`${BASE}/recovery`, { signal }).then(parsePaperMultiLegRecoveryResponse);

export const submitPaperMultiLegRun = (plan: PaperMultiLegPlan, idempotencyKey: string) =>
  tradeApiRequest<unknown>(`${BASE}/runs`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ plan })
  }).then(parsePaperMultiLegSubmissionResponse);
