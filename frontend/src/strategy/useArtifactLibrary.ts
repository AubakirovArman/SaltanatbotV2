import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { IndicatorConfig } from "../chart/indicatorTypes";
import {
  createArtifactCopy,
  createPineArtifacts,
  createTemplateCopy,
  dedupeArtifactName,
  stampArtifact,
  type PineArtifactInput,
  upsertArtifact
} from "./artifactLibraryModel";
import type { StrategyArtifact, StrategyArtifactKind } from "./library";
import { indicatorToArtifact } from "./library";
import { warmStrategyLab } from "./loadStrategyLab";
import { clearShareHash, readSharedFromHash } from "./share";
import { storeStrategyLibrary } from "./storage";
import type { StrategyTemplate } from "./templates";

const ARTIFACT_INPUTS_KEY = "marketforge.artifactInputs.v1";

interface UseArtifactLibraryOptions {
  initialArtifacts: StrategyArtifact[];
  setIndicators: Dispatch<SetStateAction<IndicatorConfig[]>>;
  openStrategyWorkspace(): void;
}

export function useArtifactLibrary({ initialArtifacts, setIndicators, openStrategyWorkspace }: UseArtifactLibraryOptions) {
  const [artifacts, setArtifacts] = useState(initialArtifacts);
  const [activeArtifactId, setActiveArtifactId] = useState("strategy:price-cross-ema");
  const [inputOverrides, setInputOverrides] = useState<Record<string, Record<string, number>>>(() => readArtifactInputOverrides());

  useEffect(() => {
    const shared = readSharedFromHash();
    if (!shared) return;
    const now = Date.now();
    const artifact: StrategyArtifact = {
      id: `strategy:remix-${now}`,
      kind: "strategy",
      name: `${shared.name} (remix)`,
      description: "Imported from a shared link.",
      xml: shared.xml,
      createdAt: now,
      updatedAt: now
    };
    setArtifacts((current) => [artifact, ...current]);
    setActiveArtifactId(artifact.id);
    openStrategyWorkspace();
    warmStrategyLab();
    clearShareHash();
  }, [openStrategyWorkspace]);

  useEffect(() => storeStrategyLibrary(artifacts), [artifacts]);
  useEffect(() => {
    try { localStorage.setItem(ARTIFACT_INPUTS_KEY, JSON.stringify(inputOverrides)); } catch { /* runtime state still works */ }
  }, [inputOverrides]);

  const customIndicators = useMemo(() => artifacts
    .filter((item) => item.kind === "indicator" && !item.linkedIndicatorId)
    .map((item) => ({ id: item.id, name: item.name, description: item.description })), [artifacts]);
  const strategies = useMemo(() => artifacts
    .filter((item) => item.kind === "strategy")
    .map((item) => ({ id: item.id, name: item.name, description: item.description })), [artifacts]);

  const selectIndicatorLogic = (indicator: IndicatorConfig) => {
    const artifact = indicatorToArtifact(indicator);
    setArtifacts((current) => upsertArtifact(current, artifact));
    setActiveArtifactId(artifact.id);
    warmStrategyLab();
    openStrategyWorkspace();
  };

  const saveArtifact = (artifact: StrategyArtifact) => {
    const saved = stampArtifact(artifact, artifacts.find((item) => item.id === artifact.id));
    setArtifacts((current) => upsertArtifact(current, artifact));
    if (!artifact.linkedIndicatorId) return;
    setIndicators((current) => current.map((indicator) => indicator.id === artifact.linkedIndicatorId
      ? { ...indicator, logicCode: saved.code, logicXml: saved.xml, logicVersion: saved.version, logicHash: saved.hash }
      : indicator));
  };

  const createArtifact = (kind: StrategyArtifactKind) => {
    const artifact = createArtifactCopy(kind, artifacts);
    setArtifacts((current) => [artifact, ...current]);
    setActiveArtifactId(artifact.id);
    warmStrategyLab();
  };

  const useTemplate = (template: StrategyTemplate) => {
    const artifact = createTemplateCopy(template, artifacts);
    setArtifacts((current) => [artifact, ...current]);
    setActiveArtifactId(artifact.id);
    warmStrategyLab();
  };

  const importPineMany = (inputs: PineArtifactInput[]) => {
    if (!inputs.length) return;
    const now = Date.now();
    setArtifacts((current) => [...createPineArtifacts(inputs, current, now), ...current]);
    setActiveArtifactId(`${inputs[0].kind}:pine-${now}-0`);
    warmStrategyLab();
  };

  const importStrategy = (input: { name: string; description: string; xml: string }) => {
    const now = Date.now();
    const artifact: StrategyArtifact = {
      id: `strategy:import-${now}`,
      kind: "strategy",
      name: dedupeArtifactName(input.name, artifacts),
      description: input.description || "Imported strategy.",
      xml: input.xml,
      code: "",
      createdAt: now,
      updatedAt: now
    };
    setArtifacts((current) => [artifact, ...current]);
    setActiveArtifactId(artifact.id);
    warmStrategyLab();
  };

  return {
    artifacts,
    activeArtifactId,
    setActiveArtifactId,
    inputOverrides,
    setInputOverrides,
    customIndicators,
    strategies,
    selectIndicatorLogic,
    saveArtifact,
    createArtifact,
    useTemplate,
    importPineMany,
    importStrategy
  };
}

function readArtifactInputOverrides(): Record<string, Record<string, number>> {
  try {
    const raw = localStorage.getItem(ARTIFACT_INPUTS_KEY);
    return raw ? JSON.parse(raw) as Record<string, Record<string, number>> : {};
  } catch {
    return {};
  }
}
