import type { ArbitrageScanResponse } from "./types.js";
import { insertArbitrageHistory, pruneArbitrageHistory } from "../trading/store.js";

const SAMPLE_MS = 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Persists a bounded minute-resolution series for the best research routes. */
export class ArbitrageHistoryRecorder {
  private lastSample = 0;
  private lastPrune = 0;

  record(scan: ArbitrageScanResponse, now = Date.now()) {
    if (now - this.lastSample < SAMPLE_MS) return;
    this.lastSample = now;
    const rows = scan.opportunities
      .filter((row) => row.dataQuality === "fresh" && routeSourcesHealthy(scan, row) && Number.isFinite(row.grossSpreadBps) && Number.isFinite(row.topBookCapacityUsd))
      .slice(0, 50);
    if (rows.length) insertArbitrageHistory(rows, now);
    if (now - this.lastPrune >= 60 * 60_000) {
      this.lastPrune = now;
      pruneArbitrageHistory(now - RETENTION_MS);
    }
  }
}

function routeSourcesHealthy(scan: ArbitrageScanResponse, row: ArbitrageScanResponse["opportunities"][number]) {
  return scan.sources.some((source) => source.exchange === row.spotExchange && source.market === "spot" && source.ok) && scan.sources.some((source) => source.exchange === row.futuresExchange && source.market === "perpetual" && source.ok);
}
