export { canonicalJson, cloneJson, eventDigest, sha256 } from "./canonical.js";
export { createReplayManifest, replayDataset, validateReplayDataset } from "./dataset.js";
export type { ManifestInput } from "./dataset.js";
export {
  createEngineReplayManifest,
  ENGINE_REPLAY_VERSIONS,
  HARD_MAX_ENGINE_REPLAY_EVIDENCE,
  HARD_MAX_ENGINE_REPLAY_INPUT_BYTES,
  HARD_MAX_ENGINE_REPLAY_LEVELS_PER_SIDE,
  makeEngineReplayResult,
  validateEngineReplayManifest
} from "./engineManifest.js";
export type * from "./engineManifest.js";
export { replayPairwiseEvaluation, replayTriangularEvaluation } from "./routeEngineAdapters.js";
export type * from "./routeEngineAdapters.js";
export { replayNativeSpreadEvaluation, replayNLegEvaluation, replayOptionsParityEvaluation } from "./researchEngineAdapters.js";
export type * from "./researchEngineAdapters.js";
export { runHistoricalBasisBacktest } from "./basisBacktest.js";
export type {
  HistoricalBasisBacktestResult,
  HistoricalBasisRoute,
  HistoricalBasisTrade,
  HistoricalDepthLevel,
  HistoricalDepthPayload,
  HistoricalInstrumentIdentityPayload
} from "./basisBacktest.js";
export type { HistoricalFundingSettlementProvenance } from "./fundingTimeline.js";
export type * from "./types.js";
