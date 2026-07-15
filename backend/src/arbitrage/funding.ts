import type { ArbitrageOpportunity } from "./types.js";

type FundingSchedule = Pick<
  ArbitrageOpportunity,
  "fundingRate" | "fundingIntervalMinutes" | "fundingScheduleVerified" | "nextFundingTime"
>;

/**
 * Counts settlements used by the projection. A verified schedule is enumerated
 * normally. For an unverified schedule we never credit the short and charge
 * at least one adverse settlement whenever the holding horizon is non-zero.
 */
export function projectedFundingSettlements(schedule: FundingSchedule, holdingHours: number, now = Date.now()) {
  if (!(holdingHours > 0) || !Number.isFinite(schedule.fundingRate)) return 0;
  const end = now + holdingHours * 60 * 60_000;
  if (!schedule.fundingScheduleVerified) {
    return schedule.fundingRate < 0 ? 1 : 0;
  }
  if (
    !(schedule.fundingIntervalMinutes && schedule.fundingIntervalMinutes > 0) ||
    !(schedule.nextFundingTime && schedule.nextFundingTime > 0) ||
    !Number.isFinite(end)
  ) {
    return 0;
  }
  const intervalMs = schedule.fundingIntervalMinutes * 60_000;
  let next = schedule.nextFundingTime;
  if (next <= now) next += (Math.floor((now - next) / intervalMs) + 1) * intervalMs;
  return next > end ? 0 : 1 + Math.floor((end - next) / intervalMs);
}

/** Positive funding is expected income for the short perpetual leg. */
export function projectedShortFundingBps(schedule: FundingSchedule, holdingHours: number, now = Date.now()) {
  return schedule.fundingRate * projectedFundingSettlements(schedule, holdingHours, now) * 10_000;
}
