import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ExecutorCommandCapacityError,
  ExecutorCommandIdempotencyConflictError,
  type ExecutorCommandRepository
} from "../database/index.js";
import { FencedExecutorBridge } from "../database/executorBridge.js";
import type {
  ExecutorBridge,
  ExecutorBridgeDrainResult,
  ExecutorBridgeReadinessSnapshot
} from "../database/executorBridgeTypes.js";
import { roleAllows } from "../auth.js";
import type { IdentityService } from "../identity/service.js";
import {
  isPaperPortfolioReadPayload,
  PAPER_TELEGRAM_COMMAND_ORIGIN,
  PAPER_TELEGRAM_IDEMPOTENCY_KEY_PREFIX,
  paperPortfolioCommandTarget,
  parsePaperPortfolioExecutorPayload
} from "./paperPortfolioCommandContract.js";
import {
  executePaperPortfolioRead,
  paperPortfolioReadReceiptHash
} from "./paperPortfolioExecutorReads.js";
import {
  PaperPortfolioCommandHandler,
  type PaperPortfolioApplicationContext,
  type PaperPortfolioCommandRuntime
} from "./paperPortfolioCommandHandler.js";
import { recoverIncompletePaperMultiLegIntents } from "./multiLeg/intentService.js";
import { PaperPortfolioReadService } from "./paperPortfolioReadService.js";
import {
  PaperPortfolioHttpError,
  type PaperPortfolioMutationGateway
} from "./paperPortfolioGatewayTypes.js";
import { PaperPortfolioStoreError } from "./paperPortfolioStoreSupport.js";
import type { TradingEngine } from "./engine.js";

export interface PaperPortfolioRuntimeOptions {
  database: DatabaseSync;
  engine: TradingEngine;
  executorCommands?: ExecutorCommandRepository;
  identityService?: IdentityService;
  workerId?: string;
}

export interface PaperPortfolioRuntime {
  reads: PaperPortfolioReadService;
  commands: PaperPortfolioMutationGateway;
  start(): Promise<void>;
  quiesce(): void;
  ready(): boolean;
  readiness(): ExecutorBridgeReadinessSnapshot | undefined;
  close(): Promise<ExecutorBridgeDrainResult>;
}

export function createPaperPortfolioRuntime(options: PaperPortfolioRuntimeOptions): PaperPortfolioRuntime {
  if (Boolean(options.executorCommands) !== Boolean(options.identityService)) {
    throw new Error("Paper executor PostgreSQL repository and identity service must be configured together");
  }
  const runtime = engineRuntime(options.engine);
  const reads = new PaperPortfolioReadService(options.database, runtime);
  const handler = new PaperPortfolioCommandHandler(options.database, runtime);
  if (!options.executorCommands || !options.identityService) {
    return {
      reads,
      commands: new DirectPaperPortfolioGateway(handler),
      // Same startup discipline as persisted robot resume: incomplete durable
      // multi-leg intents replay to their identical terminal state first.
      async start() { recoverIncompletePaperMultiLegIntents(options.database); },
      quiesce() {},
      ready: () => true,
      readiness: () => undefined,
      async close() {
        return { drained: true, timedOut: false, applyingCommandId: null };
      }
    };
  }
  const bridge = new FencedExecutorBridge({
    repository: options.executorCommands,
    probeAppliedReceipt: async (identity) => {
      const receipt = handler.probeAppliedReceipt({
        commandId: identity.commandId,
        ownerUserId: identity.ownerUserId,
        idempotencyKey: identity.idempotencyKey,
        requestHash: identity.requestHash
      });
      return receipt
        ? { outcome: "applied" as const, sqliteReceiptHash: receipt.sqliteReceiptHash }
        : { outcome: "not-found" as const };
    },
    authorize: (command) => authorizeExecutorCommand(options.identityService!, command),
    apply: async (command, context) => {
      context.signal.throwIfAborted();
      const payload = parsePaperPortfolioExecutorPayload(command.payload);
      const target = paperPortfolioCommandTarget(payload);
      if (
        command.commandType !== payload.kind
        || command.targetType !== target.targetType
        || command.targetId !== target.targetId
      ) {
        return {
          outcome: "rejected" as const,
          errorCode: "invalid_command_identity",
          errorMessage: "Executor command target does not match its validated payload."
        };
      }
      if (isPaperPortfolioReadPayload(payload)) {
        try {
          const result = executePaperPortfolioRead(reads, command.ownerUserId, payload);
          context.signal.throwIfAborted();
          return {
            outcome: "applied" as const,
            sqliteReceiptHash: paperPortfolioReadReceiptHash(command, result),
            result
          };
        } catch (error) {
          if (!(error instanceof PaperPortfolioStoreError)) throw error;
          return {
            outcome: "rejected" as const,
            errorCode: domainErrorCode(error.code),
            errorMessage: error.message.slice(0, 4_000)
          };
        }
      }
      try {
        const applied = await handler.apply(applicationContext(command));
        context.signal.throwIfAborted();
        return {
          outcome: "applied" as const,
          sqliteReceiptHash: applied.sqliteReceiptHash,
          result: {
            portfolioId: "portfolioId" in payload ? payload.portfolioId : target.targetId,
            commandType: payload.kind
          }
        };
      } catch (error) {
        if (!(error instanceof PaperPortfolioStoreError)) throw error;
        return {
          outcome: "rejected" as const,
          errorCode: domainErrorCode(error.code),
          errorMessage: error.message.slice(0, 4_000)
        };
      }
    }
  }, {
    workerId: options.workerId ?? `saltanat-paper-executor-${process.pid}`,
    leaseMs: 30_000,
    renewalIntervalMs: 10_000,
    submitWaitTimeoutMs: 10_000,
    closeDrainTimeoutMs: 10_000
  });
  return {
    reads,
    commands: new FencedPaperPortfolioGateway(bridge),
    // Recover incomplete multi-leg intents on the robot-resume startup path,
    // before the executor bridge claims any queued command.
    async start() {
      recoverIncompletePaperMultiLegIntents(options.database);
      await bridge.start();
    },
    quiesce() { bridge.quiesce(); },
    ready: () => bridge.readiness().ready,
    readiness: () => bridge.readiness(),
    close: () => bridge.close()
  };
}

