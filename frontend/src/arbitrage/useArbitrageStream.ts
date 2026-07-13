import { useCallback, useEffect, useRef, useState } from "react";
import { createArbitrageSocket, fetchArbitrageScan, parseArbitrageStreamMessage, type ArbitrageScanResponse } from "./client";

export type ArbitrageConnection = "connecting" | "live" | "fallback" | "paused";

/** Resilient same-origin stream with exponential reconnect and REST fallback. */
export function useArbitrageStream() {
  const [scan, setScan] = useState<ArbitrageScanResponse>();
  const [connection, setConnection] = useState<ArbitrageConnection>("connecting");
  const [error, setError] = useState<string>();
  const socketRef = useRef<WebSocket>();
  const retryRef = useRef(0);
  const connectionRef = useRef<ArbitrageConnection>("connecting");
  const updateConnection = (value: ArbitrageConnection) => { connectionRef.current = value; setConnection(value); };

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try { setScan(await fetchArbitrageScan(0, signal)); setError(undefined); }
    catch (cause) { if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Arbitrage market data unavailable"); }
  }, []);

  useEffect(() => {
    let disposed = false;
    let retryTimer: number | undefined;
    let fallbackTimer: number | undefined;

    const clearSocket = () => { socketRef.current?.close(); socketRef.current = undefined; };
    const schedule = () => {
      if (disposed || document.visibilityState !== "visible") return;
      const delay = Math.min(15_000, 750 * 2 ** retryRef.current++);
      retryTimer = window.setTimeout(connect, delay);
    };
    const connect = () => {
      if (disposed || document.visibilityState !== "visible") return;
      clearSocket(); updateConnection("connecting");
      const socket = createArbitrageSocket(); socketRef.current = socket;
      socket.onopen = () => { retryRef.current = 0; updateConnection("live"); setError(undefined); };
      socket.onmessage = (event) => {
        try {
          const message = parseArbitrageStreamMessage(JSON.parse(String(event.data)));
          if (message.type === "snapshot") { setScan(message.data); setError(undefined); }
          else setError(message.message);
        } catch { setError("Invalid arbitrage stream message"); }
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => { if (!disposed) { updateConnection("fallback"); schedule(); } };
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") { clearSocket(); updateConnection("paused"); }
      else { retryRef.current = 0; connect(); void refresh(); }
    };
    fallbackTimer = window.setInterval(() => { if (connectionRef.current !== "live" && document.visibilityState === "visible") void refresh(); }, 10_000);
    document.addEventListener("visibilitychange", onVisibility);
    void refresh(); connect();
    return () => {
      disposed = true; clearSocket(); document.removeEventListener("visibilitychange", onVisibility);
      if (retryTimer) window.clearTimeout(retryTimer); if (fallbackTimer) window.clearInterval(fallbackTimer);
    };
  }, [refresh]);

  return { scan, connection, error, refresh };
}
