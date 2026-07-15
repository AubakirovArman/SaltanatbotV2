const ROOT_KEYS = ["schemaVersion", "scannerModes", "registeredPublicVenues", "continuousPublicVenues", "venueDisplayNames", "generatedEndpoints"];

/**
 * Validate the deliberately small capability-truth contract. This is not a general Markdown or
 * TypeScript parser: application modules provide runtime facts and one JSON document records them.
 */
export function parseCapabilityTruthContract(value) {
  requirePlainObject(value, "capability truth contract");
  requireExactKeys(value, ROOT_KEYS, "capability truth contract");
  if (value.schemaVersion !== 1) throw new Error("capability truth contract: schemaVersion must be 1");

  const scannerModes = requireArray(value.scannerModes, "scannerModes").map((mode, index) => {
    requirePlainObject(mode, `scannerModes[${index}]`);
    requireExactKeys(mode, ["id", "name"], `scannerModes[${index}]`);
    return {
      id: requireNonEmptyString(mode.id, `scannerModes[${index}].id`),
      name: requireNonEmptyString(mode.name, `scannerModes[${index}].name`)
    };
  });
  requireUnique(scannerModes.map((mode) => mode.id), "scanner mode ids");
  requireUnique(scannerModes.map((mode) => mode.name), "scanner mode names");

  const registeredPublicVenues = stringList(value.registeredPublicVenues, "registeredPublicVenues");
  const continuousPublicVenues = stringList(value.continuousPublicVenues, "continuousPublicVenues");
  for (const venue of continuousPublicVenues) {
    if (!registeredPublicVenues.includes(venue)) throw new Error(`continuousPublicVenues contains '${venue}', which is absent from registeredPublicVenues`);
  }
  requirePlainObject(value.venueDisplayNames, "venueDisplayNames");
  requireExactKeys(value.venueDisplayNames, registeredPublicVenues, "venueDisplayNames");
  const venueDisplayNames = Object.fromEntries(registeredPublicVenues.map((venue) => [venue, requireNonEmptyString(value.venueDisplayNames[venue], `venueDisplayNames.${venue}`)]));
  requireUnique(Object.values(venueDisplayNames), "venue display names");
  requirePlainObject(value.generatedEndpoints, "generatedEndpoints");
  requireExactKeys(value.generatedEndpoints, ["http", "websocket"], "generatedEndpoints");
  const generatedEndpoints = {
    http: requirePositiveInteger(value.generatedEndpoints.http, "generatedEndpoints.http"),
    websocket: requirePositiveInteger(value.generatedEndpoints.websocket, "generatedEndpoints.websocket")
  };

  return { schemaVersion: 1, scannerModes, registeredPublicVenues, continuousPublicVenues, venueDisplayNames, generatedEndpoints };
}

export function compareCapabilityTruths(documentedValue, sourceValue) {
  const documented = parseCapabilityTruthContract(documentedValue);
  const source = parseCapabilityTruthContract(sourceValue);
  const failures = [];

  compareList(
    failures,
    "scannerModes",
    documented.scannerModes.map((mode) => `${mode.id}:${mode.name}`),
    source.scannerModes.map((mode) => `${mode.id}:${mode.name}`)
  );
  compareList(failures, "registeredPublicVenues", documented.registeredPublicVenues, source.registeredPublicVenues);
  compareList(failures, "continuousPublicVenues", documented.continuousPublicVenues, source.continuousPublicVenues);
  if (documented.generatedEndpoints.http !== source.generatedEndpoints.http) failures.push(`generatedEndpoints.http: documented ${documented.generatedEndpoints.http}; source-backed generated index ${source.generatedEndpoints.http}`);
  if (documented.generatedEndpoints.websocket !== source.generatedEndpoints.websocket) failures.push(`generatedEndpoints.websocket: documented ${documented.generatedEndpoints.websocket}; source-backed generated index ${source.generatedEndpoints.websocket}`);
  return failures;
}

export function parseGeneratedEndpointTotals(markdown) {
  if (typeof markdown !== "string") throw new Error("generated endpoint index must be text");
  const matches = [...markdown.matchAll(/^Generated totals: \*\*(\d+) HTTP endpoints\*\* and \*\*(\d+) WebSocket endpoints\*\*\.$/gm)];
  if (matches.length !== 1) throw new Error(`generated endpoint index must contain exactly one totals marker; found ${matches.length}`);
  return {
    http: requirePositiveInteger(Number(matches[0][1]), "generated endpoint HTTP total"),
    websocket: requirePositiveInteger(Number(matches[0][2]), "generated endpoint WebSocket total")
  };
}

function compareList(failures, label, documented, source) {
  if (documented.length === source.length && documented.every((value, index) => value === source[index])) return;
  failures.push(`${label}: documented [${documented.join(", ")}]; source [${source.join(", ")}]`);
}

function stringList(value, label) {
  const list = requireArray(value, label).map((item, index) => requireNonEmptyString(item, `${label}[${index}]`));
  requireUnique(list, label);
  return list;
}

function requireArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
  return value;
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label} keys must be exactly: ${wanted.join(", ")}`);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) throw new Error(`${label} must be a non-empty trimmed string`);
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function requireUnique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`);
}
