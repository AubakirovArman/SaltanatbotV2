import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  archivePaperPortfolio,
  createPaperIdempotencyKey,
  createPaperPortfolio,
  getPaperPortfolio,
  listPaperPortfolios,
  renamePaperPortfolio,
  resetPaperPortfolio,
  runPaperRobotAction,
  setDefaultPaperPortfolio
} from "./paperPortfolioClient";
import type {
  PaperMoney,
  PaperPortfolioDetail,
  PaperPortfolioListResponse,
  PaperPortfolioMutationResult,
  PaperRobotAction,
  PaperRobotProjection
} from "./paperPortfolioTypes";

type Phase = "loading" | "refreshing" | "ready";

export interface PaperPortfolioCenterClient {
  list: typeof listPaperPortfolios;
  get: typeof getPaperPortfolio;
  create: typeof createPaperPortfolio;
  rename: typeof renamePaperPortfolio;
  setDefault: typeof setDefaultPaperPortfolio;
  archive: typeof archivePaperPortfolio;
  reset: typeof resetPaperPortfolio;
  robotAction: typeof runPaperRobotAction;
  idempotencyKey: typeof createPaperIdempotencyKey;
}

const defaultClient: PaperPortfolioCenterClient = {
  list: listPaperPortfolios,
  get: getPaperPortfolio,
  create: createPaperPortfolio,
  rename: renamePaperPortfolio,
  setDefault: setDefaultPaperPortfolio,
  archive: archivePaperPortfolio,
  reset: resetPaperPortfolio,
  robotAction: runPaperRobotAction,
  idempotencyKey: createPaperIdempotencyKey
};
const emptyBusyKeys: ReadonlySet<string> = new Set();

export interface UsePaperPortfolioCenterOptions {
  ownerUserId: string;
  client?: PaperPortfolioCenterClient;
  refreshIntervalMs?: number;
  maximumBackoffMs?: number;
}

export interface PaperPortfolioCenterState {
  phase: Phase;
  list?: PaperPortfolioListResponse;
  detail?: PaperPortfolioDetail;
  selectedPortfolioId?: string;
  stale: boolean;
  error?: Error;
  busyKeys: ReadonlySet<string>;
  refresh: () => Promise<void>;
  selectPortfolio: (portfolioId: string) => void;
  createPortfolio: (name: string, initialCapital: PaperMoney) => Promise<PaperPortfolioMutationResult | undefined>;
  renamePortfolio: (name: string) => Promise<PaperPortfolioMutationResult | undefined>;
  setDefaultPortfolio: () => Promise<PaperPortfolioMutationResult | undefined>;
  archivePortfolio: (confirmName: string) => Promise<PaperPortfolioMutationResult | undefined>;
  resetPortfolio: (confirmName: string, initialCapital?: PaperMoney) => Promise<PaperPortfolioMutationResult | undefined>;
  runRobotAction: (robot: PaperRobotProjection, action: PaperRobotAction) => Promise<PaperPortfolioMutationResult | undefined>;
}

