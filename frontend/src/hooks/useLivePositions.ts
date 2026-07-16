import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthRoot";
import type { ChartLivePosition } from "../chart/types";
import { checkAuth, getLive, getToken, listBots, type TradingBot } from "../trading/tradeClient";
import { resolveTradingRuntime } from "../trading/runtimeProfile";

export interface UseLivePositionsOptions {
  enabled?: boolean;
}

/**
 * Poll running bots' open positions for `symbol` so the chart can draw live entry
 * lines. No-op (returns []) unless a trade token is stored, so the public chart
 * doesn't hit the authenticated trade API for nothing.
 */
export function useLivePositions(symbol: string, options: UseLivePositionsOptions = {}): ChartLivePosition[] {
  const accountAuth = useAuth();
  const [positions, setPositions] = useState<ChartLivePosition[]>([]);
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) {
      setPositions((current) => (current.length === 0 ? current : []));
      return;
    }
    const canReadTrading = accountAuth.authRequired ? accountAuth.tradingAvailable : Boolean(getToken());
    if (!canReadTrading) {
      setPositions((current) => (current.length === 0 ? current : []));
      return;
    }
    let alive = true;
    const poll = async () => {
      try {
        const auth = await checkAuth(undefined, !accountAuth.authRequired);
        if (!alive) return;
        const runtime = resolveTradingRuntime(auth);
        const bots = await listBots();
        if (!alive) return;
        const running = readableRunningBots(bots, symbol, runtime.paperOnly);
        const states = await Promise.all(running.map((bot) => getLive(bot.id).catch(() => null)));
        if (!alive) return;
        const next: ChartLivePosition[] = [];
        for (const state of states) {
          const pos = state?.position;
          if (pos) next.push({ side: pos.side, qty: pos.qty, entryPrice: pos.entryPrice });
        }
        setPositions(next);
      } catch {
        if (alive) setPositions([]);
      }
    };
    void poll();
    const timer = window.setInterval(poll, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [accountAuth.authRequired, accountAuth.tradingAvailable, enabled, symbol]);

  return positions;
}

export function readableRunningBots(bots: TradingBot[], symbol: string, paperOnly: boolean): TradingBot[] {
  return bots.filter((bot) => bot.status === "running" && bot.symbol === symbol && (!paperOnly || bot.exchange === "paper"));
}
