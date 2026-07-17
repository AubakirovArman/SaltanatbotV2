import { parseScreenerRunRequestV1, type ScreenerDefinitionV1, type ScreenerRunRequestV1 } from "@saltanatbotv2/contracts";
import { ComputeJobResultRejectedError, serializeComputeJobResult } from "../jobs/resultPayload.js";
import { evaluateScreener } from "../screener/engine.js";
import { loadScreenerMarketData, ScreenerMarketDataError, type ScreenerMarketDataDependencies, type ScreenerMarketDataSnapshotV1 } from "../screener/marketData.js";
import { parseAndHashScreenerDefinition } from "../screener/repository.js";
import type { ScreenerRepositoryContract } from "../screener/repositoryTypes.js";

/**
 * In-process screener job executor. Unlike backtests this task needs network
 * access, so it runs on the research worker's main thread (no worker_thread)
 * behind the shared lease/heartbeat/timeout fences. Presets are resolved here,
 * at execution time, against the job owner.
 */

export const SCREENER_JOB_TIMEOUT_MS = 120_000;

export class ScreenerTaskError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ScreenerTaskError";
  }
}

export interface ScreenerTaskInput {
  ownerUserId: string;
  payload: unknown;
  signal?: AbortSignal;
}

export interface ScreenerTaskDependencies {
  presets: Pick<ScreenerRepositoryContract, "get">;
  marketData?: (definition: ScreenerDefinitionV1, dependencies?: ScreenerMarketDataDependencies) => Promise<ScreenerMarketDataSnapshotV1>;
  marketDataDependencies?: ScreenerMarketDataDependencies;
  now?: () => number;
}

export async function runScreenerTask(input: ScreenerTaskInput, dependencies: ScreenerTaskDependencies): Promise<Record<string, unknown>> {
  const now = dependencies.now ?? Date.now;
  const request = parseScreenerJobPayload(input.payload);
  const definition = await resolveDefinition(request, input.ownerUserId, dependencies);
  const parsed = hashDefinition(definition);
  const snapshot = await loadMarketData(parsed.definition, input.signal, dependencies);
  const result = evaluateScreener({
    definition: parsed.definition,
    definitionHash: parsed.hash,
    universe: snapshot.universe,
    candlesBySymbol: snapshot.candlesBySymbol,
    unavailableReasonBySymbol: snapshot.unavailableReasonBySymbol,
    now: now()
  }) as unknown as Record<string, unknown>;
  try {
    serializeComputeJobResult(result);
  } catch (error) {
    if (error instanceof ComputeJobResultRejectedError) throw new ScreenerTaskError(error.code, error.message);
    throw error;
  }
  return result;
}

function parseScreenerJobPayload(payload: unknown): ScreenerRunRequestV1 {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new ScreenerTaskError("screener_payload_invalid", "Screener job payload must be an object.");
  }
  const input = payload as { kind?: unknown; request?: unknown };
  if (input.kind !== "screener") {
    throw new ScreenerTaskError("screener_payload_invalid", "Screener job payload has an unexpected kind.");
  }
  try {
    return parseScreenerRunRequestV1(input.request);
  } catch (error) {
    throw new ScreenerTaskError("screener_payload_invalid", `Screener job payload is invalid: ${message(error)}`);
  }
}

async function resolveDefinition(request: ScreenerRunRequestV1, ownerUserId: string, dependencies: ScreenerTaskDependencies): Promise<ScreenerDefinitionV1> {
  if (request.definition) return request.definition;
  const presetId = request.presetId;
  if (!presetId) throw new ScreenerTaskError("screener_payload_invalid", "Screener job payload names neither a definition nor a preset.");
  const preset = await dependencies.presets.get(ownerUserId, presetId);
  if (!preset) throw new ScreenerTaskError("screener_preset_not_found", "Screener preset was not found for this owner.");
  if (preset.archivedAt) throw new ScreenerTaskError("screener_preset_archived", "Screener preset is archived and can no longer run.");
  return preset.definition;
}

function hashDefinition(definition: ScreenerDefinitionV1): { definition: ScreenerDefinitionV1; hash: string } {
  try {
    return parseAndHashScreenerDefinition(definition);
  } catch (error) {
    throw new ScreenerTaskError("screener_definition_invalid", `Screener definition is invalid: ${message(error)}`);
  }
}

async function loadMarketData(
  definition: ScreenerDefinitionV1,
  signal: AbortSignal | undefined,
  dependencies: ScreenerTaskDependencies
): Promise<ScreenerMarketDataSnapshotV1> {
  const load = dependencies.marketData ?? loadScreenerMarketData;
  const marketDataDependencies: ScreenerMarketDataDependencies = {
    ...dependencies.marketDataDependencies,
    ...(signal ? { signal } : {})
  };
  try {
    return await load(definition, marketDataDependencies);
  } catch (error) {
    if (error instanceof ScreenerMarketDataError) throw new ScreenerTaskError(error.code, error.message);
    throw new ScreenerTaskError("screener_market_data_unavailable", `Screener market data is unavailable: ${message(error)}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "unknown error";
}
