import { randomUUID } from "node:crypto";
import { deleteSetting, getSetting, setSetting } from "./store.js";
import type { ExchangeAdapter, ExecOrder, MarketType, PendingOrder, PositionState } from "./types.js";

const STORE_KEY = "tradingEmergencyStop";

export type EmergencyStopPhase = "idle" | "stopping" | "terminal" | "partial_failure";

export interface EmergencyStepResult<T> {
  state: "not_requested" | "confirmed" | "failed";
  attempted: boolean;
  initial: T[];
  remaining: T[];
  errors: string[];
}

export interface EmergencyAccountResult {
  account: string;
  exchange: ExchangeAdapter["id"];
  market: MarketType;
  symbols: string[];
  cancelOrders: EmergencyStepResult<Pick<PendingOrder, "id" | "symbol">>;
  flattenPositions: EmergencyStepResult<Pick<PositionState, "symbol" | "side" | "qty">>;
  ok: boolean;
}

export interface EmergencyStopResult {
  operationId: string;
  phase: Exclude<EmergencyStopPhase, "idle">;
  ok: boolean;
  flattenRequested: boolean;
  startedAt: number;
  completedAt?: number;
  botsStopped: number;
  accounts: EmergencyAccountResult[];
  errors: string[];
}

export interface EmergencyStopIdle {
  phase: "idle";
  ok: true;
  flattenRequested: false;
  botsStopped: 0;
  accounts: [];
  errors: [];
}

export type EmergencyStopStatus = EmergencyStopIdle | EmergencyStopResult;

export interface EmergencyStopOptions {
  operationId?: string;
  flatten?: boolean;
}

interface EmergencyBot {
  config: { id: string; accountId?: string; exchange: ExchangeAdapter["id"]; market: MarketType; symbol: string };
  adapter: ExchangeAdapter;
}

interface EmergencyStopDependencies {
  running: () => Iterable<EmergencyBot>;
  stop: (botId: string) => void;
  additionalAdapters?: () => Iterable<ExchangeAdapter>;
  load?: () => EmergencyStopResult | undefined;
  save?: (result: EmergencyStopResult) => void;
  clear?: () => void;
  reconcileAttempts?: number;
  reconcileDelayMs?: number;
  quiesceAttempts?: number;
}

interface AccountTarget {
  accountId?: string;
  adapter: ExchangeAdapter;
  symbols: Set<string>;
}

export class EmergencyStopConflictError extends Error {}

/**
 * Durable, idempotent account-level emergency stop.
 *
 * The in-memory gate flips before the first asynchronous operation. Strategy
 * execution must call assertLiveOrderAllowed(), so cancellation/flattening is
 * the only code allowed to submit exchange requests while the workflow runs.
 */
export class EmergencyStopCoordinator {
  private current?: EmergencyStopResult;
  private active?: { operationId: string; promise: Promise<EmergencyStopResult> };
  private readonly load: () => EmergencyStopResult | undefined;
  private readonly save: (result: EmergencyStopResult) => void;
  private readonly clear: () => void;
  private readonly attempts: number;
  private readonly delayMs: number;
  private readonly quiesceAttempts: number;
  private liveOrdersInFlight = 0;

  constructor(private readonly deps: EmergencyStopDependencies) {
    this.load = deps.load ?? (() => getSetting<EmergencyStopResult>(STORE_KEY));
    this.save = deps.save ?? ((result) => setSetting(STORE_KEY, result));
    this.clear = deps.clear ?? (() => deleteSetting(STORE_KEY));
    this.attempts = Math.max(1, deps.reconcileAttempts ?? 5);
    this.delayMs = Math.max(0, deps.reconcileDelayMs ?? 250);
    this.quiesceAttempts = Math.max(1, deps.quiesceAttempts ?? 40);
    const stored = this.load() as unknown;
    if (stored !== undefined && !isStoredResult(stored)) {
      this.current = {
        operationId: randomUUID(),
        phase: "partial_failure",
        ok: false,
        flattenRequested: false,
        startedAt: Date.now(),
        completedAt: Date.now(),
        botsStopped: 0,
        accounts: [],
        errors: ["Stored emergency-stop state is invalid; operator retry is required."]
      };
      try { this.save(this.current); } catch { /* in-memory partial_failure still blocks live execution */ }
    } else if (stored?.phase === "stopping") {
      this.current = {
        ...stored,
        phase: "partial_failure",
        ok: false,
        completedAt: Date.now(),
        errors: [...stored.errors, "Emergency stop was interrupted before exchange reconciliation completed."]
      };
      try { this.save(this.current); } catch { /* in-memory partial_failure still blocks live execution */ }
    } else {
      this.current = stored;
    }
  }

