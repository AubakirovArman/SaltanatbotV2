/** Fail-closed arithmetic used for public market-only economics. */
export class DerivedArithmeticFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DerivedArithmeticFailure";
  }
}

export function lessThanWithTolerance(value: number, minimum: number) {
  if (!Number.isFinite(value) || !Number.isFinite(minimum)) throw new DerivedArithmeticFailure("Minimum-filter arithmetic must be finite");
  return value < minimum && minimum - value > tolerance(value);
}

export function safePositiveProduct(left: number, right: number, label: string) {
  positiveInputs(left, right, label);
  return positiveResult(left * right, label);
}

export function safePositiveQuotient(numerator: number, denominator: number, label: string) {
  positiveInputs(numerator, denominator, label);
  return positiveResult(numerator / denominator, label);
}

export function safePositiveAverage(left: number, right: number, label: string) {
  positiveInputs(left, right, label);
  return positiveResult(left <= right ? left + (right - left) / 2 : right + (left - right) / 2, label);
}

export function safeDifference(left: number, right: number, label: string) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) throw new DerivedArithmeticFailure(`${label} inputs must be finite`);
  const result = left - right;
  if (!Number.isFinite(result)) throw new DerivedArithmeticFailure(`${label} overflowed`);
  if (result === 0 && left !== right) throw new DerivedArithmeticFailure(`${label} underflowed precision`);
  return result;
}

export function safeSum(left: number, right: number, label: string) {
  if (!Number.isFinite(left) || left < 0 || !Number.isFinite(right) || right < 0) throw new DerivedArithmeticFailure(`${label} inputs must be finite and non-negative`);
  const result = left + right;
  if (!Number.isFinite(result)) throw new DerivedArithmeticFailure(`${label} overflowed`);
  if (result === 0 && (left !== 0 || right !== 0)) throw new DerivedArithmeticFailure(`${label} underflowed`);
  return result;
}

export function safeBasisBps(valueDifference: number, referenceNotional: number, label: string) {
  if (!Number.isFinite(valueDifference) || !Number.isFinite(referenceNotional) || referenceNotional <= 0) throw new DerivedArithmeticFailure(`${label} inputs are invalid`);
  if (valueDifference === 0) return 0;
  const ratio = valueDifference / referenceNotional;
  if (!Number.isFinite(ratio)) throw new DerivedArithmeticFailure(`${label} ratio overflowed`);
  if (ratio === 0) throw new DerivedArithmeticFailure(`${label} ratio underflowed`);
  const result = ratio * 10_000;
  if (!Number.isFinite(result)) throw new DerivedArithmeticFailure(`${label} overflowed`);
  if (result === 0) throw new DerivedArithmeticFailure(`${label} underflowed`);
  return result;
}

function positiveInputs(left: number, right: number, label: string) {
  if (!Number.isFinite(left) || left <= 0 || !Number.isFinite(right) || right <= 0) throw new DerivedArithmeticFailure(`${label} inputs must be finite and positive`);
}

function positiveResult(result: number, label: string) {
  if (!Number.isFinite(result)) throw new DerivedArithmeticFailure(`${label} overflowed`);
  if (result <= 0) throw new DerivedArithmeticFailure(`${label} underflowed`);
  return result;
}

function tolerance(value: number) {
  return Math.max(1e-12, Math.abs(value) * 1e-10);
}
