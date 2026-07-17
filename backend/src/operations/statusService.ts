import { statfs } from "node:fs/promises";
import type { Pool } from "pg";
import type { RuntimeConfig } from "../config/runtimeConfig.js";
import { DATABASE_MIGRATIONS, LATEST_DATABASE_SCHEMA_VERSION } from "../database/schema.js";
import type { GlobalAdmissionController, GlobalAdmissionSnapshot } from "../http/globalAdmission.js";
import type { ReadinessRateLimitSnapshot } from "../http/readinessRateLimit.js";
import type { ApiMetrics, ApiMetricsSnapshot } from "./apiMetrics.js";
import { RuntimeComponentHeartbeatRepository } from "./componentHeartbeat.js";
import { readRecoveryStatusReceipt, type RecoveryStatusReceipt } from "./recoveryStatus.js";

export type OperationalReadinessState = "ready" | "degraded" | "unready";

export interface OperationalReadiness {
  readonly ok: boolean;
  readonly status: OperationalReadinessState;
  readonly version: 1;
  readonly ts: number;
  readonly components: {
    readonly migrations: {
      readonly status: "ready" | "unready" | "legacy";
      readonly expectedVersion: number;
      readonly actualVersion?: number;
      readonly checksumMatches?: boolean;
    };
    readonly postgres: {
      readonly status: "ready" | "unready" | "legacy";
      readonly probeLatencyMs?: number;
    };
    readonly executor: {
      readonly status: "ready" | "unready";
      readonly mode: "paper-only";
    };
    readonly researchWorker: {
      readonly status: "ready" | "unready" | "legacy";
      readonly heartbeatAgeMs?: number;
      readonly componentState?: string;
    };
    readonly filesystem: {
      readonly status: "ready" | "degraded" | "unready";
      readonly freeBytes?: number;
      readonly freePercent?: number;
    };
    readonly admission: {
      readonly status: "ready" | "degraded" | "unready";
      readonly active: number;
      readonly queued: number;
      readonly saturation: number;
    };
  };
}

export interface PublicOperationalReadiness {
  readonly ok: boolean;
  readonly status: OperationalReadinessState;
  readonly version: 1;
  readonly ts: number;
  readonly components: {
    readonly migrations: {
      readonly status: OperationalReadiness["components"]["migrations"]["status"];
    };
    readonly postgres: {
      readonly status: OperationalReadiness["components"]["postgres"]["status"];
    };
    readonly executor: {
      readonly status: OperationalReadiness["components"]["executor"]["status"];
    };
    readonly researchWorker: {
      readonly status: OperationalReadiness["components"]["researchWorker"]["status"];
    };
    readonly filesystem: {
      readonly status: OperationalReadiness["components"]["filesystem"]["status"];
    };
    readonly admission: {
      readonly status: OperationalReadiness["components"]["admission"]["status"];
    };
  };
}

export interface OperationalMetrics {
  readonly version: 1;
  readonly ts: number;
  readonly readiness: OperationalReadiness;
  readonly api: ApiMetricsSnapshot;
  readonly postgres: {
    readonly totalCount: number;
    readonly idleCount: number;
    readonly waitingCount: number;
  };
  readonly admission: GlobalAdmissionSnapshot;
  readonly readinessRateLimit: ReadinessRateLimitSnapshot;
  readonly researchWorker?: {
    readonly status: string;
    readonly heartbeatAgeMs: number;
    readonly databaseSchemaVersion: number;
    readonly releaseCommit?: string;
  };
  readonly recovery: {
    readonly lastVerifiedGeneration: RecoveryStatusReceipt | null;
  };
}

export interface OperationalStatusDependencies {
  readonly runtimeConfig: RuntimeConfig;
  readonly pool?: Pool;
  readonly admission: GlobalAdmissionController;
  readonly apiMetrics: ApiMetrics;
  readonly readinessRateLimit?: {
    snapshot(): ReadinessRateLimitSnapshot;
  };
  readonly executorReady: () => boolean;
  readonly now?: () => number;
  readonly readDisk?: (path: string) => Promise<{ freeBytes: number; totalBytes: number }>;
  readonly readRecoveryStatus?: (path: string) => RecoveryStatusReceipt | null;
}

interface MigrationRow {
  version: number;
  checksum: string;
}

interface ReadinessCacheEntry {
  readonly value: OperationalReadiness;
  readonly expiresAt: number;
}

/**
 * Public readiness intentionally exposes only categorical state. Exact
 * latency, capacity, disk and heartbeat measurements remain administrator-only.
 */
