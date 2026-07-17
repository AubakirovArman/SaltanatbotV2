import type { NextFunction, Request, RequestHandler, Response } from "express";

export type AdmissionLane = "bypass" | "control" | "ordinary";

export interface GlobalAdmissionOptions {
  readonly maxActive: number;
  readonly reservedControlSlots: number;
  readonly maxQueued: number;
  readonly queueTimeoutMs: number;
  readonly retryAfterSeconds?: number;
  readonly now?: () => number;
}

export interface GlobalAdmissionSnapshot {
  readonly maxActive: number;
  readonly ordinaryActiveLimit: number;
  readonly reservedControlSlots: number;
  readonly maxQueued: number;
  readonly active: number;
  readonly activeControl: number;
  readonly activeOrdinary: number;
  readonly queued: number;
  readonly admitted: number;
  readonly rejected: number;
  readonly timedOut: number;
  readonly cancelledWhileQueued: number;
  readonly waitSamples: number;
  readonly totalWaitMs: number;
  readonly maxWaitMs: number;
  readonly saturation: number;
}

interface QueuedRequest {
  readonly request: Request;
  readonly response: Response;
  readonly next: NextFunction;
  readonly enqueuedAt: number;
  timeout?: NodeJS.Timeout;
  settled: boolean;
  cancel(): void;
  promote(): void;
}

/**
 * Process-wide admission controller for inbound API requests.
 *
 * Ordinary work may consume only `maxActive - reservedControlSlots`; control
 * requests can use the reserved tail immediately and never wait behind the
 * ordinary queue. Probes may bypass the controller entirely.
 */
export class GlobalAdmissionController {
  private readonly options: Required<Omit<GlobalAdmissionOptions, "now">> & {
    readonly now: () => number;
  };
  private readonly queue: QueuedRequest[] = [];
  private activeControl = 0;
  private activeOrdinary = 0;
  private admitted = 0;
  private rejected = 0;
  private timedOut = 0;
  private cancelledWhileQueued = 0;
  private waitSamples = 0;
  private totalWaitMs = 0;
  private maxWaitMs = 0;

  constructor(options: GlobalAdmissionOptions) {
    validateOptions(options);
    this.options = {
      ...options,
      retryAfterSeconds: options.retryAfterSeconds ?? Math.max(1, Math.ceil(options.queueTimeoutMs / 1_000)),
      now: options.now ?? Date.now
    };
  }

  middleware(classify: (request: Request) => AdmissionLane = classifyApiAdmissionLane): RequestHandler {
    return (request, response, next) => {
      // Set this before admission can queue/reject the request so overload and
      // timeout responses for the public probe are never cacheable.
      if (apiRequestPath(request) === "/api/ready") {
        response.setHeader("Cache-Control", "no-store");
      }
      const lane = classify(request);
      if (lane === "bypass") {
        next();
        return;
      }
      if (this.canAdmit(lane)) {
        this.admit(lane, response, next);
        return;
      }
      if (lane === "control" || this.queue.length >= this.options.maxQueued) {
        this.reject(response, false);
        return;
      }
      this.enqueue(request, response, next);
    };
  }

  snapshot(): GlobalAdmissionSnapshot {
    const active = this.activeControl + this.activeOrdinary;
    return {
      maxActive: this.options.maxActive,
      ordinaryActiveLimit: this.ordinaryLimit(),
      reservedControlSlots: this.options.reservedControlSlots,
      maxQueued: this.options.maxQueued,
      active,
      activeControl: this.activeControl,
      activeOrdinary: this.activeOrdinary,
      queued: this.queue.length,
      admitted: this.admitted,
      rejected: this.rejected,
      timedOut: this.timedOut,
      cancelledWhileQueued: this.cancelledWhileQueued,
      waitSamples: this.waitSamples,
      totalWaitMs: this.totalWaitMs,
      maxWaitMs: this.maxWaitMs,
      saturation: this.options.maxActive === 0 ? 1 : Math.round((active / this.options.maxActive) * 1_000) / 1_000
    };
  }

  private ordinaryLimit(): number {
    return this.options.maxActive - this.options.reservedControlSlots;
  }

  private canAdmit(lane: Exclude<AdmissionLane, "bypass">): boolean {
    const active = this.activeControl + this.activeOrdinary;
    if (active >= this.options.maxActive) return false;
    return lane === "control" || this.activeOrdinary < this.ordinaryLimit();
  }

