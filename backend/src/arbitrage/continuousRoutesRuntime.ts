import type { RequestHandler } from "express";
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { reviewedEconomicAssetIdentity, reviewedEconomicAssetIdentityForInstrumentId, type ReviewedEconomicAssetIdentity } from "../market/economicAssetIdentity.js";
import type { InstrumentRegistrySnapshot } from "../market/instrumentRegistry.js";
import type { ContinuousDiscoveryInstrument, ContinuousDiscoveryRuntimeCoverage, ContinuousRouteDiscoverySnapshot } from "./upstream/publicFeeds/index.js";

const MAX_CONFIGURATION_BYTES = 64 * 1024;
const MAX_INSTRUMENTS = 24;
const MAX_IDENTITY_VALIDITY_MS = 90 * 24 * 60 * 60_000;

const configurationSchema = z
  .array(
    z
      .object({
        instrumentId: z
          .string()
          .trim()
          .min(3)
          .max(200)
          .regex(/^[A-Za-z0-9][A-Za-z0-9:._/@-]*$/),
        economicAssetId: z
          .string()
          .trim()
          .min(3)
          .max(160)
          .regex(/^[a-z][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/),
        takerFeeBps: z.number().finite().min(0).max(1_000),
        economicIdentity: z
          .object({
            status: z.literal("reviewed"),
            source: z.string().trim().min(1).max(300),
            version: z.string().trim().min(1).max(100),
            asOf: z.number().int().positive(),
            validUntil: z.number().int().positive()
          })
          .strict()
      })
      .strict()
  )
  .max(MAX_INSTRUMENTS);

export type ContinuousRouteConfiguration = z.infer<typeof configurationSchema>;

export interface ContinuousRouteConfigurationInput {
  json?: string;
  file?: string;
}

interface RegistrySurface {
  snapshot(force?: boolean): Promise<InstrumentRegistrySnapshot>;
}

interface DiscoverySurface {
  configure(values: readonly ContinuousDiscoveryInstrument[]): void;
  setRuntimeCoverage(value: ContinuousDiscoveryRuntimeCoverage): void;
  snapshot(): ContinuousRouteDiscoverySnapshot;
  close(): void;
}

export interface ContinuousRouteRuntimeOptions {
  configuration: ContinuousRouteConfiguration;
  registry: RegistrySurface;
  discovery: DiscoverySurface;
  now?: () => number;
  refreshIntervalMs?: number;
  configurationError?: string;
}

export interface ContinuousRouteRuntimeSnapshot {
  schemaVersion: 1;
  engine: "continuous-route-runtime-v1";
  readOnly: true;
  executionStatus: "research-only";
  executable: false;
  configurationSource: "operator-environment";
  state: "disabled" | "starting" | "live" | "degraded" | "error";
  evaluatedAt: number;
  refreshedAt?: number;
  configuredInstrumentIds: string[];
  activeInstrumentIds: string[];
  unavailable: Array<{ instrumentId: string; reason: string }>;
  message?: string;
  coverage: ContinuousDiscoveryRuntimeCoverage;
  discovery: ContinuousRouteDiscoverySnapshot;
}

/**
 * Operator-configured bridge from the fresh registry into continuous public feeds.
 * Browser requests can observe but never add subscriptions, fees or identity authority.
 */
export class ContinuousRouteDiscoveryRuntime {
  private readonly now: () => number;
  private readonly refreshIntervalMs: number;
  private readonly configuration: ContinuousRouteConfiguration;
  private state: ContinuousRouteRuntimeSnapshot["state"];
  private refreshedAt?: number;
  private activeInstrumentIds: string[] = [];
  private unavailable: ContinuousRouteRuntimeSnapshot["unavailable"] = [];
  private message?: string;
  private coverage: ContinuousDiscoveryRuntimeCoverage;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;

  constructor(private readonly options: ContinuousRouteRuntimeOptions) {
    this.now = options.now ?? Date.now;
    this.refreshIntervalMs = boundedInteger(options.refreshIntervalMs ?? 15 * 60_000, 10_000, 24 * 60 * 60_000, "refreshIntervalMs");
    this.configuration = structuredClone(options.configuration);
    this.state = options.configurationError ? "error" : this.configuration.length === 0 ? "disabled" : "starting";
    this.message = options.configurationError ?? (this.configuration.length === 0 ? "No operator continuous-route allowlist is configured" : undefined);
    this.coverage = options.configurationError
      ? { complete: false, current: false, retainedPriorDiscovery: false, reason: "configuration-invalid" }
      : this.configuration.length === 0
        ? { complete: false, current: false, retainedPriorDiscovery: false, reason: "configuration-disabled" }
        : { complete: false, current: false, retainedPriorDiscovery: false, reason: "refresh-pending" };
    this.options.discovery.setRuntimeCoverage(this.coverage);
  }

  start() {
    if (this.timer || this.configuration.length === 0 || this.options.configurationError) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(true), this.refreshIntervalMs);
    this.timer.unref?.();
  }

  async ready() {
    if (this.state === "starting") await this.refresh();
  }

  async refresh(forceRegistry = false): Promise<void> {
    if (this.configuration.length === 0 || this.options.configurationError) return;
    this.inFlight ??= this.refreshOnce(forceRegistry).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  snapshot(): ContinuousRouteRuntimeSnapshot {
    return {
      schemaVersion: 1,
      engine: "continuous-route-runtime-v1",
      readOnly: true,
      executionStatus: "research-only",
      executable: false,
      configurationSource: "operator-environment",
      state: this.state,
      evaluatedAt: this.now(),
      ...(this.refreshedAt === undefined ? {} : { refreshedAt: this.refreshedAt }),
      configuredInstrumentIds: this.configuration.map(({ instrumentId }) => instrumentId),
      activeInstrumentIds: [...this.activeInstrumentIds],
      unavailable: this.unavailable.map((value) => ({ ...value })),
      ...(this.message ? { message: this.message } : {}),
      coverage: { ...this.coverage },
      discovery: this.options.discovery.snapshot()
    };
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.options.discovery.close();
  }

  private async refreshOnce(forceRegistry: boolean) {
    let discoveryReplacementStarted = false;
    try {
      const evaluatedAt = this.now();
      const registry = await this.options.registry.snapshot(forceRegistry);
      const byId = new Map(registry.verifiedInstruments.map((instrument) => [instrument.id, instrument]));
      const values: ContinuousDiscoveryInstrument[] = [];
      const unavailable: ContinuousRouteRuntimeSnapshot["unavailable"] = [];
      for (const configured of this.configuration) {
        const validityProblem = identityValidityProblem(configured, evaluatedAt);
        if (validityProblem) {
          unavailable.push({ instrumentId: configured.instrumentId, reason: validityProblem });
          continue;
        }
        const instrument = byId.get(configured.instrumentId);
        if (!instrument) {
          unavailable.push({ instrumentId: configured.instrumentId, reason: "Instrument is absent from the current verified registry snapshot" });
          continue;
        }
        const reviewedIdentity = reviewedEconomicAssetIdentity(instrument);
        if (!reviewedIdentity) {
          unavailable.push({ instrumentId: configured.instrumentId, reason: "Instrument is absent from the central reviewed economic-identity catalog" });
          continue;
        }
        const identityProblem = reviewedIdentityProblem(configured, reviewedIdentity);
        if (identityProblem) {
          unavailable.push({ instrumentId: configured.instrumentId, reason: identityProblem });
          continue;
        }
        values.push({
          instrument: { ...instrument, economicAssetId: reviewedIdentity.economicAssetId },
          overlay: { takerFeeBps: configured.takerFeeBps, economicIdentity: { ...reviewedIdentity.evidence } }
        });
      }
      this.options.discovery.setRuntimeCoverage({
        complete: false,
        current: false,
        retainedPriorDiscovery: this.refreshedAt !== undefined,
        reason: "refresh-pending"
      });
      discoveryReplacementStarted = true;
      this.options.discovery.configure(values);
      const discovery = this.options.discovery.snapshot();
      const rejectedIds = new Set(discovery.rejectedInstruments.map(({ instrumentId }) => instrumentId).filter((value): value is string => Boolean(value)));
      for (const instrumentId of rejectedIds) unavailable.push({ instrumentId, reason: "Instrument failed route-family metadata/identity validation" });
      const unavailableIds = new Set(unavailable.map(({ instrumentId }) => instrumentId));
      this.activeInstrumentIds = values.map(({ instrument }) => instrument.id).filter((instrumentId) => !unavailableIds.has(instrumentId));
      this.unavailable = dedupeUnavailable(unavailable);
      this.refreshedAt = this.now();
      this.state = this.unavailable.length > 0 ? "degraded" : "live";
      this.message = this.unavailable.length > 0 ? `${this.unavailable.length} configured instrument(s) failed closed` : undefined;
      this.setCoverage(this.unavailable.length > 0 ? { complete: false, current: true, retainedPriorDiscovery: false, reason: "partial-instruments" } : { complete: true, current: true, retainedPriorDiscovery: false, reason: "complete" });
    } catch (error) {
      const retainedPriorDiscovery = !discoveryReplacementStarted && this.refreshedAt !== undefined;
      if (!retainedPriorDiscovery) this.activeInstrumentIds = [];
      this.unavailable = this.configuration.map(({ instrumentId }) => ({ instrumentId, reason: "Continuous discovery refresh failed closed" }));
      this.state = "error";
      this.message = error instanceof Error ? error.message : "Continuous discovery refresh failed";
      this.setCoverage({ complete: false, current: false, retainedPriorDiscovery, reason: "refresh-failed" });
    }
  }

  private setCoverage(value: ContinuousDiscoveryRuntimeCoverage) {
    this.coverage = { ...value };
    this.options.discovery.setRuntimeCoverage(value);
  }
}

export function parseContinuousRouteConfiguration(raw: string | undefined, now = Date.now()): ContinuousRouteConfiguration {
  return parseContinuousRouteConfigurationText(raw, now, "ARBITRAGE_CONTINUOUS_ROUTES_JSON");
}

/**
 * Loads the operator allowlist from exactly one bounded source. The file path is
 * process configuration, never an HTTP input, and the contents remain subject
 * to the same strict schema and central identity checks as inline JSON.
 */
export function loadContinuousRouteConfiguration(input: ContinuousRouteConfigurationInput, now = Date.now()): ContinuousRouteConfiguration {
  const rawJson = input.json?.trim() ? input.json : undefined;
  const filePath = input.file?.trim() ? input.file.trim() : undefined;
  if (rawJson !== undefined && filePath !== undefined) {
    throw new Error("Set only one of ARBITRAGE_CONTINUOUS_ROUTES_JSON or ARBITRAGE_CONTINUOUS_ROUTES_FILE");
  }
  if (filePath === undefined) return parseContinuousRouteConfiguration(rawJson, now);
  if (filePath.length > 4_096 || filePath.includes("\0")) throw new Error("ARBITRAGE_CONTINUOUS_ROUTES_FILE path is invalid");
  if (!path.isAbsolute(filePath)) throw new Error("ARBITRAGE_CONTINUOUS_ROUTES_FILE must be an absolute path");

  let descriptor: number | undefined;
  try {
    descriptor = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error("ARBITRAGE_CONTINUOUS_ROUTES_FILE must reference a regular file");
    if (metadata.size > MAX_CONFIGURATION_BYTES) throw new Error(`ARBITRAGE_CONTINUOUS_ROUTES_FILE exceeds ${MAX_CONFIGURATION_BYTES} bytes`);

    const bytes = Buffer.allocUnsafe(MAX_CONFIGURATION_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const count = readSync(descriptor, bytes, total, bytes.length - total, null);
      if (count === 0) break;
      total += count;
    }
    if (total > MAX_CONFIGURATION_BYTES) throw new Error(`ARBITRAGE_CONTINUOUS_ROUTES_FILE exceeds ${MAX_CONFIGURATION_BYTES} bytes`);

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total));
    } catch {
      throw new Error("ARBITRAGE_CONTINUOUS_ROUTES_FILE must contain valid UTF-8");
    }
    return parseContinuousRouteConfigurationText(text, now, "ARBITRAGE_CONTINUOUS_ROUTES_FILE contents");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("ARBITRAGE_CONTINUOUS_ROUTES_")) throw error;
    throw new Error("ARBITRAGE_CONTINUOUS_ROUTES_FILE could not be read");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseContinuousRouteConfigurationText(raw: string | undefined, now: number, sourceLabel: string): ContinuousRouteConfiguration {
  if (!raw?.trim()) return [];
  if (Buffer.byteLength(raw, "utf8") > MAX_CONFIGURATION_BYTES) throw new Error(`${sourceLabel} exceeds ${MAX_CONFIGURATION_BYTES} bytes`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${sourceLabel} must be valid JSON`);
  }
  const parsed = configurationSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${sourceLabel} is invalid: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
  if (new Set(parsed.data.map(({ instrumentId }) => instrumentId)).size !== parsed.data.length) throw new Error(`${sourceLabel} contains duplicate instrumentId values`);
  for (const row of parsed.data) {
    const problem = identityValidityProblem(row, now);
    if (problem) throw new Error(`${row.instrumentId}: ${problem}`);
    const catalogProblem = reviewedIdentityProblem(row, reviewedEconomicAssetIdentityForInstrumentId(row.instrumentId));
    if (catalogProblem) throw new Error(`${row.instrumentId}: ${catalogProblem}`);
  }
  return parsed.data;
}

export function createContinuousRouteRuntimeHandler(runtime: Pick<ContinuousRouteDiscoveryRuntime, "ready" | "snapshot">): RequestHandler {
  return async (_request, response) => {
    await runtime.ready();
    response.setHeader("Cache-Control", "no-store");
    response.json(runtime.snapshot());
  };
}

function identityValidityProblem(row: ContinuousRouteConfiguration[number], now: number) {
  if (row.economicIdentity.asOf > now + 60_000) return "Economic identity review is in the future";
  if (row.economicIdentity.validUntil < now) return "Economic identity review is expired";
  if (row.economicIdentity.validUntil <= row.economicIdentity.asOf) return "Economic identity validUntil must follow asOf";
  if (row.economicIdentity.validUntil - row.economicIdentity.asOf > MAX_IDENTITY_VALIDITY_MS) return "Economic identity validity exceeds 90 days";
  return undefined;
}

function reviewedIdentityProblem(row: ContinuousRouteConfiguration[number], reviewed: ReviewedEconomicAssetIdentity | undefined) {
  if (!reviewed) return "Instrument is absent from the central reviewed economic-identity catalog";
  if (row.economicAssetId !== reviewed.economicAssetId) return "Configured economicAssetId does not match the central reviewed catalog";
  const configured = row.economicIdentity;
  const evidence = reviewed.evidence;
  if (configured.status !== evidence.status || configured.source !== evidence.source || configured.version !== evidence.version || configured.asOf !== evidence.asOf || configured.validUntil !== evidence.validUntil) {
    return "Configured economic-identity evidence does not match the central reviewed catalog";
  }
  return undefined;
}

function dedupeUnavailable(values: ContinuousRouteRuntimeSnapshot["unavailable"]) {
  return [...new Map(values.sort((left, right) => left.instrumentId.localeCompare(right.instrumentId) || left.reason.localeCompare(right.reason)).map((value) => [`${value.instrumentId}\u001f${value.reason}`, value])).values()];
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  return value;
}