export function toPublicOperationalReadiness(
  readiness: OperationalReadiness
): PublicOperationalReadiness {
  return {
    ok: readiness.ok,
    status: readiness.status,
    version: readiness.version,
    ts: readiness.ts,
    components: {
      migrations: { status: readiness.components.migrations.status },
      postgres: { status: readiness.components.postgres.status },
      executor: { status: readiness.components.executor.status },
      researchWorker: { status: readiness.components.researchWorker.status },
      filesystem: { status: readiness.components.filesystem.status },
      admission: { status: readiness.components.admission.status }
    }
  };
}

export class OperationalStatusService {
  private readonly now: () => number;
  private readonly readDisk: NonNullable<OperationalStatusDependencies["readDisk"]>;
  private readonly readRecoveryStatus: NonNullable<OperationalStatusDependencies["readRecoveryStatus"]>;
  private readonly heartbeatRepository?: RuntimeComponentHeartbeatRepository;
  private readinessInFlight?: Promise<OperationalReadiness>;
  private readinessCache?: ReadinessCacheEntry;

  constructor(private readonly dependencies: OperationalStatusDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.readDisk = dependencies.readDisk ?? readFilesystem;
    this.readRecoveryStatus = dependencies.readRecoveryStatus ?? readRecoveryStatusReceipt;
    this.heartbeatRepository = dependencies.pool ? new RuntimeComponentHeartbeatRepository(dependencies.pool) : undefined;
  }

  readiness(): Promise<OperationalReadiness> {
    const cached = this.readinessCache;
    if (cached && this.now() < cached.expiresAt) {
      return Promise.resolve(cached.value);
    }
    if (cached) this.readinessCache = undefined;
    if (this.readinessInFlight) return this.readinessInFlight;
    const probe = this.probeReadiness();
    this.readinessInFlight = probe;
    void probe.then(
      (value) => {
        if (this.readinessInFlight !== probe) return;
        this.readinessCache = {
          value,
          expiresAt: this.now() + this.dependencies.runtimeConfig.operations.readiness.resultTtlMs
        };
        this.readinessInFlight = undefined;
      },
      () => this.clearReadinessProbe(probe)
    );
    return probe;
  }

  private async probeReadiness(): Promise<OperationalReadiness> {
    const ts = this.now();
    const diskPromise = this.diskState();
    // PostgreSQL probes are deliberately sequential. Together with the
    // supported pool minimum this leaves a connection available for
    // authentication/control traffic during a readiness scan.
    const database = await this.databaseState();
    const heartbeat = await this.heartbeatState();
    const disk = await diskPromise;
    const admission = this.dependencies.admission.snapshot();
    const admissionStatus = admission.active >= admission.maxActive && admission.queued >= admission.maxQueued ? "unready" : admission.queued > 0 || admission.saturation >= 0.85 ? "degraded" : "ready";
    const executorReady = this.dependencies.executorReady();
    const hardFailure = database.postgres.status === "unready" || database.migrations.status === "unready" || !executorReady || heartbeat.status === "unready" || disk.status === "unready" || admissionStatus === "unready";
    const degraded = !hardFailure && (disk.status === "degraded" || admissionStatus === "degraded");
    const status: OperationalReadinessState = hardFailure ? "unready" : degraded ? "degraded" : "ready";

    return {
      ok: status !== "unready",
      status,
      version: 1,
      ts,
      components: {
        ...database,
        executor: {
          status: executorReady ? "ready" : "unready",
          mode: "paper-only"
        },
        researchWorker: heartbeat,
        filesystem: disk,
        admission: {
          status: admissionStatus,
          active: admission.active,
          queued: admission.queued,
          saturation: admission.saturation
        }
      }
    };
  }

  private clearReadinessProbe(probe: Promise<OperationalReadiness>): void {
    if (this.readinessInFlight === probe) this.readinessInFlight = undefined;
  }

