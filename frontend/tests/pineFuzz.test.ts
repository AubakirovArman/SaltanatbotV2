import { describe, expect, it } from "vitest";
import { convertPine } from "../src/strategy/pine/convert";
import { PineConvertError } from "../src/strategy/pine/errors";

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.,:;()[]{}+-*/%<>=!?\n \t#'\"";

describe("Pine parser fuzz safety", () => {
  it("fails closed with a typed conversion error for deterministic arbitrary inputs", () => {
    const random = seededRandom(0x51a7_2026);
    for (let sample = 0; sample < 500; sample += 1) {
      const length = Math.floor(random() * 240);
      let source = "";
      for (let index = 0; index < length; index += 1) {
        source += ALPHABET[Math.floor(random() * ALPHABET.length)];
      }
      assertTypedOutcome(source);
    }
  });

  it("survives deletion and replacement mutations of valid scripts", () => {
    const seeds = [
      "//@version=6\nindicator(\"Fuzz SMA\", overlay=true)\nlength=input.int(14)\navg=ta.sma(close,length)\nplot(avg)",
      "//@version=6\nstrategy(\"Fuzz Strategy\")\nif ta.crossover(close, ta.ema(close, 20))\n    strategy.entry(\"L\", strategy.long)",
      "//@version=6\nindicator(\"Draw\")\na=plot(high)\nb=plot(low)\nfill(a,b,color.new(color.blue,80))"
    ];
    for (const seed of seeds) {
      const step = Math.max(1, Math.floor(seed.length / 24));
      for (let index = 0; index < seed.length; index += step) {
        assertTypedOutcome(seed.slice(0, index) + seed.slice(index + 1));
        assertTypedOutcome(`${seed.slice(0, index)}@${seed.slice(index + 1)}`);
      }
    }
  });

  it("is deterministic for generated valid arithmetic programs", () => {
    const random = seededRandom(0xc0de_600d);
    for (let sample = 0; sample < 100; sample += 1) {
      const a = Math.floor(random() * 100) + 1;
      const b = Math.floor(random() * 100) + 1;
      const op = ["+", "-", "*", "/"][Math.floor(random() * 4)];
      const source = `//@version=6\nindicator("Generated")\nvalue = close ${op} (${a} + ${b})\nplot(value)`;
      expect(convertPine(source)).toEqual(convertPine(source));
    }
  });
});

function assertTypedOutcome(source: string) {
  try {
    const result = convertPine(source);
    expect(result.ir.name).toBeTypeOf("string");
  } catch (cause) {
    expect(cause).toBeInstanceOf(PineConvertError);
  }
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}
