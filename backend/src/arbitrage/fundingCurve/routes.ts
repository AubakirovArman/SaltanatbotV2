import type { RequestHandler } from "express";
import { z } from "zod";
import { FUNDING_CURVE_ENGINE, FUNDING_HORIZON_UNIT, FUNDING_RATE_UNIT, FUNDING_STRESS_UNIT, MAX_FUNDING_CURVE_HISTORY, MAX_FUNDING_CURVE_SCENARIOS, MAX_FUNDING_CURVE_SELECTIONS, MAX_FUNDING_CURVE_SETTLEMENTS, MAX_FUNDING_CURVE_SOURCE_ERRORS } from "./types.js";
import { FundingCurveCancelledError, FundingCurveRequestError, FundingCurveService } from "./service.js";

const safeTimestamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const finiteRate = z.number().finite().min(-10).max(10);
const venue = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_-]{2,30}$/);
const instrumentId = z
  .string()
  .trim()
  .min(2)
  .max(200)
  .regex(/^(?:@[0-9]{1,6}|[A-Za-z0-9][A-Za-z0-9:._/@-]*)$/);
const scenarioId = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const selectionSchema = z
  .object({
    venue,
    instrumentId,
    marketType: z.literal("perpetual"),
    rateUnit: z.literal(FUNDING_RATE_UNIT)
  })
  .strict();

const stressScenarioSchema = z
  .object({
    id: scenarioId,
    bumpBps: z.number().finite().min(-10_000).max(10_000),
    unit: z.literal(FUNDING_STRESS_UNIT)
  })
  .strict();

export const fundingCurveRequestSchema = z
  .object({
    selections: z
      .array(selectionSchema)
      .min(1)
      .max(MAX_FUNDING_CURVE_SELECTIONS)
      .refine((rows) => new Set(rows.map((row) => `${row.venue}\u0000${row.instrumentId}`)).size === rows.length, "selections must be unique"),
    horizon: z
      .object({
        value: z
          .number()
          .int()
          .min(1)
          .max(30 * 24 * 60),
        unit: z.literal(FUNDING_HORIZON_UNIT)
      })
      .strict(),
    historyLimit: z.number().int().min(1).max(MAX_FUNDING_CURVE_HISTORY).default(100),
    maxAgeMs: z
      .number()
      .int()
      .min(1)
      .max(24 * 60 * 60_000)
      .default(60_000),
    maxFutureSkewMs: z.number().int().min(0).max(60_000).default(2_000),
    maxCrossVenueClockSkewMs: z.number().int().min(0).max(60_000).default(2_000),
    stressScenarios: z
      .array(stressScenarioSchema)
      .min(1)
      .max(MAX_FUNDING_CURVE_SCENARIOS)
      .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length, "stress scenario IDs must be unique")
  })
  .strict();

const historyPointSchema = z
  .object({
    settlementAt: safeTimestamp,
    estimateRate: finiteRate,
    realizedRate: finiteRate.optional(),
    effectiveRate: finiteRate,
    rateKind: z.enum(["estimate", "realized"]),
    rateUnit: z.literal(FUNDING_RATE_UNIT),
    formulaType: z.string().min(1).max(1_000).optional(),
    method: z.string().min(1).max(1_000).optional()
  })
  .strict();

const settlementSchema = z
  .object({
    settlementAt: safeTimestamp,
    baseRate: finiteRate,
    baseRateBps: z.number().finite().min(-100_000).max(100_000),
    rateUnit: z.literal(FUNDING_RATE_UNIT),
    rateSource: z.enum(["current-estimate", "next-estimate", "latest-estimate-persistence"])
  })
  .strict();

const projectionSchema = z
  .object({
    id: scenarioId,
    bumpBps: z.number().finite().min(-10_000).max(10_000),
    unit: z.literal(FUNDING_STRESS_UNIT),
    settlementCount: z.number().int().min(0).max(MAX_FUNDING_CURVE_SETTLEMENTS),
    cumulativeRate: z
      .number()
      .finite()
      .min(-10 * MAX_FUNDING_CURVE_SETTLEMENTS)
      .max(10 * MAX_FUNDING_CURVE_SETTLEMENTS),
    averageRatePerSettlement: finiteRate,
    outsidePublishedMinimumCount: z.number().int().min(0).max(MAX_FUNDING_CURVE_SETTLEMENTS),
    outsidePublishedMaximumCount: z.number().int().min(0).max(MAX_FUNDING_CURVE_SETTLEMENTS)
  })
  .strict();

