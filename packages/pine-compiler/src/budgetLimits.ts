/** Deterministic safety limits for untrusted Pine input and generated artifacts. */
export const PINE_BUDGETS = Object.freeze({
  sourceChars: 200_000,
  sourceLines: 20_000,
  tokens: 60_000,
  astNodes: 50_000,
  astNesting: 120,
  loops: 512,
  loopNesting: 16,
  generatedIrNodes: 100_000
});

export type PineBudgets = typeof PINE_BUDGETS;
