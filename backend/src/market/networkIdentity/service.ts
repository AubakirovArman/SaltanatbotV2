import { evaluateTransferCompatibility } from "./evaluate.js";
import { NetworkIdentityRegistry } from "./registry.js";
import { reviewedNetworkIdentityDocument } from "./reviewedSnapshot.js";
import { networkIdentityPreflightRequestSchema } from "./schema.js";
import type { NetworkIdentityRegistryDocument, ReviewedIdentityEvidence, TransferCompatibilityResult } from "./types.js";

interface RegistryState {
  generation: number;
  registry: NetworkIdentityRegistry;
}

export interface NetworkIdentityRegistryEnvelope {
  schemaVersion: 1;
  modelVersion: "network-identity-registry-v1";
  readOnly: true;
  executable: false;
  generation: number;
  evaluatedAt: number;
  validity: {
    status: "current" | "stale";
    reason: "current" | "not-yet-valid" | "expired";
    asOf: number;
    validUntil: number;
    remainingMs: number;
  };
  registry: NetworkIdentityRegistryDocument;
}

/** Server-owned atomic snapshot. No HTTP route exposes install or mutation. */
export class NetworkIdentityService {
  #state: RegistryState;

  constructor(input: unknown = reviewedNetworkIdentityDocument()) {
    this.#state = { generation: 1, registry: validatedServerRegistry(input) };
  }

  snapshot(evaluatedAt = Date.now()): NetworkIdentityRegistryEnvelope {
    if (!Number.isSafeInteger(evaluatedAt) || evaluatedAt <= 0) throw new TypeError("network identity evaluatedAt must be a positive safe integer");
    const state = this.#state;
    const registry = state.registry.snapshot();
    const window = evidenceWindow(registry);
    const reason = evaluatedAt < window.asOf ? "not-yet-valid" : evaluatedAt > window.validUntil ? "expired" : "current";
    return {
      schemaVersion: 1,
      modelVersion: "network-identity-registry-v1",
      readOnly: true,
      executable: false,
      generation: state.generation,
      evaluatedAt,
      validity: {
        status: reason === "current" ? "current" : "stale",
        reason,
        asOf: window.asOf,
        validUntil: window.validUntil,
        remainingMs: Math.max(0, window.validUntil - evaluatedAt)
      },
      registry
    };
  }

  /** Internal replay/test surface; public HTTP evaluation uses evaluatePublic. */
  evaluate(input: unknown): TransferCompatibilityResult {
    const state = this.#state;
    return evaluateTransferCompatibility(state.registry, input);
  }

  /** Public evaluation pins time to a server-supplied instant. */
  evaluatePublic(input: unknown, evaluatedAt: number): { validRequest: boolean; result: TransferCompatibilityResult } {
    if (!Number.isSafeInteger(evaluatedAt) || evaluatedAt <= 0) throw new TypeError("network identity evaluatedAt must be a positive safe integer");
    const state = this.#state;
    const parsed = networkIdentityPreflightRequestSchema.safeParse(input);
    if (!parsed.success) {
      return {
        validRequest: false,
        result: evaluateTransferCompatibility(state.registry, {
          routeId: input && typeof input === "object" && typeof (input as { routeId?: unknown }).routeId === "string" ? (input as { routeId: string }).routeId : "invalid-request",
          evaluatedAt
        })
      };
    }
    return {
      validRequest: true,
      result: evaluateTransferCompatibility(state.registry, { ...parsed.data, evaluatedAt })
    };
  }

  /** Internal/operator update primitive: validate completely, then swap once. */
  install(input: unknown): NetworkIdentityRegistryEnvelope {
    const registry = validatedServerRegistry(input);
    const current = this.#state;
    this.#state = { generation: current.generation + 1, registry };
    return this.snapshot();
  }
}

function validatedServerRegistry(input: unknown): NetworkIdentityRegistry {
  const registry = new NetworkIdentityRegistry(input);
  const document = registry.snapshot();
  for (const evidence of allEvidence(document)) {
    if (evidence.version !== document.registryVersion) {
      throw new TypeError(`network identity evidence version ${evidence.version} does not match registry ${document.registryVersion}`);
    }
  }
  return registry;
}

function allEvidence(document: NetworkIdentityRegistryDocument): ReviewedIdentityEvidence[] {
  return [
    document.evidence,
    ...document.assets.map(({ evidence }) => evidence),
    ...document.networks.map(({ evidence }) => evidence),
    ...document.networkAssets.map(({ evidence }) => evidence),
    ...document.venueMappings.map(({ evidence }) => evidence),
    ...document.transferCapabilities.flatMap(({ status, limits, fee, confirmations, timing }) => [status.evidence, limits.evidence, fee.evidence, confirmations.evidence, timing.evidence])
  ];
}

function evidenceWindow(document: NetworkIdentityRegistryDocument): { asOf: number; validUntil: number } {
  const evidence = allEvidence(document);
  return {
    asOf: Math.max(...evidence.map(({ asOf }) => asOf)),
    validUntil: Math.min(...evidence.map(({ validUntil }) => validUntil))
  };
}

export const networkIdentityService = new NetworkIdentityService();
