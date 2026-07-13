import { WebSocket, type WebSocketServer } from "ws";
import type { ArbitrageScannerService } from "./service.js";

const SCAN_OPTIONS = { estimatedTotalCostBps: 0, minSpreadBps: -1_000, limit: 500 } as const;

/** Shares one bounded market scan across all connected read-only browser clients. */
export class ArbitrageStreamHub {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly wss: WebSocketServer, private readonly scanner: ArbitrageScannerService, private readonly intervalMs = 2_000) {
    wss.on("connection", (socket) => {
      socket.on("close", () => this.stopIfIdle());
      void this.broadcast();
      this.start();
    });
  }

  close() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  private start() {
    this.timer ??= setInterval(() => { void this.broadcast(); }, this.intervalMs);
  }

  private stopIfIdle() {
    if (this.wss.clients.size > 0 || !this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async broadcast() {
    if (this.running || this.wss.clients.size === 0) return;
    this.running = true;
    try {
      const data = await this.scanner.scan(SCAN_OPTIONS);
      this.send({ type: "arbitrage_snapshot", data, ts: Date.now() });
    } catch (error) {
      this.send({ type: "arbitrage_error", message: error instanceof Error ? error.message : "Arbitrage stream unavailable", ts: Date.now() });
    } finally { this.running = false; }
  }

  private send(message: unknown) {
    const payload = JSON.stringify(message);
    for (const socket of this.wss.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (socket.bufferedAmount > 512 * 1024) { socket.close(1013, "Arbitrage client is too slow"); continue; }
      socket.send(payload);
    }
  }
}
