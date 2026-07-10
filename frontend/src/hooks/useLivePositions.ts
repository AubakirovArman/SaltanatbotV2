import { useEffect, useState } from "react";
import type { ChartLivePosition } from "../chart/types";
import { getLive, getToken, listBots } from "../trading/tradeClient";

/**
 * Poll running bots' open positions for `symbol` so the chart can draw live entry
 * lines. No-op (returns []) unless a trade token is stored, so the public chart
 * doesn't hit the authenticated trade API for nothing.
 */
export function useLivePositions(symbol: string): ChartLivePosition[] {
  const [positions, setPositions] = useState<ChartLivePosition[]>([]);

  useEffect(() => {
    if (!getToken()) {
      setPositions([]);
      return;
    }
    let alive = true;
    const poll = async () => {
      try {
        const bots = await listBots();
        const running = bots.filter((bot) => bot.status === "running" && bot.symbol === symbol);
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
  }, [symbol]);

  return positions;
}