class FencedPaperPortfolioGateway implements PaperPortfolioMutationGateway {
  constructor(private readonly bridge: ExecutorBridge) {}

  async execute(input: Parameters<PaperPortfolioMutationGateway["execute"]>[0]): Promise<{ replayed: boolean }> {
    const payload = input.payload;
    const target = paperPortfolioCommandTarget(payload);
    try {
      const outcome = await this.bridge.submitAndWait({
        ownerUserId: input.principal.ownerUserId,
        actorUserId: input.principal.actorUserId,
        sessionIdHash: input.principal.sessionIdHash,
        authorizationRevision: input.principal.authorizationRevision,
        authorizationEpoch: input.principal.authorizationEpoch,
        commandType: payload.kind,
        targetType: target.targetType,
        targetId: target.targetId,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        payload
      });
      if (outcome.outcome === "applied") return { replayed: outcome.enqueueOutcome === "replayed" };
      if (outcome.outcome === "rejected") {
        throw new PaperPortfolioHttpError(
          rejectionStatus(outcome.command.errorCode),
          outcome.command.errorCode ?? "command_rejected",
          outcome.command.errorMessage ?? "Paper portfolio command was rejected."
        );
      }
      if (outcome.outcome === "timeout") {
        throw new PaperPortfolioHttpError(
          503,
          "command_pending",
          "Paper portfolio command is still pending. Retry with the same Idempotency-Key."
        );
      }
      throw new PaperPortfolioHttpError(
        503,
        outcome.outcome === "closed" ? "executor_quiesced" : "command_unavailable",
        "Paper portfolio executor is temporarily unavailable."
      );
    } catch (error) {
      if (error instanceof ExecutorCommandIdempotencyConflictError) {
        throw new PaperPortfolioHttpError(409, "idempotency_conflict", error.message);
      }
      if (error instanceof ExecutorCommandCapacityError) {
        throw new PaperPortfolioHttpError(429, "command_capacity", error.message);
      }
      throw error;
    }
  }
}

class DirectPaperPortfolioGateway implements PaperPortfolioMutationGateway {
  constructor(private readonly handler: PaperPortfolioCommandHandler) {}

  async execute(input: Parameters<PaperPortfolioMutationGateway["execute"]>[0]): Promise<{ replayed: boolean }> {
    const applied = await this.handler.apply({
      commandId: directCommandId(input.principal.ownerUserId, input.idempotencyKey),
      ownerUserId: input.principal.ownerUserId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      payload: input.payload
    });
    return { replayed: applied.replayed };
  }
}

