import type { VenueMarketType } from "@saltanatbotv2/contracts";
import type { PublicVenueAdapter } from "../publicTypes.js";
import { validatePublicVenueAdapterPlugin } from "./descriptor.js";
import { validatePublicOperationResult } from "./invariants.js";
import {
  PUBLIC_VENUE_ADAPTER_AUTHORITY,
  type PublicVenueAdapterPluginDescriptor,
  type PublicVenueCertificationCaseResult,
  type PublicVenueCertificationFixture,
  type PublicVenueCertificationHarness,
  type PublicVenueCertificationReport,
  type PublicVenueCertificationScenario,
  type PublicVenueFailureKind,
  type PublicVenueOperation,
  PublicVenuePluginError
} from "./types.js";

const FAILURE_SCENARIOS = ["timeout", "rate-limit", "http"] as const satisfies readonly PublicVenueFailureKind[];
const MAX_FIXTURES = 24;
const MAX_REPORT_CASES = 128;
const MAX_REPORT_ISSUES = 64;
const MAX_FIXTURE_LIMIT = 10_000;
const SECRET_PATTERN = /api[-_ ]?key|authorization|passphrase|private[-_ ]?key|secret|signature/i;

export async function certifyPublicVenueAdapterPlugin(descriptor: PublicVenueAdapterPluginDescriptor, harness: PublicVenueCertificationHarness): Promise<PublicVenueCertificationReport> {
  const generatedAt = harness.now?.() ?? Date.now();
  if (!Number.isSafeInteger(generatedAt) || generatedAt <= 0) throw new PublicVenuePluginError("certification clock must be a positive safe-integer timestamp");
  validatePublicVenueAdapterPlugin(descriptor, {
    now: generatedAt,
    maxOfficialDocsAgeDays: harness.maxOfficialDocsAgeDays
  });
  if (harness.fixtures.length > MAX_FIXTURES) throw new PublicVenuePluginError(`certification fixtures exceed ${MAX_FIXTURES}`);

  const operationLimits = new Map(descriptor.operations.map((item) => [item.operation, item.maxItems]));
  const advertisedScopes = descriptor.operations.flatMap((item) => item.marketTypes.map((marketType) => ({ operation: item.operation, marketType })));
  const expectedCases = advertisedScopes.length * (2 + FAILURE_SCENARIOS.length);
  if (expectedCases > MAX_REPORT_CASES) throw new PublicVenuePluginError(`certification report would exceed ${MAX_REPORT_CASES} cases`);

  const issues: string[] = [];
  const fixtures = indexFixtures(harness.fixtures, advertisedScopes, issues);
  const results: PublicVenueCertificationCaseResult[] = [];
  for (const scope of advertisedScopes) {
    const key = scopeKey(scope.operation, scope.marketType);
    const fixture = fixtures.get(key);
    const maxItems = operationLimits.get(scope.operation)!;
    if (!fixture) {
      for (const scenario of ["happy", "cancelled", ...FAILURE_SCENARIOS] as const) {
        results.push(caseResult(scope, scenario, false, "advertised operation has no certification fixture"));
      }
      continue;
    }
    const fixtureIssue = validateFixture(fixture, maxItems);
    if (fixtureIssue) {
      for (const scenario of ["happy", "cancelled", ...FAILURE_SCENARIOS] as const) {
        results.push(caseResult(scope, scenario, false, fixtureIssue));
      }
      continue;
    }

    results.push(await runHappy(descriptor, harness, fixture, maxItems));
    results.push(await runCancellation(descriptor, harness, fixture));
    for (const kind of FAILURE_SCENARIOS) results.push(await runFailure(descriptor, harness, fixture, kind));
  }

  const boundedIssues = issues.length > MAX_REPORT_ISSUES ? [...issues.slice(0, MAX_REPORT_ISSUES - 1), `additional preflight issues omitted: ${issues.length - MAX_REPORT_ISSUES + 1}`] : issues;
  const passedCases = results.filter((item) => item.passed).length;
  const failedCases = results.length - passedCases;
  return deepFreeze({
    reportVersion: "public-venue-certification/v1",
    pluginId: descriptor.pluginId,
    venue: descriptor.venue,
    adapterVersion: descriptor.adapterVersion,
    contractVersion: descriptor.contractVersion,
    authority: PUBLIC_VENUE_ADAPTER_AUTHORITY,
    generatedAt,
    passed: failedCases === 0 && boundedIssues.length === 0 && results.length === expectedCases,
    summary: {
      advertisedScopes: advertisedScopes.length,
      expectedCases,
      completedCases: results.length,
      passedCases,
      failedCases
    },
    issues: boundedIssues,
    cases: results
  } satisfies PublicVenueCertificationReport);
}

async function runHappy(descriptor: PublicVenueAdapterPluginDescriptor, harness: PublicVenueCertificationHarness, fixture: PublicVenueCertificationFixture, maxItems: number) {
  try {
    const adapter = checkedHarnessAdapter(descriptor, harness.createAdapter());
    const result = await invoke(adapter, fixture);
    validatePublicOperationResult(fixture.operation, result, {
      venue: descriptor.venue,
      marketType: fixture.marketType,
      instrumentId: fixture.instrumentId,
      maxItems
    });
    return caseResult(fixture, "happy", true);
  } catch (error) {
    return caseResult(fixture, "happy", false, boundedError(error));
  }
}

