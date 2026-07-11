import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { convertPine, PineConvertError } from "@saltanatbotv2/pine-compiler";
import { describe, expect, it } from "vitest";
import golden from "./pineConversion.golden.json";

interface ProvenanceEntry {
  path: string;
  title: string;
  license: string;
  corpusEligible: boolean;
}

describe("Pine deterministic output goldens", () => {
  it.each(golden)("preserves $name", ({ source, sha256 }) => {
    const first = JSON.stringify(convertPine(source));
    const second = JSON.stringify(convertPine(source));
    expect(second).toBe(first);
    expect(createHash("sha256").update(first).digest("hex")).toBe(sha256);
  });
});

describe("permissively licensed real-world Pine corpus", () => {
  it("has deterministic typed outcomes for every eligible provenance entry", async () => {
    const root = new URL("../../pine/", import.meta.url);
    const manifest = JSON.parse(await readFile(new URL("provenance.json", root), "utf8")) as { files: ProvenanceEntry[] };
    const eligible = manifest.files.filter((entry) => entry.corpusEligible);

    expect(eligible.length).toBeGreaterThanOrEqual(3);
    for (const entry of eligible) {
      expect(entry.license).toBe("MPL-2.0");
      const source = await readFile(new URL(entry.path, root), "utf8");
      const outcome = () => {
        try {
          return { ok: true as const, result: convertPine(source) };
        } catch (cause) {
          if (!(cause instanceof PineConvertError)) throw cause;
          return { ok: false as const, diagnostic: cause.diagnostic };
        }
      };
      const first = outcome();
      const second = outcome();
      expect(second, entry.title).toEqual(first);
      if (!first.ok) {
        expect(first.diagnostic.code, entry.title).toMatch(/^PINE_/);
        expect(first.diagnostic.remediation, entry.title).toBeTruthy();
        expect(first.diagnostic.span?.start.line, entry.title).toBeGreaterThan(0);
      }
    }
  }, 10_000);
});