export function usePaperPortfolioCenter({
  ownerUserId,
  client = defaultClient,
  refreshIntervalMs = 15_000,
  maximumBackoffMs = 120_000
}: UsePaperPortfolioCenterOptions): PaperPortfolioCenterState {
  const [phase, setPhase] = useState<Phase>("loading");
  const [list, setList] = useState<PaperPortfolioListResponse>();
  const [detail, setDetail] = useState<PaperPortfolioDetail>();
  const [stateOwner, setStateOwner] = useState<string>();
  const [selectedPortfolioId, setSelectedPortfolioId] = useState<string>();
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<Error>();
  const [errorOwner, setErrorOwner] = useState<string>();
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());

  const generation = useRef(0);
  const refreshAbort = useRef<AbortController>();
  const mutationAborts = useRef(new Set<AbortController>());
  const selectedRef = useRef<string>();
  const detailRef = useRef<PaperPortfolioDetail>();
  const failedRefreshes = useRef(0);
  const mutationLocks = useRef(new Map<string, Promise<PaperPortfolioMutationResult | undefined>>());
  detailRef.current = stateOwner === ownerUserId ? detail : undefined;

  const clearOwnerState = useCallback(() => {
    generation.current += 1;
    refreshAbort.current?.abort();
    refreshAbort.current = undefined;
    mutationAborts.current.forEach((controller) => controller.abort());
    mutationAborts.current.clear();
    mutationLocks.current.clear();
    selectedRef.current = undefined;
    detailRef.current = undefined;
    failedRefreshes.current = 0;
    setStateOwner(undefined);
    setList(undefined);
    setDetail(undefined);
    setSelectedPortfolioId(undefined);
    setStale(false);
    setError(undefined);
    setErrorOwner(undefined);
    setBusyKeys(new Set());
    setPhase("loading");
  }, []);

  const refresh = useCallback(async () => {
    if (!ownerUserId) return;
    const currentGeneration = ++generation.current;
    refreshAbort.current?.abort();
    const controller = new AbortController();
    refreshAbort.current = controller;
    setPhase(detailRef.current ? "refreshing" : "loading");
    try {
      const nextList = await client.list(ownerUserId, controller.signal);
      const selected = choosePortfolio(nextList, selectedRef.current);
      const nextDetail = selected ? await client.get(ownerUserId, selected, controller.signal) : undefined;
      if (controller.signal.aborted || generation.current !== currentGeneration) return;
      selectedRef.current = selected;
      detailRef.current = nextDetail;
      failedRefreshes.current = 0;
      setStateOwner(ownerUserId);
      setList(nextList);
      setDetail(nextDetail);
      setSelectedPortfolioId(selected);
      setStale(false);
      setError(undefined);
      setErrorOwner(undefined);
      setPhase("ready");
    } catch (cause) {
      if (controller.signal.aborted || generation.current !== currentGeneration || isAbort(cause)) return;
      failedRefreshes.current += 1;
      setError(asError(cause));
      setErrorOwner(ownerUserId);
      setStale(!!detailRef.current);
      setPhase("ready");
    } finally {
      if (refreshAbort.current === controller) refreshAbort.current = undefined;
    }
  }, [client, ownerUserId]);

  useEffect(() => {
    clearOwnerState();
    if (ownerUserId) void refresh();
    return clearOwnerState;
  }, [clearOwnerState, ownerUserId, refresh]);

  useEffect(() => {
    if (!ownerUserId) return;
    let stopped = false;
    let timer: number | undefined;
    const schedule = () => {
      if (stopped) return;
      const delay = Math.min(maximumBackoffMs, refreshIntervalMs * 2 ** Math.min(failedRefreshes.current, 4));
      timer = window.setTimeout(async () => {
        if (document.visibilityState !== "hidden") await refresh();
        schedule();
      }, delay);
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const refreshOnFocus = () => void refresh();
    schedule();
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [maximumBackoffMs, ownerUserId, refresh, refreshIntervalMs]);

  const selectPortfolio = useCallback((portfolioId: string) => {
    const next = portfolioId.trim();
    if (!next || next === selectedRef.current) return;
    selectedRef.current = next;
    void refresh();
  }, [refresh]);

  const runMutation = useCallback((
    lockKey: string,
    task: (signal: AbortSignal, idempotencyKey: string) => Promise<PaperPortfolioMutationResult>,
    selectResult = false
  ): Promise<PaperPortfolioMutationResult | undefined> => {
    const existing = mutationLocks.current.get(lockKey);
    if (existing) return existing;
    const controller = new AbortController();
    mutationAborts.current.add(controller);
    setBusyKeys((current) => new Set(current).add(lockKey));
    const promise = task(controller.signal, client.idempotencyKey())
      .then(async (result) => {
        if (selectResult) {
          selectedRef.current = result.portfolio.id;
        }
        await refresh();
        return result;
      })
      .catch((cause) => {
        if (!isAbort(cause)) {
          setError(asError(cause));
          setErrorOwner(ownerUserId);
        }
        return undefined;
      })
      .finally(() => {
        mutationAborts.current.delete(controller);
        mutationLocks.current.delete(lockKey);
        setBusyKeys((current) => {
          const next = new Set(current);
          next.delete(lockKey);
          return next;
        });
      });
    mutationLocks.current.set(lockKey, promise);
    return promise;
  }, [client, refresh]);

  const currentDetail = stateOwner === ownerUserId ? detail : undefined;
  const currentList = stateOwner === ownerUserId ? list : undefined;
  const currentSelected = stateOwner === ownerUserId ? selectedPortfolioId : undefined;
  const currentError = errorOwner === ownerUserId ? error : undefined;
  const currentPhase = stateOwner === ownerUserId || errorOwner === ownerUserId ? phase : "loading";
  const revision = currentDetail ? {
    expectedPortfolioRevision: currentDetail.portfolio.revision,
    expectedLedgerEpoch: currentDetail.portfolio.currentEpoch
  } : undefined;
  const lockKey = currentDetail ? `portfolio:${currentDetail.portfolio.id}` : "portfolio:none";

  return useMemo(() => ({
    phase: currentPhase,
    list: currentList,
    detail: currentDetail,
    selectedPortfolioId: currentSelected,
    stale: stateOwner === ownerUserId && stale,
    error: currentError,
    busyKeys: stateOwner === ownerUserId ? busyKeys : emptyBusyKeys,
    refresh,
    selectPortfolio,
    createPortfolio: (name: string, initialCapital: PaperMoney) => runMutation(
      "portfolio:create",
      (signal, idempotencyKey) => client.create(ownerUserId, { name, initialCapital }, { signal, idempotencyKey }),
      true
    ),
    renamePortfolio: (name: string) => revision && currentDetail
      ? runMutation(lockKey, (signal, idempotencyKey) => client.rename(ownerUserId, currentDetail.portfolio.id, { ...revision, name }, { signal, idempotencyKey }))
      : Promise.resolve(undefined),
    setDefaultPortfolio: () => revision && currentDetail
      ? runMutation(lockKey, (signal, idempotencyKey) => client.setDefault(ownerUserId, currentDetail.portfolio.id, revision, { signal, idempotencyKey }))
      : Promise.resolve(undefined),
    archivePortfolio: (confirmName: string) => revision && currentDetail
      ? runMutation(lockKey, (signal, idempotencyKey) => client.archive(ownerUserId, currentDetail.portfolio.id, { ...revision, confirmName }, { signal, idempotencyKey }))
      : Promise.resolve(undefined),
    resetPortfolio: (confirmName: string, initialCapital?: PaperMoney) => revision && currentDetail
      ? runMutation(lockKey, (signal, idempotencyKey) => client.reset(ownerUserId, currentDetail.portfolio.id, { ...revision, confirmName, initialCapital }, { signal, idempotencyKey }))
      : Promise.resolve(undefined),
    runRobotAction: (robot: PaperRobotProjection, action: PaperRobotAction) => revision && currentDetail
      ? runMutation(lockKey, (signal, idempotencyKey) => client.robotAction(ownerUserId, currentDetail.portfolio.id, robot.botId, {
        ...revision,
        expectedBotRevision: robot.botRevision,
        action
      }, { signal, idempotencyKey }))
      : Promise.resolve(undefined)
  }), [
    busyKeys, client, currentDetail, currentError, currentList, currentPhase, currentSelected, lockKey, ownerUserId, refresh,
    revision, runMutation, selectPortfolio, stale, stateOwner
  ]);
}

function choosePortfolio(list: PaperPortfolioListResponse, requested?: string): string | undefined {
  if (requested && list.portfolios.some((portfolio) => portfolio.id === requested)) return requested;
  return list.portfolios.find((portfolio) => portfolio.status === "active" && portfolio.isDefault)?.id
    ?? list.portfolios.find((portfolio) => portfolio.status === "active")?.id
    ?? list.portfolios[0]?.id;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isAbort(value: unknown): boolean {
  return typeof value === "object" && value !== null && "name" in value && value.name === "AbortError";
}