const curveSchema = z
  .object({
    venue,
    instrumentId,
    marketType: z.literal("perpetual"),
    rateUnit: z.literal(FUNDING_RATE_UNIT),
    rateSignConvention: z.literal("positive-longs-pay-shorts"),
    projectionSemantics: z.literal("rate-sum-only-no-notional-or-pnl"),
    freshness: z.discriminatedUnion("clockBasis", [
      z
        .object({
          status: z.literal("fresh"),
          clockBasis: z.literal("calibrated-venue-interval"),
          crossVenueComparable: z.literal(true),
          observedAt: z.number().finite().positive(),
          ageMs: z
            .number()
            .finite()
            .min(0)
            .max(24 * 60 * 60_000),
          maxAgeMs: z
            .number()
            .int()
            .min(1)
            .max(24 * 60 * 60_000),
          ageLowerMs: z
            .number()
            .finite()
            .min(-60_000)
            .max(24 * 60 * 60_000),
          ageUpperMs: z
            .number()
            .finite()
            .min(-60_000)
            .max(24 * 60 * 60_000),
          clockLeg: z
            .object({
              sourceId: z.string().min(1).max(200),
              exchangeTs: safeTimestamp,
              clockStatus: z.literal("calibrated"),
              ageLowerMs: z
                .number()
                .finite()
                .min(-60_000)
                .max(24 * 60 * 60_000),
              ageUpperMs: z
                .number()
                .finite()
                .min(-60_000)
                .max(24 * 60 * 60_000),
              localEventEarliestAt: z.number().finite().positive(),
              localEventLatestAt: z.number().finite().positive()
            })
            .strict()
        })
        .strict(),
      z
        .object({
          status: z.literal("fresh"),
          clockBasis: z.literal("local-receipt-fallback"),
          crossVenueComparable: z.literal(false),
          observedAt: safeTimestamp,
          ageMs: z
            .number()
            .int()
            .min(0)
            .max(24 * 60 * 60_000),
          maxAgeMs: z
            .number()
            .int()
            .min(1)
            .max(24 * 60 * 60_000),
          fallbackReason: z.enum(["clock-provider-unavailable", "clock-unavailable", "clock-not-calibrated", "source-declared-local-receipt"])
        })
        .strict()
    ]),
    schedule: z
      .object({
        verified: z.literal(true),
        interval: z
          .number()
          .int()
          .min(1)
          .max(24 * 60),
        unit: z.literal(FUNDING_HORIZON_UNIT),
        fundingTime: safeTimestamp,
        nextFundingTime: safeTimestamp
      })
      .strict(),
    current: z
      .object({
        settlementAt: safeTimestamp,
        estimateRate: finiteRate,
        estimateRateBps: z.number().finite().min(-100_000).max(100_000),
        rateUnit: z.literal(FUNDING_RATE_UNIT),
        nextEstimateRate: finiteRate.optional(),
        nextEstimateRateBps: z.number().finite().min(-100_000).max(100_000).optional(),
        minimumRate: finiteRate.optional(),
        maximumRate: finiteRate.optional()
      })
      .strict(),
    history: z.array(historyPointSchema).max(MAX_FUNDING_CURVE_HISTORY),
    settlements: z.array(settlementSchema).max(MAX_FUNDING_CURVE_SETTLEMENTS),
    scenarios: z.array(projectionSchema).min(1).max(MAX_FUNDING_CURVE_SCENARIOS),
    source: z
      .object({
        adapter: z.literal("publicVenueAdapters"),
        operation: z.literal("funding"),
        public: z.literal(true),
        credentialed: z.literal(false),
        exchangeTs: safeTimestamp,
        receivedAt: safeTimestamp,
        formulaType: z.string().min(1).max(1_000).optional(),
        method: z.string().min(1).max(1_000).optional(),
        network: z.enum(["mainnet", "testnet"]).optional(),
        currentEstimateSource: z.string().min(1).max(1_000).optional(),
        timestampSource: z.enum(["exchange", "local-receive"]).optional(),
        historyComplete: z.boolean(),
        sourceErrors: z.array(z.string().min(1).max(1_000)).max(MAX_FUNDING_CURVE_SOURCE_ERRORS),
        sourceErrorsTruncated: z.boolean()
      })
      .strict()
  })
  .strict();