  status(): EmergencyStopStatus {
    return this.current ? structuredClone(this.current) : idleStatus();
  }

  assertLiveOrderAllowed(): void {
    if (!this.current) return;
    throw new EmergencyStopConflictError(`Live orders are blocked: emergency stop is ${this.current.phase}.`);
  }

  /** Marks the gate check and in-flight registration as one synchronous step. */
  beginLiveOrder(): () => void {
    this.assertLiveOrderAllowed();
    this.liveOrdersInFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.liveOrdersInFlight = Math.max(0, this.liveOrdersInFlight - 1);
    };
  }

  assertLiveStartAllowed(): void {
    this.assertLiveOrderAllowed();
  }

  /** A successful terminal stop is cleared only by an explicit re-arm action. */
  resetAfterTerminal(): void {
    if (!this.current) return;
    if (this.current.phase !== "terminal" || !this.current.ok) {
      throw new EmergencyStopConflictError("Emergency stop has unresolved failures. Retry it before re-arming live trading.");
    }
    this.clear();
    this.current = undefined;
  }

  run(options: EmergencyStopOptions = {}): Promise<EmergencyStopResult> {
    const operationId = options.operationId?.trim() || randomUUID();
    if (this.active) {
      if (this.active.operationId === operationId) return this.active.promise;
      throw new EmergencyStopConflictError(`Emergency stop ${this.active.operationId} is already running.`);
    }
    if (this.current?.operationId === operationId) return Promise.resolve(structuredClone(this.current));

    const bots = [...this.deps.running()];
    const started: EmergencyStopResult = {
      operationId,
      phase: "stopping",
      ok: false,
      flattenRequested: options.flatten === true,
      startedAt: Date.now(),
      botsStopped: 0,
      accounts: [],
      errors: []
    };

    // Gate and durable intent are established synchronously, before any bot can
    // reach its next await boundary and submit another exchange order.
    this.current = started;
    try {
      this.save(started);
    } catch (error) {
      this.current = { ...started, phase: "partial_failure", completedAt: Date.now(), errors: [`Could not persist emergency intent: ${messageOf(error)}`] };
      throw error;
    }
    let targets: AccountTarget[] = [];
    try {
      targets = this.collectTargets(bots);
    } catch (error) {
      started.errors.push(`Could not discover configured exchange accounts: ${messageOf(error)}`);
    }
    for (const bot of bots) {
      try {
        this.deps.stop(bot.config.id);
        started.botsStopped += 1;
      } catch (error) {
        started.errors.push(`Could not stop bot ${bot.config.id}: ${messageOf(error)}`);
      }
    }
    this.current = started;
    try {
      this.save(started);
    } catch (error) {
      started.errors.push(`Could not persist bot-stop progress: ${messageOf(error)}`);
    }

    const promise = Promise.resolve().then(() => this.perform(started, targets)).finally(() => {
      if (this.active?.operationId === operationId) this.active = undefined;
    });
    this.active = { operationId, promise };
    return promise;
  }

  private collectTargets(bots: EmergencyBot[]): AccountTarget[] {
    const targets = new Map<string, AccountTarget>();
    const add = (adapter: ExchangeAdapter, symbol?: string, configuredAccountId?: string) => {
      if (adapter.id === "paper") return;
      const accountId = configuredAccountId ?? adapter.accountId;
      const key = accountId ? `${accountId}:${adapter.market}` : `${adapter.id}:${adapter.market}`;
      const target = targets.get(key) ?? { accountId, adapter, symbols: new Set<string>() };
      if (symbol) target.symbols.add(symbol);
      targets.set(key, target);
    };
    for (const bot of bots) add(bot.adapter, bot.config.symbol, bot.config.accountId);
    for (const adapter of this.deps.additionalAdapters?.() ?? []) add(adapter);
    return [...targets.values()];
  }

  private async perform(started: EmergencyStopResult, targets: AccountTarget[]): Promise<EmergencyStopResult> {
    try {
      if (!await this.waitForLiveOrders()) {
        started.errors.push(`${this.liveOrdersInFlight} live order request(s) did not finish before the emergency reconciliation deadline.`);
      }
      started.accounts = await Promise.all(targets.map((target) => this.stopAccount(target, started.flattenRequested)));
    } catch (error) {
      started.errors.push(`Emergency workflow failed unexpectedly: ${messageOf(error)}`);
    }
    const failedAccounts = started.accounts.filter((account) => !account.ok);
    for (const account of failedAccounts) started.errors.push(`${account.account} did not reach the requested terminal state.`);
    const ok = started.errors.length === 0 && failedAccounts.length === 0;
    const completed: EmergencyStopResult = {
      ...started,
      phase: ok ? "terminal" : "partial_failure",
      ok,
      completedAt: Date.now()
    };
    this.current = completed;
    try {
      this.save(completed);
    } catch (error) {
      completed.phase = "partial_failure";
      completed.ok = false;
      completed.errors.push(`Could not persist the reconciled terminal state: ${messageOf(error)}`);
      this.current = completed;
      try { this.save(completed); } catch { /* keep the in-memory fail-closed gate */ }
    }
    return structuredClone(completed);
  }

  private async waitForLiveOrders(): Promise<boolean> {
    for (let attempt = 0; attempt < this.quiesceAttempts; attempt += 1) {
      if (this.liveOrdersInFlight === 0) return true;
      if (this.delayMs > 0) await sleep(this.delayMs);
    }
    return this.liveOrdersInFlight === 0;
  }

  private async stopAccount(target: AccountTarget, flatten: boolean): Promise<EmergencyAccountResult> {
    const { adapter, symbols } = target;
    const cancelOrders = await this.cancelAndReconcile(adapter, symbols);
    const flattenPositions = flatten
      ? await this.flattenAndReconcile(adapter)
      : notRequested<Pick<PositionState, "symbol" | "side" | "qty">>();
    return {
      account: target.accountId ? `${target.accountId}:${adapter.market}` : `${adapter.id}:${adapter.market}`,
      exchange: adapter.id,
      market: adapter.market,
      symbols: [...symbols].sort(),
      cancelOrders,
      flattenPositions,
      ok: cancelOrders.state === "confirmed" && (!flatten || flattenPositions.state === "confirmed")
    };
  }

  private async cancelAndReconcile(
    adapter: ExchangeAdapter,
    knownSymbols: Set<string>
  ): Promise<EmergencyStepResult<Pick<PendingOrder, "id" | "symbol">>> {
    const errors: string[] = [];
    let initial: PendingOrder[] = [];
    let enumerated = false;
    if (!adapter.orders) {
      return failed([], [], "Exchange adapter cannot enumerate account orders.");
    }
    try {
      initial = await adapter.orders();
      enumerated = true;
      for (const order of initial) knownSymbols.add(order.symbol);
    } catch (error) {
      errors.push(`Could not enumerate open orders: ${messageOf(error)}`);
    }

    for (const symbol of knownSymbols) {
      const order: ExecOrder = { action: "cancelall", market: adapter.market, symbol, type: "market", reason: "emergency:cancel-all" };
      try {
        const result = await adapter.execute(order);
        if (!result.ok) errors.push(`${symbol}: ${result.message || "cancel-all was rejected"}`);
      } catch (error) {
        errors.push(`${symbol}: cancel-all failed: ${messageOf(error)}`);
      }
    }

    const reconciliation = await this.reconcile(() => adapter.orders!(), (orders) => orders.length === 0);
    if (reconciliation.error) errors.push(`Order reconciliation failed: ${reconciliation.error}`);
    if (!reconciliation.confirmed) errors.push(`${reconciliation.value.length} open order(s) remain on the account.`);
    if (!enumerated && knownSymbols.size === 0) errors.push("No symbols were available for best-effort cancellation.");
    return {
      state: reconciliation.confirmed ? "confirmed" : "failed",
      attempted: knownSymbols.size > 0,
      initial: summarizeOrders(initial),
      remaining: summarizeOrders(reconciliation.value),
      errors
    };
  }

  private async flattenAndReconcile(
    adapter: ExchangeAdapter
  ): Promise<EmergencyStepResult<Pick<PositionState, "symbol" | "side" | "qty">>> {
    if (!adapter.positions) return failed([], [], "Exchange adapter cannot enumerate every account position; flatten refused.");
    const errors: string[] = [];
    let initial: PositionState[];
    try {
      initial = (await adapter.positions()).filter(hasQuantity);
    } catch (error) {
      return failed([], [], `Could not enumerate positions: ${messageOf(error)}`);
    }

    for (const position of initial) {
      const order: ExecOrder = {
        action: "flatten",
        market: adapter.market,
        symbol: position.symbol,
        side: position.side === "long" ? "sell" : "buy",
        type: "market",
        closePct: 100,
        reduceOnly: true,
        positionSide: position.hedged ? position.side : undefined,
        positionIndex: position.positionIndex,
        reason: "emergency:reduce-only-flatten"
      };
      try {
        const result = await adapter.execute(order);
        if (!result.ok) errors.push(`${position.symbol}: ${result.message || "flatten was rejected"}`);
      } catch (error) {
        errors.push(`${position.symbol}: flatten failed: ${messageOf(error)}`);
      }
    }

    const reconciliation = await this.reconcile(
      async () => (await adapter.positions!()).filter(hasQuantity),
      (positions) => positions.length === 0
    );
    if (reconciliation.error) errors.push(`Position reconciliation failed: ${reconciliation.error}`);
    if (!reconciliation.confirmed) errors.push(`${reconciliation.value.length} position(s) remain on the account.`);
    return {
      state: reconciliation.confirmed ? "confirmed" : "failed",
      attempted: initial.length > 0,
      initial: summarizePositions(initial),
      remaining: summarizePositions(reconciliation.value),
      errors
    };
  }

  private async reconcile<T>(read: () => Promise<T[]>, done: (value: T[]) => boolean): Promise<{ confirmed: boolean; value: T[]; error?: string }> {
    let value: T[] = [];
    let lastError: string | undefined;
    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      if (attempt > 0 && this.delayMs > 0) await sleep(this.delayMs);
      try {
        value = await read();
        lastError = undefined;
        if (done(value)) return { confirmed: true, value };
      } catch (error) {
        lastError = messageOf(error);
      }
    }
    return { confirmed: false, value, error: lastError };
  }
}