  async metrics(): Promise<OperationalMetrics> {
    const [readiness, heartbeat, recovery] = await Promise.all([this.readiness(), this.heartbeatRepository?.get("research-worker"), this.recoveryStatus()]);
    return {
      version: 1,
      ts: this.now(),
      readiness,
      api: this.dependencies.apiMetrics.snapshot(),
      postgres: {
        totalCount: this.dependencies.pool?.totalCount ?? 0,
        idleCount: this.dependencies.pool?.idleCount ?? 0,
        waitingCount: this.dependencies.pool?.waitingCount ?? 0
      },
      admission: this.dependencies.admission.snapshot(),
      readinessRateLimit: this.dependencies.readinessRateLimit?.snapshot() ?? {
        ...this.dependencies.runtimeConfig.operations.readiness.rateLimit,
        buckets: 0,
        allowed: 0,
        rejected: 0
      },
      researchWorker: heartbeat
        ? {
            status: heartbeat.status,
            heartbeatAgeMs: Math.max(0, this.now() - heartbeat.heartbeatAt.getTime()),
            databaseSchemaVersion: heartbeat.databaseSchemaVersion,
            releaseCommit: heartbeat.releaseCommit
          }
        : undefined,
      recovery: {
        lastVerifiedGeneration: recovery
      }
    };
  }

  private recoveryStatus(): RecoveryStatusReceipt | null {
    const statusFile = this.dependencies.runtimeConfig.operations.recoveryStatusFile;
    if (!statusFile) return null;
    try {
      return this.readRecoveryStatus(statusFile);
    } catch {
      return null;
    }
  }

  private async databaseState(): Promise<{
    migrations: OperationalReadiness["components"]["migrations"];
    postgres: OperationalReadiness["components"]["postgres"];
  }> {
    if (!this.dependencies.pool) {
      return {
        migrations: {
          status: "legacy",
          expectedVersion: LATEST_DATABASE_SCHEMA_VERSION
        },
        postgres: { status: "legacy" }
      };
    }
    const startedAt = performance.now();
    try {
      const result = await this.dependencies.pool.query<MigrationRow>(
        `
          SELECT version, checksum
          FROM schema_migrations
          ORDER BY version DESC
          LIMIT 1
        `
      );
      const probeLatencyMs = Math.round((performance.now() - startedAt) * 100) / 100;
      const row = result.rows[0];
      const expected = DATABASE_MIGRATIONS.at(-1);
      const checksumMatches = !!row && !!expected && row.version === expected.version && row.checksum === expected.checksum;
      return {
        migrations: {
          status: checksumMatches ? "ready" : "unready",
          expectedVersion: LATEST_DATABASE_SCHEMA_VERSION,
          actualVersion: row?.version,
          checksumMatches
        },
        postgres: { status: "ready", probeLatencyMs }
      };
    } catch {
      return {
        migrations: {
          status: "unready",
          expectedVersion: LATEST_DATABASE_SCHEMA_VERSION
        },
        postgres: {
          status: "unready",
          probeLatencyMs: Math.round((performance.now() - startedAt) * 100) / 100
        }
      };
    }
  }

  private async heartbeatState(): Promise<OperationalReadiness["components"]["researchWorker"]> {
    if (!this.heartbeatRepository) return { status: "legacy" };
    try {
      const heartbeat = await this.heartbeatRepository.get("research-worker");
      if (!heartbeat) return { status: "unready" };
      const heartbeatAgeMs = Math.max(0, this.now() - heartbeat.heartbeatAt.getTime());
      const ready = heartbeat.status === "ready" && heartbeatAgeMs <= this.dependencies.runtimeConfig.operations.readiness.researchWorkerHeartbeatStaleMs && heartbeat.databaseSchemaVersion === LATEST_DATABASE_SCHEMA_VERSION;
      return {
        status: ready ? "ready" : "unready",
        heartbeatAgeMs,
        componentState: heartbeat.status
      };
    } catch {
      return { status: "unready" };
    }
  }

  private async diskState(): Promise<OperationalReadiness["components"]["filesystem"]> {
    const config = this.dependencies.runtimeConfig.operations.readiness;
    try {
      const disk = await this.readDisk(config.diskPath);
      const freePercent = disk.totalBytes > 0 ? Math.round((disk.freeBytes / disk.totalBytes) * 10_000) / 100 : 0;
      const hard = disk.freeBytes < config.diskHardFreeBytes || freePercent < config.diskHardFreePercent;
      const soft = !hard && (disk.freeBytes < config.diskSoftFreeBytes || freePercent < config.diskSoftFreePercent);
      return {
        status: hard ? "unready" : soft ? "degraded" : "ready",
        freeBytes: disk.freeBytes,
        freePercent
      };
    } catch {
      return { status: "unready" };
    }
  }
}

async function readFilesystem(path: string): Promise<{ freeBytes: number; totalBytes: number }> {
  const stats = await statfs(path);
  return {
    freeBytes: stats.bavail * stats.bsize,
    totalBytes: stats.blocks * stats.bsize
  };
}
