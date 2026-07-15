// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneratorPanel } from "../src/strategy/components/GeneratorPanel";
import { StrategyLibrary } from "../src/strategy/components/StrategyLibrary";
import {
  StrategyGenerationAbortedError,
  generateStrategyCandidates,
  type StrategyGenerationResult
} from "../src/strategy/generator";
import { generatedCandidateToPortableArtifact } from "../src/strategy/generatedArtifact";
import { portableArtifactProvenanceSource } from "../src/strategy/library";
import { compileXmlToIr } from "../src/strategy/compileArtifact";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("strategy generator panel", () => {
  it("is reachable from the Strategy Lab library toolbar", () => {
    const html = renderToStaticMarkup(<StrategyLibrary
      locale="ru"
      artifacts={[]}
      onSelect={() => {}}
      onCreate={() => {}}
      onUseTemplate={() => {}}
      onImportStrategy={() => {}}
      onImportPlugin={() => {}}
      onUninstallPlugin={() => false}
      onImportPineMany={() => {}}
    />);
    expect(html).toContain("Генератор");
    expect(html).toContain("структурными мутациями");
  });

  it("renders a semantic bounded form and honest no-ranking boundary in every locale", () => {
    const expected = {
      en: ["Algorithmic strategy generator", "Generate candidates", "Not run:"],
      ru: ["Алгоритмический генератор стратегий", "Сгенерировать кандидатов", "Не запускались:"],
      kk: ["Алгоритмдік стратегия генераторы", "Кандидаттарды жасау", "Іске қосылмады:"]
    } as const;

    for (const locale of ["en", "ru", "kk"] as const) {
      const html = renderToStaticMarkup(<GeneratorPanel locale={locale} onClose={() => {}} onImport={() => {}} />);
      expect(html).toContain('role="dialog"');
      expect(html).toContain('aria-modal="true"');
      expect(html.match(/<fieldset/g)).toHaveLength(4);
      expect(html.match(/type="checkbox"/g)).toHaveLength(6);
      expect(html.match(/type="number"/g)).toHaveLength(3);
      expect(html).toContain('data-ranking-state="unavailable"');
      for (const text of expected[locale]) expect(html).toContain(text);
      expect(html).not.toMatch(/AI[- ]generated|ИИ[- ]генерац/i);
    }
  });

  it("generates unique candidates and imports the selected one through the portable artifact boundary", async () => {
    const generated = await generateStrategyCandidates({ seed: 17, populationSize: 4, generations: 1, families: ["breakout"], directions: ["short"] });
    const run = vi.fn(async (_spec: Parameters<typeof generateStrategyCandidates>[0], runtime: Parameters<typeof generateStrategyCandidates>[1]) => {
      runtime?.onProgress?.({ phase: "evolve", generation: 1, generations: 1, accepted: generated.candidates.length, targetCandidates: generated.candidates.length, attempts: generated.attempts, duplicates: generated.duplicates });
      return generated;
    }) as typeof generateStrategyCandidates;
    const onImport = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<GeneratorPanel locale="ru" onClose={() => {}} onImport={onImport} generateCandidates={run} />));
    const start = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Сгенерировать кандидатов"));
    await act(async () => {
      start?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(run).toHaveBeenCalledOnce();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(generated.candidates.length);
    expect(container.textContent).toContain("Кандидаты прошли структурную проверку");
    expect(container.textContent).toContain("bounded-grammar-v1");
    expect(container.textContent).toContain("Fingerprint");
    expect(container.textContent).toContain("Не запускались:");

    const add = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Добавить выбранного кандидата"));
    await act(async () => add?.click());
    expect(onImport).toHaveBeenCalledOnce();
    const artifact = onImport.mock.calls[0][0];
    expect(artifact).toMatchObject({ kind: "strategy", schemaVersion: 2, semanticVersion: "0.1.0", provenance: { source: "generator" } });
    expect(artifact.xml).toContain('type="strategy_start"');
    expect(artifact.parameters.length).toBeGreaterThan(0);
    const compiled = compileXmlToIr(artifact.xml);
    expect(compiled.errors).toEqual([]);
    expect(sortedInputs(compiled.ir?.inputs ?? [])).toEqual(sortedInputs(artifact.parameters));

    await act(async () => root.unmount());
  });

  it("cancels an in-flight run through AbortSignal without leaving import enabled", async () => {
    let suppliedSignal: AbortSignal | undefined;
    const run = ((_spec = {}, runtime = {}) => new Promise<StrategyGenerationResult>((_resolve, reject) => {
      suppliedSignal = runtime.signal;
      runtime.signal?.addEventListener("abort", () => reject(new StrategyGenerationAbortedError()), { once: true });
    })) as typeof generateStrategyCandidates;
    const onImport = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<GeneratorPanel locale="en" onClose={() => {}} onImport={onImport} generateCandidates={run} />));
    const start = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Generate candidates"));
    await act(async () => start?.click());
    const cancel = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Cancel generation"));
    await act(async () => {
      cancel?.click();
      await Promise.resolve();
    });

    expect(suppliedSignal?.aborted).toBe(true);
    expect(container.textContent).toContain("Generation cancelled. No candidate was imported.");
    const add = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Add selected candidate"));
    expect(add?.disabled).toBe(true);
    expect(onImport).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });
});

describe("generated portable artifact", () => {
  it("round-trips a full generated population without changing parameter constraints", async () => {
    const result = await generateStrategyCandidates({ seed: 17, populationSize: 32, generations: 1 });
    expect(result.candidates).toHaveLength(64);
    for (const candidate of result.candidates) {
      const artifact = generatedCandidateToPortableArtifact(candidate, "round-trip");
      const compiled = compileXmlToIr(artifact.xml);
      expect(compiled.errors, candidate.fingerprint).toEqual([]);
      expect(sortedInputs(compiled.ir?.inputs ?? []), candidate.fingerprint).toEqual(sortedInputs(candidate.ir.inputs));
    }
  });

  it("retains recognized wizard/generator labels and fails closed for arbitrary portable source claims", () => {
    expect(portableArtifactProvenanceSource("generator")).toBe("generator");
    expect(portableArtifactProvenanceSource("wizard")).toBe("wizard");
    expect(portableArtifactProvenanceSource("plugin")).toBe("file");
    expect(portableArtifactProvenanceSource("unknown-source")).toBe("file");
  });

  it("rejects invalid candidates instead of bypassing generator validation", async () => {
    const result = await generateStrategyCandidates({ seed: 9, populationSize: 2, generations: 0 });
    const invalid = {
      ...result.candidates[0],
      validation: { ...result.candidates[0].validation, valid: false, issues: ["riskControls"] }
    };
    expect(() => generatedCandidateToPortableArtifact(invalid, "test")).toThrow("Cannot import an invalid generated strategy");
  });
});

function sortedInputs<T extends { name: string }>(inputs: readonly T[]): T[] {
  return [...inputs].sort((left, right) => left.name.localeCompare(right.name));
}
