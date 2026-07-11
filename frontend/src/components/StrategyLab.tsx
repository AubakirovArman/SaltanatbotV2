import { useEffect, useRef, useState } from "react";
import * as Blockly from "blockly/core";
import * as En from "blockly/msg/en";
import { registerStrategyBlocks, strategyToolbox } from "../strategy/blocks";
import type { PineImport } from "../strategy/pine";
import { compileWorkspace } from "../strategy/compile";
import { buildShareUrl } from "../strategy/share";
import { irToText } from "../strategy/irText";
import type { BacktestResult, PlotSeries, ShapeOverlays } from "../strategy/backtest";
import type { StrategyArtifact, StrategyArtifactKind } from "../strategy/library";
import type { StrategyTemplate } from "../strategy/templates";
import type { StrategyIR } from "../strategy/ir";
import type { CatalogResponse, DataExchange, Timeframe } from "../types";
import { StrategyLibrary } from "../strategy/components/StrategyLibrary";
import { StrategyExecutionPanel } from "../strategy/components/StrategyExecutionPanel";
import { useStrategyResearch } from "../strategy/useStrategyResearch";

const blocklyMessages = Object.fromEntries(Object.entries(En).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
let localeReady = false;

const blocklyFont = {
  family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  weight: "500",
  size: 11
};

const forgeDark = Blockly.Theme.defineTheme("forge-dark", {
  name: "forge-dark",
  base: Blockly.Themes.Classic,
  componentStyles: {
    workspaceBackgroundColour: "#0e1116",
    toolboxBackgroundColour: "#10141a",
    toolboxForegroundColour: "#9aa7b3",
    flyoutBackgroundColour: "#151a21",
    flyoutForegroundColour: "#9aa7b3",
    flyoutOpacity: 0.97,
    scrollbarColour: "#222933",
    scrollbarOpacity: 0.45,
    insertionMarkerColour: "#4db6ff",
    insertionMarkerOpacity: 0.35,
    cursorColour: "#4db6ff"
  },
  fontStyle: blocklyFont
});

const forgeLight = Blockly.Theme.defineTheme("forge-light", {
  name: "forge-light",
  base: Blockly.Themes.Classic,
  componentStyles: {
    workspaceBackgroundColour: "#f7f9fb",
    toolboxBackgroundColour: "#ffffff",
    toolboxForegroundColour: "#5f6d7a",
    flyoutBackgroundColour: "#eef1f5",
    flyoutForegroundColour: "#5f6d7a",
    flyoutOpacity: 0.97,
    scrollbarColour: "#c9d2db",
    scrollbarOpacity: 0.55,
    insertionMarkerColour: "#1273c4",
    insertionMarkerOpacity: 0.35,
    cursorColour: "#1273c4"
  },
  fontStyle: blocklyFont
});

interface StrategyLabProps {
  artifacts: StrategyArtifact[];
  activeArtifactId: string;
  onSelectArtifact: (id: string) => void;
  onCreateArtifact: (kind: StrategyArtifactKind) => void;
  onSaveArtifact: (artifact: StrategyArtifact) => void;
  /** Instantiate a gallery template as a new editable copy and select it. */
  onUseTemplate: (template: StrategyTemplate) => void;
  /** Import a validated `.strategy` file as a new editable artifact and select it. */
  onImportStrategy: (input: { name: string; description: string; xml: string }) => void;
  /** Import one or more converted Pine Scripts (paste + uploaded files) as new
   *  editable artifacts, selecting the first. */
  onImportPineMany: (inputs: PineImport[]) => void;
  catalog?: CatalogResponse;
  initialSymbol: string;
  initialTimeframe: Timeframe;
  exchange?: DataExchange;
  theme?: "dark" | "light";
  onApplyResult?: (
    result: BacktestResult,
    symbol: string,
    timeframe: Timeframe,
    visuals?: { plots: PlotSeries[]; shapes: ShapeOverlays }
  ) => void;
  onShowOnChart?: (symbol: string, timeframe: Timeframe) => void;
}

export function StrategyLab({ artifacts, activeArtifactId, onSelectArtifact, onCreateArtifact, onSaveArtifact, onUseTemplate, onImportStrategy, onImportPineMany, catalog, initialSymbol, initialTimeframe, exchange = "binance", theme = "dark", onApplyResult, onShowOnChart }: StrategyLabProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  const previewRef = useRef<() => void>(() => undefined);
  const autosaveTimer = useRef<number>();
  const previewTimer = useRef<number>();
  const onSaveRef = useRef(onSaveArtifact);
  const activeRef = useRef<StrategyArtifact>();

  const [preview, setPreview] = useState("");
  const [selectedType, setSelectedType] = useState<string>();
  const [strategyInputs, setStrategyInputs] = useState<StrategyIR["inputs"]>([]);
  const [jsonSize, setJsonSize] = useState(0);
  const [initError, setInitError] = useState<string>();
  const [savedAt, setSavedAt] = useState<number>();
  const [shareState, setShareState] = useState<"idle" | "copied">("idle");
  const research = useStrategyResearch({
    workspaceRef,
    strategyInputs,
    initialSymbol,
    initialTimeframe,
    exchange,
    onApplyResult
  });

  const btInstrument = catalog?.instruments.find((item) => item.symbol === research.symbol);
  const decimals = btInstrument?.decimals ?? 2;

  const activeArtifact = artifacts.find((artifact) => artifact.id === activeArtifactId) ?? artifacts[0];
  onSaveRef.current = onSaveArtifact;
  activeRef.current = activeArtifact;

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

    const doPreview = () => {
      const compiled = compileWorkspace(workspace);
      setPreview(compiled.ir ? irToText(compiled.ir) : "");
      setStrategyInputs(compiled.ir ? compiled.ir.inputs : []);
      research.setErrors(compiled.errors);
      setJsonSize(JSON.stringify(Blockly.serialization.workspaces.save(workspace)).length);
    };
    previewRef.current = doPreview;

    const autosave = () => {
      const art = activeRef.current;
      if (!art) return;
      const xml = Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(workspace));
      const compiled = compileWorkspace(workspace);
      onSaveRef.current({
        ...art,
        name: extractWorkspaceName(workspace) || art.name,
        xml,
        code: compiled.ir ? irToText(compiled.ir) : "",
        updatedAt: Date.now()
      });
      setSavedAt(Date.now());
    };

    const onChange = (event: Blockly.Events.Abstract) => {
      if (event.type === Blockly.Events.SELECTED) {
        const id = (event as Blockly.Events.Selected).newElementId;
        const block = id ? workspace.getBlockById(id) : null;
        setSelectedType(block?.type ?? undefined);
      }
      if (event.isUiEvent) return;
      window.clearTimeout(previewTimer.current);
      previewTimer.current = window.setTimeout(doPreview, 250);
      window.clearTimeout(autosaveTimer.current);
      autosaveTimer.current = window.setTimeout(autosave, 700);
    };

    doPreview();
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

  // Keep the Blockly theme in sync with the app theme.
  useEffect(() => {
    workspaceRef.current?.setTheme(theme === "light" ? forgeLight : forgeDark);
  }, [theme]);

  // Load the active artifact into the workspace when the selection changes.
  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || !activeArtifact) return;
    try {
      workspace.clear();
      Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(activeArtifact.xml), workspace);
      setInitError(undefined);
      setSavedAt(undefined);
      research.clearResult();
      requestAnimationFrame(() => {
        fitWorkspaceView(workspace);
        previewRef.current();
      });
    } catch (cause) {
      setInitError(cause instanceof Error ? cause.message : "Selected logic failed to load");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeArtifact?.id]);

  const saveNow = () => {
    const workspace = workspaceRef.current;
    if (!workspace || !activeArtifact) return;
    const xml = Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(workspace));
    const compiled = compileWorkspace(workspace);
    onSaveArtifact({
      ...activeArtifact,
      name: extractWorkspaceName(workspace) || activeArtifact.name,
      xml,
      code: compiled.ir ? irToText(compiled.ir) : "",
      updatedAt: Date.now()
    });
    setSavedAt(Date.now());
  };

  const shareNow = () => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const xml = Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(workspace));
    const name = extractWorkspaceName(workspace) || activeArtifact?.name || "Strategy";
    const url = buildShareUrl({ name, xml });
    const done = () => {
      setShareState("copied");
      window.setTimeout(() => setShareState("idle"), 2200);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done).catch(done);
    else done();
  };

  return (
    <section className="strategy-lab">
      <div className="strategy-grid">
        <StrategyLibrary artifacts={artifacts} activeId={activeArtifact?.id} onSelect={onSelectArtifact} onCreate={onCreateArtifact} onUseTemplate={onUseTemplate} onImportStrategy={onImportStrategy} onImportPineMany={onImportPineMany} />
        <div className="blockly-shell">
          <div className="blockly-host" ref={containerRef} />
          {initError && (
            <div className="strategy-error" role="alert">
              <strong>Strategy editor did not start</strong>
              <span>{initError}</span>
            </div>
          )}
        </div>
        <StrategyExecutionPanel
          activeArtifact={activeArtifact}
          selectedType={selectedType}
          running={research.running}
          optimizing={research.optimizing}
          onRun={() => void research.run()}
          onToggleOptimize={() => research.setOptOpen((value) => !value)}
          onShare={shareNow}
          onSave={saveNow}
          shareState={shareState}
          strategyInputs={strategyInputs}
          optOpen={research.optOpen}
          catalog={catalog}
          symbol={research.symbol}
          onSymbolChange={research.setSymbol}
          timeframe={research.timeframe}
          onTimeframeChange={research.setTimeframe}
          bars={research.bars}
          onBarsChange={research.setBars}
          config={research.config}
          onConfigChange={research.setConfig}
          optSpec={research.optSpec}
          onOptSpecChange={research.setOptSpec}
          onOptimize={() => void research.optimize()}
          optProgress={research.optProgress}
          walkForwardOn={research.walkForwardOn}
          onToggleWalkForward={research.setWalkForwardOn}
          optFolds={research.optFolds}
          onFoldsChange={research.setOptFolds}
          optimizeResult={research.optimizeResult}
          walkForwardResult={research.walkForwardResult}
          onApplyCombo={research.applyCombo}
          errors={research.errors}
          result={research.result}
          decimals={decimals}
          onShowOnChart={onShowOnChart ? () => onShowOnChart(research.symbol, research.timeframe) : undefined}
          jsonSize={jsonSize}
          preview={preview}
          savedAt={savedAt}
        />
      </div>
    </section>
  );
}

function extractWorkspaceName(workspace: Blockly.WorkspaceSvg) {
  const root = workspace.getTopBlocks(false).find((block) => block.type === "strategy_start");
  return root?.getFieldValue("NAME") as string | undefined;
}

function fitWorkspaceView(workspace: Blockly.WorkspaceSvg) {
  Blockly.svgResize(workspace);
  requestAnimationFrame(() => {
    workspace.zoomToFit();
    workspace.scrollCenter();
  });
}
