import * as Blockly from "blockly/core";
import * as En from "blockly/msg/en";
import { useEffect, useRef, useState } from "react";
import { registerStrategyBlocks, strategyToolbox } from "./blocks";
import { forgeDark, forgeLight } from "./blocklyTheme";
import { compileWorkspace } from "./compile";
import type { CompileDiagnostic } from "./compile";
import type { StrategyIR } from "./ir";
import { irToText } from "./irText";
import type { StrategyArtifact } from "./library";
import { artifactIrHash } from "./artifactLibraryModel";

const blocklyMessages = Object.fromEntries(Object.entries(En).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
const MOBILE_WORKSPACE_SCALE = 0.65;
let localeReady = false;

interface UseStrategyWorkspaceOptions {
  activeArtifact?: StrategyArtifact;
  onSaveArtifact: (artifact: StrategyArtifact) => void;
  theme: "dark" | "light";
  toolboxVisible?: boolean;
}

export function useStrategyWorkspace(options: UseStrategyWorkspaceOptions) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  const previewRef = useRef<() => void>(() => undefined);
  const autosaveTimer = useRef<number>();
  const previewTimer = useRef<number>();
  const onSaveRef = useRef(options.onSaveArtifact);
  const activeRef = useRef(options.activeArtifact);
  const toolboxVisibleRef = useRef(options.toolboxVisible !== false);
  const [preview, setPreview] = useState("");
  const [selectedType, setSelectedType] = useState<string>();
  const [strategyInputs, setStrategyInputs] = useState<StrategyIR["inputs"]>([]);
  const [jsonSize, setJsonSize] = useState(0);
  const [compileErrors, setCompileErrors] = useState<string[]>([]);
  const [compileDiagnostics, setCompileDiagnostics] = useState<CompileDiagnostic[]>([]);
  const [initError, setInitError] = useState<string>();
  const [savedAt, setSavedAt] = useState<number>();
  onSaveRef.current = options.onSaveArtifact;
  activeRef.current = options.activeArtifact;
  toolboxVisibleRef.current = options.toolboxVisible !== false;

  useEffect(() => {
    if (!localeReady) {
      Blockly.setLocale(blocklyMessages);
      localeReady = true;
    }
    registerStrategyBlocks();
    const container = containerRef.current;
    if (!container) return;

    let workspace: Blockly.WorkspaceSvg;
    let observer: ResizeObserver | undefined;
    try {
      workspace = Blockly.inject(container, {
        toolbox: strategyToolbox,
        media: "/blockly-media/",
        trashcan: false,
        theme: document.documentElement.dataset.theme === "light" ? forgeLight : forgeDark,
        renderer: "thrasos",
        sounds: false,
        move: { scrollbars: true, drag: true, wheel: true },
        zoom: { controls: false, wheel: true, startScale: 0.7, maxScale: 1.25, minScale: 0.42 },
        grid: { spacing: 24, length: 2, colour: "rgba(134, 150, 166, 0.10)", snap: true }
      });
    } catch (cause) {
      setInitError(cause instanceof Error ? cause.message : "Blockly failed to start");
      return;
    }
    workspaceRef.current = workspace;

    const previewNow = () => {
      const compiled = compileWorkspace(workspace);
      setPreview(compiled.ir ? irToText(compiled.ir) : "");
      setStrategyInputs(compiled.ir?.inputs ?? []);
      setCompileErrors(compiled.errors);
      setCompileDiagnostics(compiled.diagnostics ?? compiled.errors.map((message) => ({ severity: "error", message })));
      setJsonSize(JSON.stringify(Blockly.serialization.workspaces.save(workspace)).length);
    };
    previewRef.current = previewNow;

    const autosave = () => {
      const artifact = activeRef.current;
      if (!artifact) return;
      onSaveRef.current(serializeArtifact(workspace, artifact));
      setSavedAt(Date.now());
    };
    const onChange = (event: Blockly.Events.Abstract) => {
      if (event.type === Blockly.Events.SELECTED) {
        const id = (event as Blockly.Events.Selected).newElementId;
        setSelectedType(id ? workspace.getBlockById(id)?.type : undefined);
      }
      if (event.isUiEvent) return;
      window.clearTimeout(previewTimer.current);
      previewTimer.current = window.setTimeout(previewNow, 250);
      window.clearTimeout(autosaveTimer.current);
      autosaveTimer.current = window.setTimeout(autosave, 700);
    };

    previewNow();
    workspace.addChangeListener(onChange);
    observer = new ResizeObserver(() => Blockly.svgResize(workspace));
    observer.observe(container);
    requestAnimationFrame(() => fitWorkspaceView(workspace, toolboxVisibleRef.current ? undefined : MOBILE_WORKSPACE_SCALE));

    return () => {
      window.clearTimeout(previewTimer.current);
      window.clearTimeout(autosaveTimer.current);
      workspace.removeChangeListener(onChange);
      observer?.disconnect();
      workspace.dispose();
      workspaceRef.current = null;
      previewRef.current = () => undefined;
    };
  }, []);

  useEffect(() => {
    workspaceRef.current?.setTheme(options.theme === "light" ? forgeLight : forgeDark);
  }, [options.theme]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const toolboxVisible = options.toolboxVisible !== false;
    workspace.getToolbox()?.setVisible(toolboxVisible);
    fitWorkspaceView(workspace, toolboxVisible ? undefined : MOBILE_WORKSPACE_SCALE);
  }, [options.toolboxVisible]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    const artifact = options.activeArtifact;
    if (!workspace || !artifact) return;
    try {
      workspace.clear();
      Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(artifact.xml), workspace);
      setInitError(undefined);
      setSavedAt(undefined);
      requestAnimationFrame(() => {
        fitWorkspaceView(workspace, toolboxVisibleRef.current ? undefined : MOBILE_WORKSPACE_SCALE);
        previewRef.current();
      });
    } catch (cause) {
      setInitError(cause instanceof Error ? cause.message : "Selected logic failed to load");
    }
  }, [options.activeArtifact?.id]);

  const saveNow = () => {
    const workspace = workspaceRef.current;
    const artifact = options.activeArtifact;
    if (!workspace || !artifact) return;
    options.onSaveArtifact(serializeArtifact(workspace, artifact));
    setSavedAt(Date.now());
  };

  const sharePayload = () => {
    const workspace = workspaceRef.current;
    if (!workspace) return undefined;
    return {
      name: extractWorkspaceName(workspace) || options.activeArtifact?.name || "Strategy",
      xml: Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(workspace))
    };
  };

  const focusDiagnostic = (blockId?: string) => {
    const workspace = workspaceRef.current;
    if (!workspace || !blockId) return;
    const block = workspace.getBlockById(blockId);
    if (!block) return;
    Blockly.common.setSelected(block);
    workspace.centerOnBlock(blockId, true);
  };

  return {
    containerRef,
    workspaceRef,
    preview,
    selectedType,
    strategyInputs,
    jsonSize,
    compileErrors,
    compileDiagnostics,
    focusDiagnostic,
    initError,
    savedAt,
    saveNow,
    sharePayload
  };
}

