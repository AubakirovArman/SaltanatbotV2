import { parseNetworkIdentityRegistry } from "./schema.js";
import type { CanonicalAssetIdentity, CanonicalNetworkAssetIdentity, CanonicalNetworkIdentity, EndpointResolution, NetworkIdentityRegistryDocument, ReviewedIdentityEvidence, VenueTransferCapabilityEvidence, VenueTransferNetworkMapping } from "./types.js";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Immutable, syntactically and semantically reviewed identity snapshot. */
export class NetworkIdentityRegistry {
  readonly #document: NetworkIdentityRegistryDocument;
  readonly #assets: Map<string, CanonicalAssetIdentity>;
  readonly #networks: Map<string, CanonicalNetworkIdentity>;
  readonly #networkAssets: Map<string, CanonicalNetworkAssetIdentity>;
  readonly #capabilities: Map<string, VenueTransferCapabilityEvidence>;

  constructor(input: unknown) {
    this.#document = deepFreeze(structuredClone(parseNetworkIdentityRegistry(input)));
    this.#assets = new Map(this.#document.assets.map((asset) => [asset.assetId, asset]));
    this.#networks = new Map(this.#document.networks.map((network) => [network.networkId, network]));
    this.#networkAssets = new Map(this.#document.networkAssets.map((asset) => [asset.networkAssetId, asset]));
    this.#capabilities = new Map(this.#document.transferCapabilities.map((capability) => [capability.mappingId, capability]));
  }

  snapshot(): NetworkIdentityRegistryDocument {
    return structuredClone(this.#document);
  }

  get version(): string {
    return this.#document.registryVersion;
  }

  get evidence(): ReviewedIdentityEvidence {
    return this.#document.evidence;
  }

  asset(assetId: string): CanonicalAssetIdentity | undefined {
    return this.#assets.get(assetId);
  }

  networkAsset(networkAssetId: string): CanonicalNetworkAssetIdentity | undefined {
    return this.#networkAssets.get(networkAssetId);
  }

  network(networkId: string): CanonicalNetworkIdentity | undefined {
    return this.#networks.get(networkId);
  }

  resolveWithdrawal(venue: string, assetId: string, withdrawalNetworkCode: string): EndpointResolution {
    return this.#resolve((mapping) => mapping.venue === venue && mapping.assetId === assetId && mapping.withdrawalNetworkCode === withdrawalNetworkCode);
  }

  resolveDeposit(venue: string, assetId: string, depositNetworkCode: string): EndpointResolution {
    return this.#resolve((mapping) => mapping.venue === venue && mapping.assetId === assetId && mapping.depositNetworkCode === depositNetworkCode);
  }

  #resolve(predicate: (mapping: VenueTransferNetworkMapping) => boolean): EndpointResolution {
    const mappings = this.#document.venueMappings.filter(predicate);
    if (mappings.length === 0) return { status: "unknown" };
    if (mappings.length > 1) return { status: "ambiguous", mappings };
    const mapping = mappings[0] as VenueTransferNetworkMapping;
    const networkAsset = this.#networkAssets.get(mapping.networkAssetId);
    return {
      status: "resolved",
      mapping,
      capability: this.#capabilities.get(mapping.mappingId),
      asset: this.#assets.get(mapping.assetId),
      networkAsset,
      network: networkAsset ? this.#networks.get(networkAsset.networkId) : undefined
    };
  }
}