function engineRuntime(engine: TradingEngine): PaperPortfolioCommandRuntime {
  return {
    isRunning: (owner, botId) => engine.isRunningForOwner(owner, botId),
    isPaused: (owner, botId) => engine.isPausedForOwner(owner, botId),
    start: (owner, bot) => engine.startForOwner(owner, bot),
    pause: (owner, botId) => engine.pauseForOwner(owner, botId),
    resume: (owner, botId) => engine.confirmResumeForOwner(owner, botId),
    stop: (owner, botId) => engine.stopSafelyForOwner(owner, botId)
  };
}

/**
 * Owner-scoped system principal for Telegram-origin commands. The notification
 * worker holds no browser session and cannot know this process's in-memory
 * authorization epoch, so recognition rests on all three durable markers
 * together (payload origin + reserved idempotency-key prefix + a null actor —
 * HTTP enqueues always set the actor). Authorization then re-proves the owner
 * against the CURRENT snapshot: active user, paper-trade role, the exact
 * durable authorization_revision carried by the command, and no in-process
 * authorization transition. The epoch equality check is deliberately replaced
 * by the snapshot-currency check for these commands.
 */
function isTelegramOriginExecutorCommand(command: {
  readonly actorUserId: string | null;
  readonly idempotencyKey: string;
  readonly payload: Record<string, unknown>;
}): boolean {
  return (
    command.actorUserId === null
    && command.idempotencyKey.startsWith(PAPER_TELEGRAM_IDEMPOTENCY_KEY_PREFIX)
    && command.payload["origin"] === PAPER_TELEGRAM_COMMAND_ORIGIN
  );
}

async function authorizeExecutorCommand(
  service: IdentityService,
  command: Parameters<NonNullable<ConstructorParameters<typeof FencedExecutorBridge>[0]["authorize"]>>[0]
) {
  if (isTelegramOriginExecutorCommand(command)) {
    const authorization = await service.executionAuthorizationSnapshot(command.ownerUserId);
    if (
      !authorization
      || !roleAllows(authorization.role, "paper-trade")
      || authorization.authorizationRevision !== command.authorizationRevision
      || !service.isExecutionAuthorizationCurrent(authorization)
    ) {
      return {
        outcome: "rejected" as const,
        errorCode: "authorization_stale",
        errorMessage: "Trading authorization changed before the paper command was applied."
      };
    }
    return { outcome: "authorized" as const };
  }
  const [authorization, session] = await Promise.all([
    service.executionAuthorizationSnapshot(command.ownerUserId),
    service.repository.findSession(command.sessionIdHash)
  ]);
  const validSession = session
    && session.user.id === command.ownerUserId
    && session.user.id === command.actorUserId
    && session.user.status === "active"
    && !session.user.mustChangePassword
    && !session.session.revokedAt
    && session.session.expiresAt.getTime() > Date.now();
  if (
    !authorization
    || !validSession
    || !roleAllows(authorization.role, "paper-trade")
    || authorization.authorizationRevision !== command.authorizationRevision
    || authorization.authorizationEpoch !== command.authorizationEpoch
    || !service.isExecutionAuthorizationCurrent(authorization)
  ) {
    return {
      outcome: "rejected" as const,
      errorCode: "authorization_stale",
      errorMessage: "Trading authorization changed before the paper command was applied."
    };
  }
  return { outcome: "authorized" as const };
}

function applicationContext(command: {
  id: string;
  ownerUserId: string;
  idempotencyKey: string;
  requestHash: string;
  payload: Record<string, unknown>;
}): PaperPortfolioApplicationContext {
  return {
    commandId: command.id,
    ownerUserId: command.ownerUserId,
    idempotencyKey: command.idempotencyKey,
    requestHash: command.requestHash,
    payload: command.payload
  };
}

function directCommandId(ownerUserId: string, idempotencyKey: string): string {
  const digest = createHash("sha256").update(`${ownerUserId}\0${idempotencyKey}`).digest("hex");
  return `local-${digest}`;
}

function domainErrorCode(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "_").slice(0, 96);
  return /^[a-z]/.test(normalized) ? normalized : `paper_${normalized}`;
}

function rejectionStatus(code: string | null): number {
  if (!code) return 409;
  if (code.startsWith("authorization_")) return 401;
  if (code === "not_found" || code.endsWith("_not_found")) return 404;
  if (code.includes("capacity") || code.includes("limit")) return 429;
  return 409;
}