const rejectionCode = z.enum(["venue-unavailable", "funding-unsupported", "unsupported-rate-unit", "identity-mismatch", "stale-source", "future-source-time", "unverified-schedule", "unsupported-schedule", "invalid-source", "projection-too-large", "upstream-unavailable"]);

export const fundingCurveResponseSchema = z
  .object({
    engine: z.literal(FUNDING_CURVE_ENGINE),
    readOnly: z.literal(true),
    researchOnly: z.literal(true),
    executable: z.literal(false),
    evaluatedAt: safeTimestamp,
    horizonEnd: safeTimestamp,
    contract: z
      .object({
        source: z.literal("credential-free-public-venue-adapters"),
        rateUnit: z.literal(FUNDING_RATE_UNIT),
        stressUnit: z.literal(FUNDING_STRESS_UNIT),
        scheduleRequirement: z.literal("adapter-verified-discrete-settlements"),
        projection: z.literal("point-in-time-estimate-persistence"),
        pnl: z.literal("not-computed-without-explicit-notional-and-price-path"),
        execution: z.literal("none")
      })
      .strict(),
    crossVenueClock: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("not-applicable"),
          eligible: z.literal(false),
          reason: z.literal("fewer-than-two-successful-venues"),
          comparedVenueCount: z.number().int().min(0).max(MAX_FUNDING_CURVE_SELECTIONS),
          calibratedVenueCount: z.number().int().min(0).max(MAX_FUNDING_CURVE_SELECTIONS),
          maxSkewMs: z.number().int().min(0).max(60_000)
        })
        .strict(),
      z
        .object({
          status: z.literal("blocked"),
          eligible: z.literal(false),
          reason: z.enum(["clock-not-calibrated", "skew-exceeded"]),
          comparedVenueCount: z.number().int().min(2).max(MAX_FUNDING_CURVE_SELECTIONS),
          calibratedVenueCount: z.number().int().min(0).max(MAX_FUNDING_CURVE_SELECTIONS),
          maxSkewMs: z.number().int().min(0).max(60_000),
          maximumPossibleSkewMs: z
            .number()
            .finite()
            .min(0)
            .max(24 * 60 * 60_000)
            .optional()
        })
        .strict(),
      z
        .object({
          status: z.literal("eligible"),
          eligible: z.literal(true),
          clockBasis: z.literal("calibrated-venue-interval"),
          comparedVenueCount: z.number().int().min(2).max(MAX_FUNDING_CURVE_SELECTIONS),
          calibratedVenueCount: z.number().int().min(2).max(MAX_FUNDING_CURVE_SELECTIONS),
          maxSkewMs: z.number().int().min(0).max(60_000),
          maximumPossibleSkewMs: z
            .number()
            .finite()
            .min(0)
            .max(24 * 60 * 60_000)
        })
        .strict()
    ]),
    curves: z.array(curveSchema).max(MAX_FUNDING_CURVE_SELECTIONS),
    rejections: z
      .array(
        z
          .object({
            venue,
            instrumentId,
            code: rejectionCode,
            message: z.string().min(1).max(1_000),
            retryable: z.boolean()
          })
          .strict()
      )
      .max(MAX_FUNDING_CURVE_SELECTIONS)
  })
  .strict();

/** Public, read-only research endpoint. No request field can carry credentials or orders. */
export function createFundingCurveHandler(service = new FundingCurveService()): RequestHandler {
  return async (request, response) => {
    const parsed = fundingCurveRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        readOnly: true,
        researchOnly: true,
        executable: false,
        error: "Invalid funding-curve research request",
        issues: parsed.error.flatten()
      });
      return;
    }

    const controller = new AbortController();
    const cancel = () => {
      if (!response.writableEnded) controller.abort(new FundingCurveCancelledError());
    };
    request.once("aborted", cancel);
    response.once("close", cancel);
    try {
      const result = await service.evaluate(parsed.data, controller.signal);
      if (controller.signal.aborted || response.destroyed) return;
      const payload = fundingCurveResponseSchema.parse(result);
      response.setHeader("Cache-Control", "no-store");
      response.json(payload);
    } catch (error) {
      if (controller.signal.aborted || response.destroyed || error instanceof FundingCurveCancelledError) return;
      const status = error instanceof FundingCurveRequestError ? 400 : 503;
      response.status(status).json({
        readOnly: true,
        researchOnly: true,
        executable: false,
        error: error instanceof Error ? error.message : "Funding curve unavailable"
      });
    } finally {
      request.off("aborted", cancel);
      response.off("close", cancel);
    }
  };
}