function idleStatus(): EmergencyStopIdle {
  return { phase: "idle", ok: true, flattenRequested: false, botsStopped: 0, accounts: [], errors: [] };
}

function notRequested<T>(): EmergencyStepResult<T> {
  return { state: "not_requested", attempted: false, initial: [], remaining: [], errors: [] };
}

function failed<T>(initial: T[], remaining: T[], error: string): EmergencyStepResult<T> {
  return { state: "failed", attempted: false, initial, remaining, errors: [error] };
}

function summarizeOrders(orders: PendingOrder[]): Array<Pick<PendingOrder, "id" | "symbol">> {
  return orders.map(({ id, symbol }) => ({ id, symbol }));
}

function summarizePositions(positions: PositionState[]): Array<Pick<PositionState, "symbol" | "side" | "qty">> {
  return positions.map(({ symbol, side, qty }) => ({ symbol, side, qty }));
}

function hasQuantity(position: PositionState): boolean {
  return Number.isFinite(position.qty) && position.qty > 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStoredResult(value: unknown): value is EmergencyStopResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<EmergencyStopResult>;
  const phaseValid = result.phase === "stopping" || result.phase === "terminal" || result.phase === "partial_failure";
  const outcomeValid = result.phase === "terminal" ? result.ok === true : result.ok === false;
  return phaseValid && outcomeValid && typeof result.operationId === "string" && result.operationId.length > 0
    && typeof result.flattenRequested === "boolean" && typeof result.startedAt === "number"
    && typeof result.botsStopped === "number" && Array.isArray(result.accounts) && Array.isArray(result.errors);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
