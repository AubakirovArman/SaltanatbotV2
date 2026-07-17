import { describe, expect, it } from "vitest";
import { comparePaperMoney, toCanonicalPositivePaperMoney } from "../src/trading/paperPortfolioMoney";

describe("canonical paper portfolio money", () => {
  it("canonicalizes positive dot and comma decimals to exactly six places", () => {
    expect(toCanonicalPositivePaperMoney("1")).toBe("1.000000");
    expect(toCanonicalPositivePaperMoney(" 2500,5 ")).toBe("2500.500000");
    expect(toCanonicalPositivePaperMoney("42.123456")).toBe("42.123456");
    expect(toCanonicalPositivePaperMoney("0.000001")).toBe("0.000001");
  });

  it("rejects zero, negatives, non-decimal notation and precision beyond six places", () => {
    for (const value of ["0", "0.000000", "-1", "+1", "01", "1e3", "1.0000001", "1,2.3", "NaN", "Infinity", ""]) {
      expect(toCanonicalPositivePaperMoney(value), value).toBeUndefined();
    }
  });

  it("compares canonical amounts exactly beyond JavaScript's safe integer range", () => {
    expect(comparePaperMoney("9007199254740993.000001", "9007199254740993.000000")).toBe(1);
    expect(comparePaperMoney("9007199254740993.999999", "9007199254740994.000000")).toBe(-1);
    expect(comparePaperMoney("-9999999999999999.000001", "-9999999999999999.000001")).toBe(0);
    expect(() => comparePaperMoney("1.0", "1.000000")).toThrow(/canonical six-decimal/);
  });
});
