import * as Blockly from "blockly/core";
import * as En from "blockly/msg/en";
import { useEffect, useRef, useState } from "react";
import { registerStrategyBlocks, strategyToolbox } from "./blocks";
import { forgeDark, forgeLight } from "./blocklyTheme";
import { compileWorkspace } from "./compile";
import type { StrategyIR } from "./ir";
import { irToText } from "./irText";
import type { StrategyArtifact } from "./library";

const blocklyMessages = Object.fromEntries(Object.entries(En).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
let localeReady = false;

interface UseStrategyWorkspaceOptions {
  activeArtifact?: StrategyArtifact;
  onSaveArtifact: (artifact: StrategyArtifact) => void;
  theme: "dark" | "light";
}

export function useStrategyWorkspace(options: UseStrategyWorkspaceOptions) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  const previewRef = useRef<() => void>(() => undefined);
  const autosaveTimer = useRef<number>();
  const previewTimer = useRef<number>();
  const onSaveRef = useRef(options.onSaveArtifact);
  const activeRef = useRef(options.activeArtifact);
  const [preview, setPreview] = useState("");
  const [selectedType, setSelectedType] = useState<string>();
  const [strategyInputs, setStrategyInputs] = useState<StrategyIR["inputs"]>([]);
  const [jsonSize, setJsonSize] = useState(0);
  const [compileErrors, setCompileErrors] = useState<string[]>([]);
  const [initError, setInitError] = useState<string>();
  const [savedAt, setSavedAt] = useState<number>();
  onSaveRef.current = options.onSaveArtifact;
  activeRef.current = options.activeArtifact;

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
    requestAnimationFrame(() => fitWorkspaceView(workspace));

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
    const artifact = options.activeArtifact;
    if (!workspace || !artifact) return;
    try {
      workspace.clear();
      Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(artifact.xml), workspace);
      setInitError(undefined);
      setSavedAt(undefined);
      requestAnimationFrame(() => {
        fitWorkspaceView(workspace);
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

  return {
    containerRef,
    workspaceRef,
    preview,
    selectedType,
    strategyInputs,
    jsonSize,
    compileErrors,
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
    updatedAt: Date.now()
  };
}

function extractWorkspaceName(workspace: Blockly.WorkspaceSvg) {
  return workspace.getTopBlocks(false).find((block) => block.type === "strategy_start")?.getFieldValue("NAME") as string | undefined;
}

function fitWorkspaceView(workspace: Blockly.WorkspaceSvg) {
  Blockly.svgResize(workspace);
  requestAnimationFrame(() => {
    workspace.zoomToFit();
    workspace.scrollCenter();
  });
}