  private admit(lane: Exclude<AdmissionLane, "bypass">, response: Response, next: NextFunction): void {
    if (lane === "control") this.activeControl += 1;
    else this.activeOrdinary += 1;
    this.admitted += 1;

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      response.off("finish", release);
      response.off("close", release);
      if (lane === "control") this.activeControl = Math.max(0, this.activeControl - 1);
      else this.activeOrdinary = Math.max(0, this.activeOrdinary - 1);
      this.promote();
    };
    response.once("finish", release);
    response.once("close", release);
    try {
      next();
    } catch (error) {
      release();
      throw error;
    }
  }

  private enqueue(request: Request, response: Response, next: NextFunction): void {
    const queued: QueuedRequest = {
      request,
      response,
      next,
      enqueuedAt: this.options.now(),
      timeout: undefined,
      settled: false,
      cancel: () => undefined,
      promote: () => undefined
    };
    const settle = (reason: "cancel" | "timeout" | "promote") => {
      if (queued.settled) return false;
      queued.settled = true;
      if (queued.timeout) clearTimeout(queued.timeout);
      request.off("aborted", queued.cancel);
      response.off("close", queued.cancel);
      const index = this.queue.indexOf(queued);
      if (index >= 0) this.queue.splice(index, 1);
      if (reason === "cancel") this.cancelledWhileQueued += 1;
      return true;
    };
    queued.cancel = () => {
      settle("cancel");
    };
    queued.timeout = setTimeout(() => {
      if (!settle("timeout")) return;
      this.timedOut += 1;
      this.reject(response, true);
    }, this.options.queueTimeoutMs);
    queued.timeout.unref?.();
    request.once("aborted", queued.cancel);
    response.once("close", queued.cancel);
    this.queue.push(queued);

    queued.promote = () => {
      if (!settle("promote")) return;
      const waited = Math.max(0, this.options.now() - queued.enqueuedAt);
      this.waitSamples += 1;
      this.totalWaitMs += waited;
      this.maxWaitMs = Math.max(this.maxWaitMs, waited);
      this.admit("ordinary", response, next);
    };
  }

  private promote(): void {
    while (this.queue.length > 0 && this.canAdmit("ordinary")) {
      const queued = this.queue[0];
      if (!queued) return;
      queued.promote();
    }
  }

  private reject(response: Response, timedOut: boolean): void {
    this.rejected += 1;
    if (response.headersSent || response.writableEnded) return;
    response.setHeader("Retry-After", String(this.options.retryAfterSeconds));
    response.status(503).json({
      error: timedOut ? "The server is busy and the request could not start in time." : "The server is at its global request limit.",
      code: "global_admission_exhausted",
      retryable: true
    });
  }
}

export function classifyApiAdmissionLane(request: Pick<Request, "method" | "path" | "originalUrl">): AdmissionLane {
  const path = apiRequestPath(request);
  if (path === "/api/health") return "bypass";
  // Readiness performs PostgreSQL, heartbeat and filesystem probes. Keep it in
  // the bounded ordinary lane so an unauthenticated probe flood cannot create
  // unbounded dependency work or consume the slots reserved for stop/cancel
  // controls. Saturation is itself a valid reason for readiness to return 503.
  if (path === "/api/ready") return "ordinary";
  if (path.startsWith("/api/auth/")) return "control";
  if (request.method === "POST" && /^\/api\/jobs\/[^/]+\/cancel$/.test(path)) {
    return "control";
  }
  if (request.method === "POST" && (/^\/api\/trade\/bots\/[^/]+\/stop$/.test(path) || path === "/api/trade/kill")) {
    return "control";
  }
  return "ordinary";
}

function apiRequestPath(
  request: Pick<Request, "path" | "originalUrl">
): string {
  const originalPath = request.originalUrl.split("?")[0] || "";
  return originalPath.startsWith("/api")
    ? originalPath
    : request.path || originalPath;
}

function validateOptions(options: GlobalAdmissionOptions): void {
  for (const [name, value] of [
    ["maxActive", options.maxActive],
    ["reservedControlSlots", options.reservedControlSlots],
    ["maxQueued", options.maxQueued],
    ["queueTimeoutMs", options.queueTimeoutMs]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Global admission ${name} must be a non-negative safe integer`);
    }
  }
  if (options.maxActive < 2) {
    throw new Error("Global admission maxActive must be at least 2");
  }
  if (options.reservedControlSlots < 1 || options.reservedControlSlots >= options.maxActive) {
    throw new Error("Global admission reservedControlSlots must be between 1 and maxActive - 1");
  }
  if (options.maxQueued < 1) {
    throw new Error("Global admission maxQueued must be at least 1");
  }
  if (options.queueTimeoutMs < 100 || options.queueTimeoutMs > 30_000) {
    throw new Error("Global admission queueTimeoutMs must be between 100 and 30000");
  }
  if (options.retryAfterSeconds !== undefined && (!Number.isSafeInteger(options.retryAfterSeconds) || options.retryAfterSeconds < 1 || options.retryAfterSeconds > 3_600)) {
    throw new Error("Global admission retryAfterSeconds must be between 1 and 3600");
  }
}
