import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTINUOUS_PUBLIC_VENUES, type ContinuousPublicVenue } from "../backend/src/arbitrage/upstream/publicFeeds/types.js";
import { createContinuousVenueProtocol } from "../backend/src/arbitrage/upstream/publicFeeds/protocolFactory.js";
import { publicVenueAdapters } from "../backend/src/venues/publicRegistry.js";
import { scannerModeDocumentationTruths } from "../frontend/src/arbitrage/ScannerModeNav";
import { compareCapabilityTruths, parseCapabilityTruthContract, parseGeneratedEndpointTotals } from "./lib/docs-semantic-guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = path.join(root, "docs/CAPABILITY_TRUTHS.json");
const endpointIndexPath = path.join(root, "docs/API_ENDPOINTS.generated.md");

try {
  const documented = parseCapabilityTruthContract(JSON.parse(readFileSync(contractPath, "utf8")));
  const endpointTotals = parseGeneratedEndpointTotals(readFileSync(endpointIndexPath, "utf8"));
  const source = parseCapabilityTruthContract({
    schemaVersion: 1,
    scannerModes: scannerModeDocumentationTruths(),
    registeredPublicVenues: [...publicVenueAdapters.keys()],
    continuousPublicVenues: [...CONTINUOUS_PUBLIC_VENUES],
    venueDisplayNames: documented.venueDisplayNames,
    generatedEndpoints: endpointTotals
  });
  const failures = [...sourceInvariantFailures(), ...canonicalDocumentationFailures(documented), ...compareCapabilityTruths(documented, source)];
  if (failures.length > 0) {
    console.error(`Documentation semantic guard failed (${failures.length}):`);
    for (const failure of failures) console.error(`- ${failure}`);
    console.error("Update docs/CAPABILITY_TRUTHS.json and the affected user documentation only after reviewing the corresponding source change.");
    process.exitCode = 1;
  } else {
    console.log(
      `Documentation semantic truths are current (${source.scannerModes.length} scanner modes, ${source.registeredPublicVenues.length} public venues, ${source.continuousPublicVenues.length} continuous venues, ${source.generatedEndpoints.http} HTTP/${source.generatedEndpoints.websocket} WebSocket endpoints).`
    );
  }
} catch (error) {
  console.error(`Documentation semantic guard could not evaluate its bounded contract: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

function sourceInvariantFailures(): string[] {
  const failures: string[] = [];
  for (const [key, adapter] of publicVenueAdapters) {
    if (adapter.venue !== key) failures.push(`public adapter map key '${key}' does not match adapter venue '${adapter.venue}'`);
    const capabilities = adapter.capabilities();
    if (!capabilities.publicData) failures.push(`registered public adapter '${key}' does not declare publicData=true`);
    if (capabilities.privateExecution) failures.push(`registered public adapter '${key}' declares privateExecution=true; the shared facade must remain credential-free/read-only`);
  }
  for (const venue of CONTINUOUS_PUBLIC_VENUES) {
    if (!publicVenueAdapters.has(venue)) failures.push(`continuous venue '${venue}' is absent from the shared public adapter registry`);
    try {
      const protocol = createContinuousVenueProtocol(protocolProbe(venue));
      if (protocol.instrument.venue !== venue) failures.push(`continuous protocol '${venue}' returned an instrument for '${protocol.instrument.venue}'`);
    } catch (error) {
      failures.push(`continuous venue '${venue}' has no constructible protocol-factory branch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

function canonicalDocumentationFailures(documented: ReturnType<typeof parseCapabilityTruthContract>): string[] {
  const failures: string[] = [];
  const capabilities = readFileSync(path.join(root, "docs/VENUE_CAPABILITIES.md"), "utf8");
  const screener = readFileSync(path.join(root, "docs/ARBITRAGE_SCREENER.md"), "utf8");
  const publicNames = joinEnglish(documented.registeredPublicVenues.map((venue) => documented.venueDisplayNames[venue]));
  const continuousNames = joinEnglish(documented.continuousPublicVenues.map((venue) => documented.venueDisplayNames[venue]));
  const publicRow = `| Shared public REST facade | ${publicNames} through \`/api/market-data/:venue/*\` |`;
  const continuousRow = `| Generic continuous module | ${continuousNames} only; it is operator-allowlisted and browser read-only |`;
  if (!capabilities.includes(publicRow)) failures.push("docs/VENUE_CAPABILITIES.md must contain the canonical source-backed Shared public REST facade row");
  if (!capabilities.includes(continuousRow)) failures.push("docs/VENUE_CAPABILITIES.md must contain the canonical source-backed Generic continuous module row");

  const modes = documented.scannerModes.map((mode) => `**${mode.name}** (\`${mode.id}\`)`);
  const modeSentence = `The mode selector exposes ${modes.length} source-backed modes: ${joinEnglish(modes)}.`;
  if (!compactWhitespace(screener).includes(compactWhitespace(modeSentence))) failures.push("docs/ARBITRAGE_SCREENER.md must contain the canonical source-backed scanner-mode sentence");
  return failures;
}

function protocolProbe(venue: ContinuousPublicVenue) {
  const probe = {
    okx: { venueSymbol: "BTC-USDT-SWAP", marketType: "perpetual", quantityUnit: "contract" },
    gate: { venueSymbol: "BTC_USDT", marketType: "perpetual", quantityUnit: "contract" },
    hyperliquid: { venueSymbol: "BTC", marketType: "perpetual", quantityUnit: "base" },
    deribit: { venueSymbol: "BTC-PERPETUAL", marketType: "perpetual", quantityUnit: "quote" },
    kraken: { venueSymbol: "BTC/USD", marketType: "spot", quantityUnit: "base" },
    coinbase: { venueSymbol: "BTC-USD", marketType: "spot", quantityUnit: "base" },
    dydx: { venueSymbol: "BTC-USD", marketType: "perpetual", quantityUnit: "base" },
    kucoin: { venueSymbol: "BTC-USDT", marketType: "spot", quantityUnit: "base" },
    mexc: { venueSymbol: "BTCUSDT", marketType: "spot", quantityUnit: "base" }
  } as const;
  return { venue, instrumentId: `docs-semantic:${venue}`, ...probe[venue] };
}

function joinEnglish(values: readonly string[]): string {
  if (values.length === 1) return values[0]!;
  return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
