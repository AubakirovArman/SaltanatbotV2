import { useCallback, useEffect, useRef, useState } from "react";
import { createArbitrageSocket, fetchArbitrageScan, parseArbitrageStreamMessage, type ArbitrageScanResponse } from "./client";
import { fetchVenueClockHealth, type VenueClockHealth } from "./clockHealth";

export type ArbitrageConnection = "connecting" | "live" | "fallback" | "paused";

/** Resilient same-origin stream with exponential reconnect and REST fallback. */
export function useArbitrageStream() {
  const [scan, setScan] = useState<ArbitrageScanResponse>();
  const [connection, setConnection] = useState<ArbitrageConnection>("connecting");
  const [error, setError] = useState(false);
  const [clockHealth, setClockHealth] = useState<VenueClockHealth>();
  const [clockError, setClockError] = useState(false);
  const socketRef = useRef<WebSocket>();
  const retryRef = useRef(0);
  const connectionRef = useRef<ArbitrageConnection>("connecting");
  const updateConnection = (value: ArbitrageConnection) => {
    connectionRef.current = value;
    setConnection(value);
  };

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      setScan(await fetchArbitrageScan(0, signal));
      setError(false);
    } catch {
      if (!signal?.aborted) setError(true);
    }
  }, []);

  const refreshClock = useCallback(async (signal?: AbortSignal) => {
    try {
      setClockHealth(await fetchVenueClockHealth(signal));
      setClockError(false);
    } catch {
      if (!signal?.aborted) setClockError(true);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let retryTimer: number | undefined;
    let fallbackTimer: number | undefined;

    const clearSocket = () => {
      socketRef.current?.close();
      socketRef.current = undefined;
    };
    const schedule = () => {
      if (disposed || document.visibilityState !== "visible") return;
      const delay = Math.min(15_000, 750 * 2 ** retryRef.current++);
      retryTimer = window.setTimeout(connect, delay);
    };
    const connect = () => {
      if (disposed || document.visibilityState !== "visible") return;
      clearSocket();
      updateConnection("connecting");
      const socket = createArbitrageSocket();
      socketRef.current = socket;
      socket.onopen = () => {
        retryRef.current = 0;
        updateConnection("live");
        setError(false);
      };
      socket.onmessage = (event) => {
        try {
          const message = parseArbitrageStreamMessage(JSON.parse(String(event.data)));
          if (message.type === "snapshot") {
            setScan(message.data);
            setError(false);
          } else setError(true);
        } catch {
          setError(true);
        }
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (!disposed) {
          updateConnection("fallback");
          schedule();
        }
      };
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        clearSocket();
        updateConnection("paused");
      } else {
        retryRef.current = 0;
        connect();
        void refresh();
      }
    };
    fallbackTimer = window.setInterval(() => {
      if (connectionRef.current !== "live" && document.visibilityState === "visible") void refresh();
    }, 10_000);
    document.addEventListener("visibilitychange", onVisibility);
    void refresh();
    connect();
    return () => {
      disposed = true;
      clearSocket();
      document.removeEventListener("visibilitychange", onVisibility);
      if (retryTimer) window.clearTimeout(retryTimer);
      if (fallbackTimer) window.clearInterval(fallbackTimer);
    };
  }, [refresh]);

  useEffect(() => {
    let controller: AbortController | undefined;
    const update = () => {
      if (document.visibilityState !== "visible") return;
      controller?.abort();
      controller = new AbortController();
      void refreshClock(controller.signal);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") controller?.abort();
      else update();
    };
    update();
    const timer = window.setInterval(update, 30_000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshClock]);

  return { scan, connection, error, refresh, clockHealth, clockError, refreshClock };
}
