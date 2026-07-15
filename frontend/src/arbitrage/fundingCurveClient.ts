import { SaltanatArbitrageClient, type FundingCurveRequest, type FundingCurveResponse, type FundingCurveUniverseResponse } from "@saltanatbotv2/arbitrage-sdk";

export async function fetchFundingCurveUniverse(signal?: AbortSignal): Promise<FundingCurveUniverseResponse> {
  return browserClient().fundingCurveUniverse(signal);
}

export async function evaluateFundingCurve(request: FundingCurveRequest, signal?: AbortSignal): Promise<FundingCurveResponse> {
  return browserClient().fundingCurve(request, signal);
}

function browserClient() {
  return new SaltanatArbitrageClient({ baseUrl: window.location.origin });
}
