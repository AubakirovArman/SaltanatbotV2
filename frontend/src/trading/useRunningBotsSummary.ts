import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthRoot";
import { RUNNING_BOTS_CHANGED_EVENT, TRADING_SESSION_CHANGED_EVENT } from "./sessionEvents";
import { checkAuth, listBots } from "./tradeClient";
import { resolveTradingRuntime } from "./runtimeProfile";

export type RunningBotsSummaryStatus = "loading" | "ready" | "locked" | "error";

export interface RunningBotsSummary {
  count?: number;
  paperOnly?: boolean;
  status: RunningBotsSummaryStatus;
  refresh: () => void;
}

/**
 * Keeps the globally visible robot count current. The public auth probe runs
 * first, so the protected bot list is requested only for an active session.
 */
export function useRunningBotsSummary(): RunningBotsSummary {
  const accountAuth = useAuth();
  const [count, setCount] = useState<number>();
  const [paperOnly, setPaperOnly] = useState<boolean>();
  const [status, setStatus] = useState<RunningBotsSummaryStatus>("loading");
  const mounted = useRef(true);
  const inFlight = useRef(false);

  const refresh = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    void Promise.resolve()
      .then(async () => {
        if (accountAuth.authRequired && !accountAuth.tradingAvailable) {
          if (mounted.current) {
            setCount(undefined);
            setPaperOnly(undefined);
            setStatus("locked");
          }
          return;
        }
        const auth = await checkAuth(undefined, !accountAuth.authRequired);
        if (!mounted.current) return;
        const runtime = resolveTradingRuntime(auth);
        setPaperOnly(runtime.paperOnly);
        if (!auth.ok) {
          setCount(undefined);
          setStatus("locked");
          return;
        }
        const bots = await listBots();
        if (!mounted.current) return;
        setCount(bots.filter((bot) => bot.status === "running" && (!runtime.paperOnly || bot.exchange === "paper")).length);
        setStatus("ready");
      })
      .catch(() => {
        if (!mounted.current) return;
        setStatus("error");
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, [accountAuth.authRequired, accountAuth.tradingAvailable]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const onRefresh = () => refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, 15_000);
    window.addEventListener("focus", onRefresh);
    window.addEventListener(TRADING_SESSION_CHANGED_EVENT, onRefresh);
    window.addEventListener(RUNNING_BOTS_CHANGED_EVENT, onRefresh);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onRefresh);
      window.removeEventListener(TRADING_SESSION_CHANGED_EVENT, onRefresh);
      window.removeEventListener(RUNNING_BOTS_CHANGED_EVENT, onRefresh);
    };
  }, [refresh]);

  return { count, paperOnly, status, refresh };
}
