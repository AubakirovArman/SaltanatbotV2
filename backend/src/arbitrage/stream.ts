import { WebSocket, type WebSocketServer } from "ws";
import { refreshOpportunityQuality, sortOpportunities, type ArbitrageClockCalibration, type ArbitrageScannerService } from "./service.js";
import type { ArbitrageOpportunity, ArbitrageScanResponse, ArbitrageSourceStatus } from "./types.js";
import { ArbitrageUpstream } from "./upstream/index.js";
import type { ArbitrageTickerUpdate, ArbitrageUpstreamStatus } from "./upstream/types.js";
import { ArbitrageRouteDependencyIndex } from "./routeDependencyIndex.js";

const SCAN_OPTIONS = { estimatedTotalCostBps: 0, minSpreadBps: -1_000, limit: 10_000, sort: "expected-profit" } as const;
const MAX_SANE_ABSOLUTE_SPREAD_BPS = 2_000;
const MAX_PUBLIC_STREAM_ROWS = 250;
export const ARBITRAGE_CLIENT_BUFFER_LIMIT_BYTES = 512 * 1024;

/** Shared REST-bootstrap + direct exchange WebSocket aggregation for read-only browser clients. */
export class ArbitrageStreamHub {
  private readonly upstream: ArbitrageUpstream;
  private readonly listeners = new Set<(scan: ArbitrageScanResponse) => void>();
  private readonly routes = new Map<string, ArbitrageOpportunity>();
  private readonly dependencies = new ArbitrageRouteDependencyIndex();
  private sources: ArbitrageSourceStatus[] = [];
  private identityCoverage?: ArbitrageScanResponse["identityCoverage"];
  private scan?: ArbitrageScanResponse;
  private refreshTimer?: NodeJS.Timeout;
  private broadcastTimer?: NodeJS.Timeout;
  private qualityTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private bootstrap?: Promise<void>;
  private backgroundActive = false;

  constructor(
    private readonly wss: WebSocketServer,
    private readonly scanner: ArbitrageScannerService,
    private readonly refreshMs = 30_000,
    private readonly clockCalibration?: Pick<ArbitrageClockCalibration, "assessTimestamp" | "assessSkew">
  ) {
    this.upstream = new ArbitrageUpstream(
      (update) => this.onTicker(update),
      (status) => this.onStatus(status)
    );
    wss.on("connection", (socket) => {
      socket.on("close", () => this.stopIfIdle());
      socket.on("error", () => this.stopIfIdle());
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
      void this.start().then(() => this.sendSnapshot(socket));
    });
  }

  /** Keep market feeds active for persistent server alerts even without an open browser tab. */
  setBackgroundActive(active: boolean) {
    this.backgroundActive = active;
    if (active) void this.start();
    else this.stopIfIdle();
  }