function serializeArtifact(workspace: Blockly.WorkspaceSvg, artifact: StrategyArtifact): StrategyArtifact {
  const compiled = compileWorkspace(workspace);
  return {
    ...artifact,
    name: extractWorkspaceName(workspace) || artifact.name,
    xml: Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(workspace)),
    code: compiled.ir ? irToText(compiled.ir) : "",
    irHash: compiled.ir ? artifactIrHash(compiled.ir) : undefined,
    parameters: compiled.ir?.inputs,
    updatedAt: Date.now()
  };
}

function extractWorkspaceName(workspace: Blockly.WorkspaceSvg) {
  return workspace
    .getTopBlocks(false)
    .find((block) => block.type === "strategy_start")
    ?.getFieldValue("NAME") as string | undefined;
}

function fitWorkspaceView(workspace: Blockly.WorkspaceSvg, preferredScale?: number) {
  Blockly.svgResize(workspace);
  requestAnimationFrame(() => {
    if (preferredScale) {
      workspace.setScale(preferredScale);
      const entryBlock = workspace.getTopBlocks(true)[0];
      if (entryBlock) {
        const origin = entryBlock.getRelativeToSurfaceXY();
        workspace.scroll(16 - origin.x * preferredScale, 76 - origin.y * preferredScale);
      } else {
        workspace.scrollCenter();
      }
      return;
    }
    workspace.zoomToFit();
    workspace.scrollCenter();
  });
}
