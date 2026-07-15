import { parseLifecycleResponse, type LifecycleQuery, type LifecycleResponse } from "@saltanatbotv2/arbitrage-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

const VISIBLE_POLL_MS = 5_000;

export async function fetchOpportunityLifecycle(query: LifecycleQuery = {}, signal?: AbortSignal): Promise<LifecycleResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  const response = await fetch(`/api/arbitrage/lifecycle${params.size ? `?${params}` : ""}`, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(typeof body.error === "string" ? body.error : `Arbitrage lifecycle API ${response.status}`);
  }
  return parseLifecycleResponse(await response.json());
}

/** Polls only while the owning workspace and browser tab are visible. */
export function useOpportunityLifecycle(enabled: boolean, query: LifecycleQuery = {}) {
  const [data, setData] = useState<LifecycleResponse>();
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const request = useRef<AbortController>();
  const queryKey = JSON.stringify(query);
  const refresh = useCallback(async () => {
    if (!enabled || document.visibilityState === "hidden") return;
    const current = ++generation.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const next = await fetchOpportunityLifecycle(JSON.parse(queryKey) as LifecycleQuery, controller.signal);
      if (generation.current === current) {
        setData(next);
        setError(undefined);
      }
    } catch (reason) {
      if (!controller.signal.aborted && generation.current === current) setError(reason instanceof Error ? reason.message : "Lifecycle unavailable");
    } finally {
      if (request.current === controller) request.current = undefined;
    }
  }, [enabled, queryKey]);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const synchronize = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (document.visibilityState === "hidden") {
        generation.current += 1;
        request.current?.abort();
        return;
      }
      void refresh();
      timer = setInterval(() => void refresh(), VISIBLE_POLL_MS);
    };
    document.addEventListener("visibilitychange", synchronize);
    synchronize();
    return () => {
      generation.current += 1;
      request.current?.abort();
      document.removeEventListener("visibilitychange", synchronize);
      if (timer) clearInterval(timer);
    };
  }, [enabled, refresh]);

  return { data, error, refresh };
}
