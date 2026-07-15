import { tradeApiRequest } from "./tradeClient";
import { parseResearchAlertDeliveriesResponse, parseResearchAlertPoliciesResponse, parseResearchAlertPolicyInput, parseResearchAlertPolicyResponse, parseResearchAlertState } from "./researchAlertParser";
import type { ResearchAlertPolicyInput } from "./researchAlertTypes";

const BASE = "/arbitrage-alerts/research";

export const getResearchAlertState = (signal?: AbortSignal) => tradeApiRequest<unknown>(BASE, { signal }).then(parseResearchAlertState);

export function getResearchAlertDeliveries(limit = 100, signal?: AbortSignal) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError("Research alert delivery limit must be an integer from 1 to 500");
  return tradeApiRequest<unknown>(`${BASE}/deliveries?limit=${encodeURIComponent(String(limit))}`, { signal }).then((value) => parseResearchAlertDeliveriesResponse(value, limit));
}

export const saveResearchAlertPolicy = (input: ResearchAlertPolicyInput) =>
  tradeApiRequest<unknown>(BASE, {
    method: "POST",
    body: JSON.stringify(parseResearchAlertPolicyInput(input))
  }).then(parseResearchAlertPolicyResponse);

export const deleteResearchAlertPolicy = (id: string) =>
  tradeApiRequest<unknown>(`${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" }).then(parseResearchAlertPoliciesResponse);
