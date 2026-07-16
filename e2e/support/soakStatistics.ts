export const MEBIBYTE = 1024 * 1024;

export interface TimedHeapReading {
  atMs: number;
  usedHeapBytes: number;
}

export interface RetainedHeapCheckpointSummary {
  baselineMedianBytes: number;
  finalMedianBytes: number;
  baselineSpreadBytes: number;
  finalSpreadBytes: number;
  baselineStabilityLimitBytes: number;
  finalStabilityLimitBytes: number;
  stable: boolean;
  netGrowthBytes: number;
  upperGrowthBytes: number;
  netGrowthRateMiBPerMinute: number;
  upperGrowthRateMiBPerMinute: number;
}

export interface RetainedHeapCheckpointStability {
  medianBytes: number;
  spreadBytes: number;
  stabilityLimitBytes: number;
  stable: boolean;
}

/**
 * Diagnostic only: ordinary V8 used-heap readings form a GC-driven sawtooth,
 * so their OLS slope must never be treated as a retained-leak acceptance gate.
 */
export function rawJsHeapOlsSlopeMiBPerMinute(readings: readonly TimedHeapReading[]): number {
  return regressionSlope(
    readings.map((reading) => ({
      x: reading.atMs / 60_000,
      y: reading.usedHeapBytes / MEBIBYTE
    }))
  );
}

/**
 * Compare equivalent paused, frame-settled, post-GC checkpoints.
 *
 * Three readings at each endpoint let the harness fail closed when CDP/GC has
 * not produced a stable retained-heap checkpoint. The upper-bound rate uses
 * max(final) - min(baseline), while the median net rate remains diagnostic.
 */
export function summarizeRetainedHeapCheckpoints(baseline: readonly TimedHeapReading[], final: readonly TimedHeapReading[], activeDurationMs: number): RetainedHeapCheckpointSummary {
  const baselineStability = summarizeRetainedHeapCheckpoint("baseline", baseline);
  const finalStability = summarizeRetainedHeapCheckpoint("final", final);
  if (!Number.isFinite(activeDurationMs) || activeDurationMs <= 0) {
    throw new Error("Retained-heap active duration must be a positive finite number");
  }

  const baselineValues = baseline.map((reading) => reading.usedHeapBytes);
  const finalValues = final.map((reading) => reading.usedHeapBytes);
  const durationMinutes = activeDurationMs / 60_000;
  const netGrowthBytes = finalStability.medianBytes - baselineStability.medianBytes;
  const upperGrowthBytes = Math.max(...finalValues) - Math.min(...baselineValues);

  return {
    baselineMedianBytes: baselineStability.medianBytes,
    finalMedianBytes: finalStability.medianBytes,
    baselineSpreadBytes: baselineStability.spreadBytes,
    finalSpreadBytes: finalStability.spreadBytes,
    baselineStabilityLimitBytes: baselineStability.stabilityLimitBytes,
    finalStabilityLimitBytes: finalStability.stabilityLimitBytes,
    stable: baselineStability.stable && finalStability.stable,
    netGrowthBytes,
    upperGrowthBytes,
    netGrowthRateMiBPerMinute: netGrowthBytes / MEBIBYTE / durationMinutes,
    upperGrowthRateMiBPerMinute: upperGrowthBytes / MEBIBYTE / durationMinutes
  };
}

export function summarizeRetainedHeapCheckpoint(name: string, readings: readonly TimedHeapReading[]): RetainedHeapCheckpointStability {
  validateCheckpoint(name, readings);
  const values = readings.map((reading) => reading.usedHeapBytes);
  const medianBytes = median(values);
  const spreadBytes = Math.max(...values) - Math.min(...values);
  const stabilityLimitBytes = Math.max(MEBIBYTE, medianBytes * 0.05);
  return {
    medianBytes,
    spreadBytes,
    stabilityLimitBytes,
    stable: spreadBytes <= stabilityLimitBytes
  };
}

function validateCheckpoint(name: string, readings: readonly TimedHeapReading[]): void {
  if (readings.length < 3) throw new Error(`${name} retained-heap checkpoint requires at least three readings`);
  for (const reading of readings) {
    if (!Number.isFinite(reading.atMs) || !Number.isFinite(reading.usedHeapBytes) || reading.usedHeapBytes < 0) {
      throw new Error(`${name} retained-heap checkpoint contains an invalid reading`);
    }
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function regressionSlope(points: Array<{ x: number; y: number }>): number {
  if (points.length < 2) return 0;
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  if (denominator === 0) return 0;
  return points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / denominator;
}
