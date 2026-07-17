import { useCallback, useEffect, useRef, useState } from "react";
import { getPaperPortfolio, listPaperPortfolios } from "./paperPortfolioClient";
import type { PaperPortfolioDetail, PaperPortfolioMetadata } from "./paperPortfolioTypes";

export interface PaperBotBindingState {
  activePortfolios: PaperPortfolioMetadata[];
  selectedPortfolioId?: string;
  detail?: PaperPortfolioDetail;
  loading: boolean;
  error?: Error;
  selectPortfolio: (portfolioId: string) => void;
  refresh: () => Promise<void>;
}

export function usePaperBotBinding({
  ownerUserId,
  enabled,
  loadPortfolios = listPaperPortfolios,
  loadPortfolio = getPaperPortfolio
}: {
  ownerUserId?: string;
  enabled: boolean;
  loadPortfolios?: typeof listPaperPortfolios;
  loadPortfolio?: typeof getPaperPortfolio;
}): PaperBotBindingState {
  const [dataOwner, setDataOwner] = useState<string>();
  const [activePortfolios, setActivePortfolios] = useState<PaperPortfolioMetadata[]>([]);
  const [selectedPortfolioId, setSelectedPortfolioId] = useState<string>();
  const [detail, setDetail] = useState<PaperPortfolioDetail>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error>();
  const [errorOwner, setErrorOwner] = useState<string>();
  const request = useRef(0);
  const abort = useRef<AbortController>();
  const requestedPortfolioId = useRef<string>();

  const clear = useCallback(() => {
    request.current += 1;
    abort.current?.abort();
    abort.current = undefined;
    requestedPortfolioId.current = undefined;
    setDataOwner(undefined);
    setActivePortfolios([]);
    setSelectedPortfolioId(undefined);
    setDetail(undefined);
    setLoading(false);
    setError(undefined);
    setErrorOwner(undefined);
  }, []);

  const load = useCallback(async (preferredPortfolioId?: string) => {
    if (!enabled || !ownerUserId) return;
    const current = ++request.current;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError(undefined);
    setErrorOwner(undefined);
    try {
      const list = await loadPortfolios(ownerUserId, controller.signal);
      const active = list.portfolios.filter((portfolio) => portfolio.status === "active");
      if (preferredPortfolioId && !active.some((portfolio) => portfolio.id === preferredPortfolioId)) {
        const preferred = list.portfolios.find((portfolio) => portfolio.id === preferredPortfolioId);
        if (preferred?.status === "archived") throw new Error("Selected paper portfolio is archived");
        throw new Error("Selected paper portfolio is unavailable");
      }
      const selected = active.find((portfolio) => portfolio.id === preferredPortfolioId)?.id
        ?? active.find((portfolio) => portfolio.isDefault)?.id
        ?? active[0]?.id;
      const nextDetail = selected ? await loadPortfolio(ownerUserId, selected, controller.signal) : undefined;
      if (controller.signal.aborted || current !== request.current) return;
      if (nextDetail?.portfolio.status === "archived") throw new Error("Selected paper portfolio is archived");
      requestedPortfolioId.current = selected;
      setDataOwner(ownerUserId);
      setActivePortfolios(active);
      setSelectedPortfolioId(selected);
      setDetail(nextDetail);
      setError(undefined);
      setErrorOwner(undefined);
    } catch (cause) {
      if (controller.signal.aborted || current !== request.current || isAbort(cause)) return;
      setError(cause instanceof Error ? cause : new Error(String(cause)));
      setErrorOwner(ownerUserId);
    } finally {
      if (current === request.current) setLoading(false);
      if (abort.current === controller) abort.current = undefined;
    }
  }, [enabled, loadPortfolio, loadPortfolios, ownerUserId]);

  useEffect(() => {
    clear();
    if (enabled && ownerUserId) void load();
    return clear;
  }, [clear, enabled, load, ownerUserId]);

  const selectPortfolio = useCallback((portfolioId: string) => {
    const selected = portfolioId.trim();
    if (!selected || selected === requestedPortfolioId.current) return;
    requestedPortfolioId.current = selected;
    setSelectedPortfolioId(selected);
    setDetail(undefined);
    void load(selected);
  }, [load]);

  const currentOwner = dataOwner === ownerUserId;
  const currentError = errorOwner === ownerUserId ? error : undefined;
  const selectedDetail = currentOwner && detail?.portfolio.id === selectedPortfolioId ? detail : undefined;
  return {
    activePortfolios: currentOwner ? activePortfolios : [],
    selectedPortfolioId: currentOwner ? selectedPortfolioId : undefined,
    detail: selectedDetail,
    loading: enabled && !!ownerUserId && (loading || !currentOwner && !currentError),
    error: currentError,
    selectPortfolio,
    refresh: () => load(requestedPortfolioId.current)
  };
}

function isAbort(value: unknown): boolean {
  return typeof value === "object" && value !== null && "name" in value && value.name === "AbortError";
}
