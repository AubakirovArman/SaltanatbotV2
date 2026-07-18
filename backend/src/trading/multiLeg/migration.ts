import { PAPER_MONEY_MICROS_MAX } from "../paperPortfolioMigration.js";

/**
 * SQLite v10 adds owner-scoped durable multi-leg paper intents inside the
 * versioned trading store. Additive DDL only: v1..v9 objects are untouched and
 * the isolated legacy arbitrage paper multi-leg store keeps its own database.
 */
export const PAPER_MULTI_LEG_SCHEMA_V10_SQL = `
  CREATE TABLE paper_multi_leg_intents (
    intentId TEXT PRIMARY KEY CHECK (length(trim(intentId)) BETWEEN 1 AND 200),
    ownerUserId TEXT NOT NULL CHECK (length(trim(ownerUserId)) BETWEEN 1 AND 160),
    portfolioId TEXT NOT NULL CHECK (length(trim(portfolioId)) BETWEEN 1 AND 200),
    portfolioEpoch INTEGER NOT NULL CHECK (portfolioEpoch > 0),
    planJson TEXT NOT NULL,
    planHash TEXT NOT NULL CHECK (length(planHash) = 64),
    sourceEngine TEXT NOT NULL CHECK (sourceEngine IN ('n-leg-v1', 'route-families-v1')),
    sourceOpportunityId TEXT NOT NULL CHECK (length(sourceOpportunityId) BETWEEN 1 AND 16384),
    sourceEvaluatedAt INTEGER NOT NULL CHECK (sourceEvaluatedAt > 0),
    status TEXT NOT NULL CHECK (status IN ('running', 'terminal')),
    terminalOutcome TEXT CHECK (
      terminalOutcome IS NULL
      OR terminalOutcome IN ('completed', 'compensated', 'aborted-no-exposure', 'manual-review-required')
    ),
    reservedCapitalMicros INTEGER NOT NULL
      CHECK (reservedCapitalMicros BETWEEN 1 AND ${PAPER_MONEY_MICROS_MAX}),
    netPnlMicros INTEGER,
    feesMicros INTEGER CHECK (feesMicros IS NULL OR feesMicros >= 0),
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );
  CREATE INDEX idx_paper_multi_leg_intents_owner_created
    ON paper_multi_leg_intents(ownerUserId, createdAt DESC);
  CREATE INDEX idx_paper_multi_leg_intents_portfolio_status
    ON paper_multi_leg_intents(portfolioId, status);

  CREATE TABLE paper_multi_leg_intent_events (
    intentId TEXT NOT NULL CHECK (length(trim(intentId)) BETWEEN 1 AND 200),
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    eventJson TEXT NOT NULL,
    idempotencyKey TEXT NOT NULL UNIQUE CHECK (length(trim(idempotencyKey)) BETWEEN 1 AND 200),
    ts INTEGER NOT NULL,
    PRIMARY KEY (intentId, sequence)
  );
  CREATE TRIGGER paper_multi_leg_intent_events_no_update BEFORE UPDATE ON paper_multi_leg_intent_events BEGIN
    SELECT RAISE(ABORT, 'paper_multi_leg_intent_events is append-only');
  END;
  CREATE TRIGGER paper_multi_leg_intent_events_no_delete BEFORE DELETE ON paper_multi_leg_intent_events BEGIN
    SELECT RAISE(ABORT, 'paper_multi_leg_intent_events is append-only');
  END;
`;
