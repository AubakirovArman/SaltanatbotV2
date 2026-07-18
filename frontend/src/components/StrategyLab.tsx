import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useEffect, useState } from "react";
import type { PineImport } from "../strategy/pine";
import { buildShareUrl } from "../strategy/share";
import type { BacktestResult, PlotSeries, ShapeOverlays } from "../strategy/backtest";
import type { StrategyArtifact, StrategyArtifactKind } from "../strategy/library";
import type { StrategyTemplate } from "../strategy/templates";
import type { CatalogResponse, DataExchange, Timeframe } from "../types";
import type { Locale } from "../i18n";
import { strategyText } from "../i18n/strategy";
import { MOBILE_SHELL_MEDIA_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import { StrategyLibrary } from "../strategy/components/StrategyLibrary";
import { StrategyExecutionPanel } from "../strategy/components/StrategyExecutionPanel";
import { PineSourceComparison } from "../strategy/components/PineSourceComparison";
import { useStrategyResearch } from "../strategy/useStrategyResearch";
import { useStrategyWorkspace } from "../strategy/useStrategyWorkspace";
import type { PortableStrategyArtifact } from "../strategy/strategyFile";
import { galleryRevalidationPending, type GalleryImportDraft } from "../strategy/galleryImport";
import type { VerifiedPlugin } from "@saltanatbotv2/plugin-core";
import type { PwaFileLaunchBatch } from "../pwa/fileLaunch";
import "../styles/strategy.css";

interface StrategyLabProps {
  artifacts: StrategyArtifact[];
  activeArtifactId: string;
  onSelectArtifact: (id: string) => void;
  onCreateArtifact: (kind: StrategyArtifactKind) => void;
  onSaveArtifact: (artifact: StrategyArtifact) => void;
  onUseTemplate: (template: StrategyTemplate) => void;
  onImportStrategy: (input: PortableStrategyArtifact) => void;
  onImportGalleryStrategy: (draft: GalleryImportDraft) => void;
  onImportPlugin: (input: VerifiedPlugin) => void;
  onUninstallPlugin: (key: string) => boolean;
  onImportPineMany: (inputs: PineImport[]) => void;
  launchedBatch?: PwaFileLaunchBatch;
  onLaunchedBatchConsumed?: () => void;
  onRollbackArtifact: (id: string, version: number) => void;
  /** A successful local validation + backtest of a gallery copy opens its paper-start gate. */
  onArtifactRevalidated?: (id: string) => void;
  onUpdateArtifactDependencies: (id: string, dependencies: string[]) => void;
  catalog?: CatalogResponse;
  initialSymbol: string;
  initialTimeframe: Timeframe;
  exchange?: DataExchange;
  theme?: "dark" | "light";
  locale: Locale;
  storageOwnerId?: string;
  onApplyResult?: (result: BacktestResult, symbol: string, timeframe: Timeframe, visuals: { plots: PlotSeries[]; shapes: ShapeOverlays } | undefined, exchange: DataExchange) => void;
  onBacktestCompleted?: () => void;
  onShowOnChart?: (symbol: string, timeframe: Timeframe) => void;
  onOpenTrading?: () => void;
}

type MobileStrategyPane = "library" | "editor" | "parameters";

export function StrategyLab({
  artifacts,
  activeArtifactId,
  onSelectArtifact,
  onCreateArtifact,
  onSaveArtifact,
  onUseTemplate,
  onImportStrategy,
  onImportGalleryStrategy,
  onImportPlugin,
  onUninstallPlugin,
  onImportPineMany,
  launchedBatch,
  onLaunchedBatchConsumed,
  onRollbackArtifact,
  onArtifactRevalidated,
  onUpdateArtifactDependencies,
  catalog,
  initialSymbol,
  initialTimeframe,
  exchange = "binance",
  theme = "dark",
  locale,
  storageOwnerId,
  onApplyResult,
  onBacktestCompleted,
  onShowOnChart,
  onOpenTrading
}: StrategyLabProps) {
  const activeArtifact = artifacts.find((artifact) => artifact.id === activeArtifactId) ?? artifacts[0];
  const mobileLayout = useMediaQuery(MOBILE_SHELL_MEDIA_QUERY);
  const [toolboxOpen, setToolboxOpen] = useState(false);
  const workspace = useStrategyWorkspace({ activeArtifact, onSaveArtifact, theme, toolboxVisible: !mobileLayout || toolboxOpen });
  const research = useStrategyResearch({
    workspaceRef: workspace.workspaceRef,
    strategyInputs: workspace.strategyInputs,
    initialSymbol,
    initialTimeframe,
    exchange,
    onApplyResult,
    // A completed backtest implies the compile validation passed, so a pending
    // gallery revalidation gate on the active copy opens here — the only seam
    // that unlocks paper start for imported gallery artifacts.
    onBacktestCompleted: () => {
      onBacktestCompleted?.();
      if (activeArtifact && galleryRevalidationPending(activeArtifact)) onArtifactRevalidated?.(activeArtifact.id);
    }
  });
  const [shareState, setShareState] = useState<"idle" | "copied">("idle");
  const [mobilePane, setMobilePane] = useState<MobileStrategyPane>("editor");
  const instrument = catalog?.instruments.find((item) => item.symbol === research.symbol);
  const errors = [...new Set([...workspace.compileErrors, ...research.errors])];
  const diagnostics = [...workspace.compileDiagnostics, ...research.errors.filter((message) => !workspace.compileErrors.includes(message)).map((message) => ({ severity: "error" as const, message }))];

  useEffect(() => {
    research.clearResult();
    // The research result belongs to one artifact and must never leak to the next.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeArtifact?.id]);

  useEffect(() => {
    if (mobileLayout) setToolboxOpen(false);
  }, [mobileLayout]);

  const shareNow = () => {
    const payload = workspace.sharePayload();
    if (!payload) return;
    const url = buildShareUrl(payload);
    const done = () => {
      setShareState("copied");
      window.setTimeout(() => setShareState("idle"), 2_200);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done).catch(done);
    else done();
  };

  return (
    <section className="strategy-lab">
      <nav className="strategy-mobile-tabs" aria-label={strategyText(locale, "mobileStudioPanels")}>
        <button type="button" className={mobilePane === "library" ? "is-active" : undefined} aria-pressed={mobilePane === "library"} onClick={() => setMobilePane("library")}>
          {strategyText(locale, "mobileStudioLibrary")}
        </button>
        <button type="button" className={mobilePane === "editor" ? "is-active" : undefined} aria-pressed={mobilePane === "editor"} onClick={() => setMobilePane("editor")}>
          {strategyText(locale, "mobileStudioEditor")}
        </button>
        <button type="button" className={mobilePane === "parameters" ? "is-active" : undefined} aria-pressed={mobilePane === "parameters"} onClick={() => setMobilePane("parameters")}>
          {strategyText(locale, "mobileStudioParameters")}
        </button>
      </nav>
      <div className="strategy-grid" data-mobile-pane={mobilePane}>
        <StrategyLibrary
          locale={locale}
          storageOwnerId={storageOwnerId}
          artifacts={artifacts}
          activeId={activeArtifact?.id}
          onSelect={(id) => {
            onSelectArtifact(id);
            setMobilePane("editor");
          }}
          onCreate={(kind) => {
            onCreateArtifact(kind);
            setMobilePane("editor");
          }}
          onUseTemplate={(template) => {
            onUseTemplate(template);
            setMobilePane("editor");
          }}
          onImportStrategy={(input) => {
            onImportStrategy(input);
            setMobilePane("editor");
          }}
          onImportGalleryStrategy={(draft) => {
            onImportGalleryStrategy(draft);
            setMobilePane("editor");
          }}
          onImportPlugin={(input) => {
            onImportPlugin(input);
            setMobilePane("editor");
          }}
          onUninstallPlugin={onUninstallPlugin}
          onImportPineMany={(inputs) => {
            onImportPineMany(inputs);
            setMobilePane("editor");
          }}
          launchedBatch={launchedBatch}
          onLaunchedBatchConsumed={onLaunchedBatchConsumed}
        />
        <div className={`strategy-authoring${activeArtifact?.pine ? " has-pine-source" : ""}`}>
          {activeArtifact?.pine && <PineSourceComparison locale={locale} pine={activeArtifact.pine} />}
          <div className="blockly-shell">
            <button type="button" className="blockly-mobile-toolbox-toggle" aria-expanded={toolboxOpen} onClick={() => setToolboxOpen((open) => !open)}>
              {toolboxOpen ? <PanelLeftClose size={18} aria-hidden="true" /> : <PanelLeftOpen size={18} aria-hidden="true" />}
              {strategyText(locale, toolboxOpen ? "hideBlockLibrary" : "showBlockLibrary")}
            </button>
            {activeArtifact?.pine && <span className="blockly-panel-label">{strategyText(locale, "generatedBlocks")}</span>}
            <div className="blockly-host" ref={workspace.containerRef} />
            {workspace.initError && (
              <div className="strategy-error" role="alert">
                <strong>{strategyText(locale, "editorFailed")}</strong>
                <span>{workspace.initError}</span>
              </div>
            )}
          </div>
        </div>
        <StrategyExecutionPanel
          locale={locale}
          activeArtifact={activeArtifact}
          artifacts={artifacts}
          onRollbackArtifact={(version) => activeArtifact && onRollbackArtifact(activeArtifact.id, version)}
          onDependenciesChange={(dependencies) => activeArtifact && onUpdateArtifactDependencies(activeArtifact.id, dependencies)}
          selectedType={workspace.selectedType}
          running={research.running}
          optimizing={research.optimizing}
          onRun={() => void research.run()}
          onToggleOptimize={() => research.setOptOpen((value) => !value)}
          onShare={shareNow}
          onSave={workspace.saveNow}
          shareState={shareState}
          strategyInputs={workspace.strategyInputs}
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
          portfolioEnabled={research.portfolioEnabled}
          onPortfolioEnabledChange={research.setPortfolioEnabled}
          portfolioSymbols={research.portfolioSymbols}
          onPortfolioSymbolsChange={research.setPortfolioSymbols}
          portfolioConfig={research.portfolioConfig}
          onPortfolioConfigChange={research.setPortfolioConfig}
          optSpec={research.optSpec}
          onOptSpecChange={research.setOptSpec}
          onOptimize={() => void research.optimize()}
          onCancelOptimize={research.cancelOptimization}
          optProgress={research.optProgress}
          walkForwardOn={research.walkForwardOn}
          onToggleWalkForward={research.setWalkForwardOn}
          optFolds={research.optFolds}
          onFoldsChange={research.setOptFolds}
          walkForwardMode={research.walkForwardMode}
          onWalkForwardModeChange={research.setWalkForwardMode}
          optimizeResult={research.optimizeResult}
          optimizationMode={research.optimizationMode}
          onOptimizationModeChange={research.setOptimizationMode}
          geneticConfig={research.geneticConfig}
          onGeneticConfigChange={research.setGeneticConfig}
          geneticResult={research.geneticResult}
          geneticProgress={research.geneticProgress}
          walkForwardResult={research.walkForwardResult}
          onApplyCombo={research.applyCombo}
          errors={errors}
          diagnostics={diagnostics}
          onDiagnosticSelect={workspace.focusDiagnostic}
          result={research.result}
          portfolioResult={research.portfolioResult}
          galleryRevalidationPending={galleryRevalidationPending(activeArtifact)}
          decimals={instrument?.decimals ?? 2}
          onShowOnChart={onShowOnChart ? () => onShowOnChart(research.symbol, research.timeframe) : undefined}
          onOpenTrading={onOpenTrading}
          jsonSize={workspace.jsonSize}
          preview={workspace.preview}
          savedAt={workspace.savedAt}
        />
      </div>
    </section>
  );
}