  subscribe(listener: (scan: ArbitrageScanResponse) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  current() {
    return this.scan;
  }

  close() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    if (this.qualityTimer) clearInterval(this.qualityTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.refreshTimer = undefined;
    this.broadcastTimer = undefined;
    this.qualityTimer = undefined;
    this.idleTimer = undefined;
    this.upstream.stop();
  }

  private async start() {
    this.bootstrap ??= this.refresh().finally(() => {
      this.bootstrap = undefined;
    });
    await this.bootstrap;
    this.upstream.start();
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => {
        void this.refresh();
      }, this.refreshMs);
      this.refreshTimer.unref?.();
    }
    if (!this.qualityTimer) {
      this.qualityTimer = setInterval(() => {
        if (!this.scan) return;
        this.rebuild(this.sources.some((source) => !source.ok));
        this.scheduleBroadcast(0);
      }, 1_000);
      this.qualityTimer.unref?.();
    }
  }

  private stopIfIdle() {
    if (this.wss.clients.size > 0 || this.backgroundActive || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.wss.clients.size > 0 || this.backgroundActive) return;
      if (this.refreshTimer) clearInterval(this.refreshTimer);
      if (this.qualityTimer) clearInterval(this.qualityTimer);
      this.refreshTimer = undefined;
      this.qualityTimer = undefined;
      this.upstream.stop();
    }, 5_000);
    this.idleTimer.unref?.();
  }

  private async refresh() {
    try {
      const next = await this.scanner.scan(SCAN_OPTIONS);
      this.routes.clear();
      for (const row of next.opportunities) this.routes.set(row.id, row);
      this.dependencies.replace(next.opportunities);
      this.sources = next.sources;
      this.identityCoverage = next.identityCoverage;
      this.upstream.setSymbols(new Set(next.opportunities.map((row) => row.symbol)));
      this.rebuild(next.stale);
      this.scheduleBroadcast(0);
    } catch (error) {
      this.send({ type: "arbitrage_error", message: error instanceof Error ? error.message : "Arbitrage stream unavailable", ts: Date.now() });
    }
  }

  private onTicker(update: ArbitrageTickerUpdate) {
    let changed = false;
    for (const id of this.dependencies.idsFor(update)) {
      const current = this.routes.get(id);
      if (!current) continue;
      let row = current;
      if (update.market === "spot" && current.spotExchange === update.exchange && current.symbol === update.symbol) {
        row = {
          ...row,
          spotBid: update.bid,
          spotAsk: update.ask,
          spotAskSize: update.askSize,
          spotExchangeTs: update.exchangeTs,
          spotExchangeTimestampVerified: update.exchangeTimestampVerified,
          spotReceivedAt: update.receivedAt
        };
      } else if (update.market === "perpetual" && current.futuresExchange === update.exchange && current.symbol === update.symbol) {
        row = {
          ...row,
          futuresBid: update.bid,
          futuresAsk: update.ask,
          futuresBidSize: update.bidSize,
          fundingRate: update.fundingRate ?? row.fundingRate,
          nextFundingTime: update.nextFundingTime ?? row.nextFundingTime,
          fundingIntervalMinutes: update.fundingIntervalMinutes ?? row.fundingIntervalMinutes,
          fundingScheduleVerified: update.fundingIntervalMinutes !== undefined || row.fundingScheduleVerified,
          futuresExchangeTs: update.exchangeTs,
          futuresExchangeTimestampVerified: update.exchangeTimestampVerified,
          futuresReceivedAt: update.receivedAt
        };
      } else continue;
      const grossSpreadBps = ((row.futuresBid - row.spotAsk) / row.spotAsk) * 10_000;
      if (!Number.isFinite(grossSpreadBps) || Math.abs(grossSpreadBps) > MAX_SANE_ABSOLUTE_SPREAD_BPS) continue;
      const topBookMatchedQuantity = Math.min(row.spotAskSize, row.futuresBidSize);
      const topBookCapacityUsd = topBookMatchedQuantity * row.spotAsk;
      const netEdgeBps = grossSpreadBps - row.estimatedTotalCostBps;
      this.routes.set(
        id,
        refreshOpportunityQuality(
          {
            ...row,
            grossSpreadBps,
            netEdgeBps,
            topBookMatchedQuantity,
            topBookCapacityUsd,
            expectedNetProfitUsd: (topBookCapacityUsd * netEdgeBps) / 10_000
          },
          update.receivedAt,
          this.clockCalibration
        )
      );
      changed = true;
    }
    if (changed) {
      this.scheduleBroadcast();
    }
  }

  private onStatus(status: ArbitrageUpstreamStatus) {
    const index = this.sources.findIndex((source) => source.exchange === status.exchange && source.market === status.market);
    const next = { exchange: status.exchange, market: status.market, ok: status.ok, ...(status.message ? { message: status.message } : {}) };
    if (index >= 0) this.sources[index] = next;
    else this.sources.push(next);
    if (this.scan) {
      this.scan = { ...this.scan, sources: [...this.sources], stale: this.sources.some((source) => !source.ok) };
      this.scheduleBroadcast();
    }
  }

  private rebuild(stale: boolean) {
    const now = Date.now();
    const all = [...this.routes.entries()].map(([id, row]) => {
      const refreshed = refreshOpportunityQuality(row, now, this.clockCalibration);
      this.routes.set(id, refreshed);
      return refreshed;
    });
    // Keep degraded discovery rows visible with their explicit quality state.
    // Consumers that can cause side effects (alerts/paper/live) fail closed on
    // anything other than `fresh` in their own boundary.
    const opportunities = sortOpportunities(all, "expected-profit");
    this.scan = {
      updatedAt: now,
      stale: stale || opportunities.length < all.length,
      scannedSymbols: new Set(opportunities.map((row) => row.symbol)).size,
      totalOpportunities: opportunities.length,
      truncated: false,
      estimatedTotalCostBps: 0,
      opportunities,
      sources: [...this.sources],
      ...(this.identityCoverage ? { identityCoverage: this.identityCoverage } : {})
    };
  }

  private scheduleBroadcast(delay = 1_000) {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = undefined;
      if (!this.scan) return;
      this.rebuild(this.sources.some((source) => !source.ok));
      this.send({ type: "arbitrage_snapshot", data: capArbitrageStreamSnapshot(this.scan), ts: Date.now() });
      for (const listener of this.listeners) listener(this.scan);
    }, delay);
    this.broadcastTimer.unref?.();
  }

  private sendSnapshot(socket: WebSocket) {
    if (!this.scan || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "arbitrage_snapshot", data: capArbitrageStreamSnapshot(this.scan), ts: Date.now() }));
  }

  private send(message: unknown) {
    const payload = JSON.stringify(message);
    for (const socket of this.wss.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (shouldDisconnectSlowArbitrageClient(socket.bufferedAmount)) {
        socket.close(1013, "Arbitrage client is too slow");
        continue;
      }
      socket.send(payload);
    }
  }
}

export function capArbitrageStreamSnapshot(scan: ArbitrageScanResponse, limit = MAX_PUBLIC_STREAM_ROWS): ArbitrageScanResponse {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("arbitrage stream limit must be a positive integer");
  if (scan.opportunities.length <= limit) return scan;
  return { ...scan, truncated: true, opportunities: scan.opportunities.slice(0, limit) };
}

export function shouldDisconnectSlowArbitrageClient(bufferedAmount: number) {
  return !Number.isFinite(bufferedAmount) || bufferedAmount > ARBITRAGE_CLIENT_BUFFER_LIMIT_BYTES;
}
