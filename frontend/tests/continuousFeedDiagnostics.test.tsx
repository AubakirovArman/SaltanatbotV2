// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContinuousFeedDiagnostics } from "../src/arbitrage/ContinuousFeedDiagnostics";
import type { ContinuousFeedHealthResponse } from "../src/arbitrage/continuousFeedHealth";

describe("ContinuousFeedDiagnostics", () => {
  it("renders reconnect, generation, checksum, and last-receive evidence in Russian", () => {
    const html = renderToStaticMarkup(<ContinuousFeedDiagnostics locale="ru" snapshot={fixture()} />);

    expect(html).toContain("Диагностика непрерывных WebSocket-потоков");
    expect(html).toContain("переподключение запланировано");
    expect(html).toContain("зафиксировано перезапусков: 3");
    expect(html).toContain("kraken-spot-crc32");
    expect(html).toContain("последовательность 9");
    expect(html).toContain("контрольная сумма 61453");
    expect(html).toContain("поколения не совпадают");
    expect(html).toContain("не готов");
    expect(html).not.toContain("Выставить ордер");
    expect(html).not.toContain("Перезапустить поток");
  });

  it("explains an empty server-owned universe in Kazakh", () => {
    const value = fixture();
    value.state = "idle";
    value.counts = { streams: 0, healthy: 0, reconnecting: 0, bookContinuityReady: 0 };
    value.sources = [];
    const html = renderToStaticMarkup(<ContinuousFeedDiagnostics locale="kk" snapshot={value} />);

    expect(html).toContain("Үздіксіз WebSocket ағындарының диагностикасы");
    expect(html).toContain("Оператор баптаған белсенді үздіксіз ағын жоқ");
  });
});

function fixture(): ContinuousFeedHealthResponse {
  return {
    schemaVersion: 1,
    engine: "continuous-feed-health-v1",
    readOnly: true,
    dataScope: "public-market-data",
    credentialsRequired: false,
    secretsIncluded: false,
    executionStatus: "not-supported",
    executable: false,
    capturedAt: 10_000,
    maxReceiveAgeMs: 1_000,
    state: "degraded",
    counts: { streams: 1, healthy: 0, reconnecting: 1, bookContinuityReady: 0 },
    sources: [
      {
        venue: "kraken",
        instrumentId: "kraken:spot:BTC/USD",
        marketType: "spot",
        state: "reconnecting",
        health: "degraded",
        generation: 4,
        reconnect: { scheduled: true, observedConnectionRestarts: 3 },
        lastReceive: { at: 9_925, ageMs: 75, kind: "book", connectionGeneration: 3, currentGeneration: false, fresh: false },
        continuity: { kind: "checksum-verified", protocol: "kraken-spot-crc32", verified: true, sequence: 9, checksum: 61_453, receivedAt: 9_925, ageMs: 75, fresh: false, connectionGeneration: 3, generationMatches: false },
        hasBook: true,
        hasTopBook: true,
        hasFunding: false,
        bookContinuityReady: false
      }
    ]
  };
}
