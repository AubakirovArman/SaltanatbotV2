import type { PaperMoney } from "./paperPortfolioTypes";

/** Converts a human decimal input into the positive canonical six-decimal API form. */
export function toCanonicalPositivePaperMoney(value: string): PaperMoney | undefined {
  const normalized = value.trim().replace(",", ".");
  const match = /^(?:0|[1-9]\d*)(?:\.(\d{0,6}))?$/.exec(normalized);
  if (!match) return undefined;
  const canonical = `${normalized.split(".")[0]}.${(match[1] ?? "").padEnd(6, "0")}`;
  return canonical === "0.000000" ? undefined : canonical;
}

/** Exact comparison without converting portfolio money to a floating-point number. */
export function comparePaperMoney(left: PaperMoney, right: PaperMoney): number {
  const leftMicros = paperMoneyMicros(left);
  const rightMicros = paperMoneyMicros(right);
  return leftMicros < rightMicros ? -1 : leftMicros > rightMicros ? 1 : 0;
}

function paperMoneyMicros(value: PaperMoney): bigint {
  const match = /^(-?)(?:0|[1-9]\d*)\.\d{6}$/.exec(value);
  if (!match) throw new Error("Paper money must use canonical six-decimal form");
  const negative = match[1] === "-";
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction] = unsigned.split(".") as [string, string];
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction);
  return negative ? -micros : micros;
}
