# Order-book ML research foundation

This directory contains pure, deterministic preprocessing for research on **anonymous aggregate
liquidity behavior**. Public L2 and trade-flow data cannot identify a person, account, market maker
or other participant. The feature names and dataset provenance deliberately make no such claim.

## Input and fail-closed quality gate

`SequencedL2SnapshotV1` is stricter than the browser order-book message. It requires a reconstructed
WebSocket source, exact instrument/source provenance, a connection generation, a verified source
sequence range and the immediately preceding captured sequence. This accommodates updates that span
several source IDs while still detecting a missing capture. A new generation starts a new series.

`assessAndNormalizeSnapshotV1` rejects, rather than repairs:

- missing/unverified sequence evidence, gaps, generation switches and timestamp regressions;
- stale or future-dated input under the caller's explicit versioned quality policy;
- empty, non-positive, non-finite, duplicate, unsorted, crossed or locked books;
- input above the configured hard depth and input below the requested normalized depth.

Accepted levels are copied and truncated to the configured depth. No sorting, sign correction,
timestamp substitution or synthetic level padding is performed.

## Feature vector v1

`extractOrderBookFeaturesV1` has a fixed ordered schema and requires ten levels per side. It emits:

- mid, spread in basis points and volume-weighted microprice;
- bid/ask depth imbalance at levels 1, 5 and 10;
- normalized top-of-book order-flow imbalance between immediate neighboring snapshots;
- side concentration and price-distance slope over ten levels;
- same-price refill/depletion and new/removed-price add/cancel **approximations**;
- optional aggressive buy/sell quantities, trade imbalance and window CVD.

Refill/depletion/add/cancel are book-state differences. Without order IDs and queue events they cannot
distinguish cancellations from executions, hidden liquidity or the level-10 truncation boundary.
Aggressor side is a trade classification, not participant identity. Trade windows ending after the
feature timestamp are rejected as lookahead.

## Labels and rows

`buildFutureMidReturnLabelsV1` uses the first strictly future snapshot at or after each configured
exchange-time horizon, subject to an explicit maximum alignment delay. It never falls back to an
earlier observation. The simple mid return is `(futureMid / anchorMid - 1) * 10_000` basis points.

`buildOrderBookDatasetRowsV1` combines past-only features and offline future labels into versioned,
deterministic in-memory rows. Provenance records every label's future sequence/time separately and
states `participantIdentityInferred: false`.

## Baseline model and inference

`trainOrderBookRidgeModelV1` is a deliberately inspectable baseline, not a claim of participant
identification. It trains one instrument/normalizer scope with ridge linear regression. Feature
scaling is fitted on the training slice only. Chronological train/validation/test boundaries purge
rows whose future labels cross into the next split, preventing a common form of time-series leakage.

The model artifact records scope, coefficients, scaler, split counts, OOS metrics and an immutable
research-only execution boundary. `predictOrderBookReturnV1` accepts only the exact feature schema
and a matching fresh, continuous normalized snapshot. It reports direction, predicted future-mid
return, signal-to-validation-noise and feature contributions. Large train-scaler z-scores are marked
out-of-distribution; the value is not presented as a calibrated probability.

## Ephemeral research API

`createOrderBookMlResearchRouter` exposes a bounded, admin-only HTTP workflow at
`/api/orderbook-ml/research`:

- `GET /health`, `GET /status` and `GET /sessions` report limits, quality counters and provenance without raw data;
- `POST /sessions` creates a temporary upload session with explicit quality and label policies;
- `POST /sessions/:id/snapshots` atomically accepts at most 250 strict
  `sequenced-l2-snapshot-v1` envelopes per request;
- `POST /sessions/:id/models` builds v1 rows and trains the existing ridge baseline;
- `GET /sessions/:id/models/:modelId` returns the immutable ephemeral artifact;
- `POST /sessions/:id/predictions` evaluates one or two currently fresh, continuous snapshots;
- `GET /sessions/:id` reports scope, dataset/model provenance and accepted/rejected counters;
- `DELETE /sessions/:id` deletes snapshots and model artifacts immediately.

All routes require the `admin` role; browser session mutations also inherit CSRF enforcement from
`requireAuth`. Bodies are strict and globally capped at 1 MiB, each session is capped at 2,000
snapshots and three models, the registry holds four sessions, and sessions expire after 30 minutes.
Operations also have a cooperative two-second processing budget on top of those deterministic input
bounds. Data and artifacts remain in process memory and are never persisted.

There is deliberately no online collector. The current public order-book hub publishes throttled
partial depth and does not prove reconstructed source-sequence continuity, so attaching it here would
forge evidence. Historical uploads are checked for freshness at their recorded capture time;
prediction uploads are checked against current server time. The API does not provide durable capture,
a production registry, walk-forward retraining, drift alerts, calibrated probabilities or participant
identification. Neither predictions nor OOD status can place paper or live orders.
