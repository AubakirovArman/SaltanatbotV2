import WebSocket from "ws";
import { ContinuousPublicFeed } from "../backend/src/arbitrage/upstream/publicFeeds/feed.js";
import type { ContinuousFundingObservation, ContinuousPublicBook } from "../backend/src/arbitrage/upstream/publicFeeds/types.js";
import { failedPublicFeedCanaryTarget, publicBookContinuityProtocol, publicFeedCanaryOutput, requiredPublicEvidenceObserved, publicBookIntegrity, successfulPublicFeedCanaryTarget, type PublicFeedCanaryObservation, type PublicFeedCanaryVenueResult } from "./lib/public-feed-canary.js";
import { PUBLIC_FEED_CANARY_SPECS, type LivePublicFeedCanarySpec } from "./lib/public-feed-canary-targets.js";

const startedAt = Date.now();
const timeoutMs = boundedTimeout(process.env.PUBLIC_FEED_CANARY_TIMEOUT_MS);
const specs = PUBLIC_FEED_CANARY_SPECS;

const feeds: ContinuousPublicFeed[] = [];
const venues = await Promise.all(specs.map((spec) => runInstrument(spec)));
for (const feed of feeds) feed.close();

const output = publicFeedCanaryOutput({ startedAt, finishedAt: Date.now(), timeoutMs, venues });
console.log(JSON.stringify(output, null, 2));
if (!output.ok) process.exitCode = 1;

function runInstrument(spec: LivePublicFeedCanarySpec): Promise<PublicFeedCanaryVenueResult> {
  const observation: PublicFeedCanaryObservation = { book: false, funding: false, bookIntegrity: "none", continuityProtocol: "none" };
  return new Promise((resolve) => {
    let feed: ContinuousPublicFeed | undefined;
    let book: ContinuousPublicBook | undefined;
    let funding: ContinuousFundingObservation | undefined;
    let settled = false;
    let lastStatus = "created";
    const trace: string[] = [];
    const finish = (result: PublicFeedCanaryVenueResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      feed?.close();
      resolve(result);
    };
    const succeedIfComplete = () => {
      if (!book || !requiredPublicEvidenceObserved(spec.target, observation)) return;
      finish(successfulPublicFeedCanaryTarget(spec.target, observation, bookEvidence(book), funding ? fundingEvidence(funding) : undefined));
    };
    const timer = setTimeout(() => finish(failedPublicFeedCanaryTarget(spec.target, observation, `timed out after ${timeoutMs}ms; last status: ${lastStatus}; trace: ${trace.join(" | ")}`)), timeoutMs);
    try {
      feed = new ContinuousPublicFeed(
        spec.instrument,
        {
          onBook: (value) => {
            book = value;
            observation.book = true;
            observation.bookIntegrity = publicBookIntegrity(value as unknown as Record<string, unknown>);
            observation.continuityProtocol = publicBookContinuityProtocol(value as unknown as Record<string, unknown>);
            succeedIfComplete();
          },
          onTopBook: () => undefined,
          onFunding: (value) => {
            funding = value;
            observation.funding = true;
            succeedIfComplete();
          },
          onInvalidate: (reason) => {
            lastStatus = `invalidated: ${reason}`;
            remember(trace, lastStatus);
          },
          onStatus: (status) => {
            lastStatus = `${status.state}: ${status.message}`;
            remember(trace, lastStatus);
          }
        },
        spec.socketUrl ? { createSocket: () => new WebSocket(spec.socketUrl!, { maxPayload: 2 * 1024 * 1024 }) } : {}
      );
      feeds.push(feed);
      feed.start();
    } catch (error) {
      finish(failedPublicFeedCanaryTarget(spec.target, observation, error));
    }
  });
}

function bookEvidence(book: ContinuousPublicBook): Record<string, unknown> {
  return {
    receivedAt: book.receivedAt,
    exchangeTs: book.exchangeTs,
    bestBid: book.bids[0]?.[0],
    bestAsk: book.asks[0]?.[0],
    continuity: book.continuity,
    generation: book.connectionGeneration
  };
}

function fundingEvidence(funding: ContinuousFundingObservation): Record<string, unknown> {
  return {
    receivedAt: funding.receivedAt,
    currentEstimateRate: funding.currentEstimateRate,
    scheduleVerified: funding.scheduleVerified,
    exchangeTimestampVerified: funding.exchangeTimestampVerified,
    generation: funding.connectionGeneration
  };
}

function boundedTimeout(value: string | undefined) {
  const parsed = value === undefined ? 20_000 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 5_000 || parsed > 60_000) throw new Error("PUBLIC_FEED_CANARY_TIMEOUT_MS must be an integer from 5000 to 60000");
  return parsed;
}

function remember(trace: string[], value: string) {
  trace.push(value.replaceAll(/\s+/g, " ").slice(0, 240));
  if (trace.length > 12) trace.shift();
}