async function runCancellation(descriptor: PublicVenueAdapterPluginDescriptor, harness: PublicVenueCertificationHarness, fixture: PublicVenueCertificationFixture) {
  const controller = new AbortController();
  controller.abort("certification cancellation");
  try {
    const adapter = checkedHarnessAdapter(descriptor, harness.createAdapter());
    await invoke(adapter, fixture, controller.signal);
    return caseResult(fixture, "cancelled", false, "operation resolved after caller cancellation");
  } catch (error) {
    return expectedFailure(descriptor, fixture, "cancelled", error);
  }
}

async function runFailure(descriptor: PublicVenueAdapterPluginDescriptor, harness: PublicVenueCertificationHarness, fixture: PublicVenueCertificationFixture, kind: PublicVenueFailureKind) {
  try {
    const adapter = checkedHarnessAdapter(descriptor, harness.createAdapter({ operation: fixture.operation, marketType: fixture.marketType, kind }));
    await invoke(adapter, fixture);
    return caseResult(fixture, kind, false, `operation resolved during injected ${kind} failure`);
  } catch (error) {
    return expectedFailure(descriptor, fixture, kind, error);
  }
}

function expectedFailure(descriptor: PublicVenueAdapterPluginDescriptor, fixture: PublicVenueCertificationFixture, scenario: "cancelled" | PublicVenueFailureKind, error: unknown) {
  const record = error && typeof error === "object" ? (error as { venue?: unknown; kind?: unknown; message?: unknown }) : undefined;
  if (!record || record.venue !== descriptor.venue || record.kind !== scenario || typeof record.message !== "string") {
    return caseResult(fixture, scenario, false, `expected ${descriptor.venue}/${scenario} structured error`);
  }
  if (record.message.length === 0 || record.message.length > 500) return caseResult(fixture, scenario, false, "structured error message is empty or unbounded");
  if (SECRET_PATTERN.test(record.message)) return caseResult(fixture, scenario, false, "structured error message contains credential-like text");
  return caseResult(fixture, scenario, true);
}

async function invoke(adapter: PublicVenueAdapter, fixture: PublicVenueCertificationFixture, signal?: AbortSignal): Promise<unknown> {
  if (fixture.operation === "instruments") return adapter.instruments(fixture.marketType, signal);
  if (fixture.operation === "tickers") return adapter.tickers(fixture.marketType, signal);
  if (fixture.operation === "ticker") return adapter.ticker(fixture.instrumentId!, fixture.marketType, signal);
  if (fixture.operation === "depth") {
    return adapter.depth({ instrumentId: fixture.instrumentId!, marketType: fixture.marketType, limit: fixture.depthLimit }, signal);
  }
  return adapter.funding(fixture.instrumentId!, { historyLimit: fixture.historyLimit, signal });
}

function checkedHarnessAdapter(descriptor: PublicVenueAdapterPluginDescriptor, adapter: PublicVenueAdapter) {
  if (!adapter || adapter.venue !== descriptor.venue) throw new PublicVenuePluginError("harness adapter venue does not match descriptor");
  if (canonicalJson(adapter.capabilities()) !== canonicalJson(descriptor.capabilities)) {
    throw new PublicVenuePluginError("harness adapter capabilities do not match descriptor");
  }
  return adapter;
}

function indexFixtures(values: readonly PublicVenueCertificationFixture[], advertised: readonly { operation: PublicVenueOperation; marketType: VenueMarketType }[], issues: string[]) {
  const advertisedKeys = new Set(advertised.map((item) => scopeKey(item.operation, item.marketType)));
  const fixtures = new Map<string, PublicVenueCertificationFixture>();
  for (const fixture of values) {
    const key = scopeKey(fixture.operation, fixture.marketType);
    if (!advertisedKeys.has(key)) issues.push(`fixture ${key} is not advertised`);
    else if (fixtures.has(key)) issues.push(`duplicate fixture ${key}`);
    else fixtures.set(key, fixture);
  }
  return fixtures;
}

function validateFixture(fixture: PublicVenueCertificationFixture, maximum: number) {
  if ((fixture.operation === "ticker" || fixture.operation === "depth" || fixture.operation === "funding") && !validInstrumentId(fixture.instrumentId)) {
    return `${fixture.operation} fixture requires a bounded instrumentId`;
  }
  if (fixture.depthLimit !== undefined && (!Number.isSafeInteger(fixture.depthLimit) || fixture.depthLimit < 1 || fixture.depthLimit > Math.min(maximum, MAX_FIXTURE_LIMIT))) {
    return `depthLimit must be within the advertised maxItems bound ${maximum}`;
  }
  if (fixture.historyLimit !== undefined && (!Number.isSafeInteger(fixture.historyLimit) || fixture.historyLimit < 1 || fixture.historyLimit > Math.min(maximum, MAX_FIXTURE_LIMIT))) {
    return `historyLimit must be within the advertised maxItems bound ${maximum}`;
  }
  return undefined;
}

function validInstrumentId(value: string | undefined) {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && /^[A-Za-z0-9@][A-Za-z0-9@._:/-]*$/.test(value);
}

function caseResult(scope: { operation: PublicVenueOperation; marketType: VenueMarketType }, scenario: PublicVenueCertificationScenario, passed: boolean, issue?: string): PublicVenueCertificationCaseResult {
  return {
    id: `${scope.operation}/${scope.marketType}/${scenario}`,
    operation: scope.operation,
    marketType: scope.marketType,
    scenario,
    passed,
    ...(issue ? { issue: issue.slice(0, 500) } : {})
  };
}

function boundedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  return SECRET_PATTERN.test(message) ? "operation exposed credential-like error text" : message.slice(0, 500);
}

function scopeKey(operation: PublicVenueOperation, marketType: VenueMarketType) {
  return `${operation}/${marketType}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
