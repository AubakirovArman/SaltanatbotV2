import { useEffect, useState } from "react";
import type { PineImport } from "../strategy/pine";
import { buildShareUrl } from "../strategy/share";
import type { BacktestResult, PlotSeries, ShapeOverlays } from "../strategy/backtest";
import type { StrategyArtifact, StrategyArtifactKind } from "../strategy/library";
import type { StrategyTemplate } from "../strategy/templates";
import type { CatalogResponse, DataExchange, Timeframe } from "../types";
import type { Locale } from "../i18n";
import { strategyText } from "../i18n/strategy";
import { StrategyLibrary } from "../strategy/components/StrategyLibrary";
import { StrategyExecutionPanel } from "../strategy/components/StrategyExecutionPanel";
import { PineSourceComparison } from "../strategy/components/PineSourceComparison";
import { useStrategyResearch } from "../strategy/useStrategyResearch";
import { useStrategyWorkspace } from "../strategy/useStrategyWorkspace";
import type { PortableStrategyArtifact } from "../strategy/strategyFile";
import type { VerifiedPlugin } from "@saltanatbotv2/plugin-core";
import type { PwaFileLaunchBatch } from "../pwa/fileLaunch";

interface StrategyLabProps {
  artifacts: StrategyArtifact[];
  activeArtifactId: string;
  onSelectArtifact: (id: string) => void;
  onCreateArtifact: (kind: StrategyArtifactKind) => void;
  onSaveArtifact: (artifact: StrategyArtifact) => void;
  onUseTemplate: (template: StrategyTemplate) => void;
  onImportStrategy: (input: PortableStrategyArtifact) => void;
  onImportPlugin: (input: VerifiedPlugin) => void;
  onUninstallPlugin: (key: string) => boolean;
  onImportPineMany: (inputs: PineImport[]) => void;
  launchedBatch?: PwaFileLaunchBatch;
  onLaunchedBatchConsumed?: () => void;
  onRollbackArtifact: (id: string, version: number) => void;
  onUpdateArtifactDependencies: (id: string, dependencies: string[]) => void;
  catalog?: CatalogResponse;
  initialSymbol: string;
  initialTimeframe: Timeframe;
  exchange?: DataExchange;
  theme?: "dark" | "light";
  locale: Locale;
  onApplyResult?: (
    result: BacktestResult,
    symbol: string,
    timeframe: Timeframe,
    visuals?: { plots: PlotSeries[]; shapes: ShapeOverlays }
  ) => void;
  onShowOnChart?: (symbol: string, timeframe: Timeframe) => void;
  onOpenTrading?: () => void;
}

export function StrategyLab({
  artifacts,
  activeArtifactId,
  onSelectArtifact,
  onCreateArtifact,
  onSaveArtifact,
  onUseTemplate,
  onImportStrategy,
  onImportPlugin,
  onUninstallPlugin,
  onImportPineMany,
  launchedBatch,
  onLaunchedBatchConsumed,
  onRollbackArtifact,
  onUpdateArtifactDependencies,
  catalog,
  initialSymbol,
  initialTimeframe,
  exchange = "binance",
  theme = "dark",
  locale,
  onApplyResult,
  onShowOnChart,
  onOpenTrading
}: StrategyLabProps) {
  const activeArtifact = artifacts.find((artifact) => artifact.id === activeArtifactId) ?? artifacts[0];
  const workspace = useStrategyWorkspace({ activeArtifact, onSaveArtifact, theme });
  const research = useStrategyResearch({
    workspaceRef: workspace.workspaceRef,
    strategyInputs: workspace.strategyInputs,
    initialSymbol,
    initialTimeframe,
    exchange,
    onApplyResult
  });
  const [shareState, setShareState] = useState<"idle" | "copied">("idle");
  const instrument = catalog?.instruments.find((item) => item.symbol === research.symbol);
  const errors = [...new Set([...workspace.compileErrors, ...research.errors])];
  const diagnostics = [
    ...workspace.compileDiagnostics,
    ...research.errors.filter((message) => !workspace.compileErrors.includes(message)).map((message) => ({ severity: "error" as const, message }))
  ];

  useEffect(() => {
    research.clearResult();
    // The research result belongs to one artifact and must never leak to the next.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeArtifact?.id]);

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
      <div className="strategy-grid">
        <StrategyLibrary
          locale={locale}
          artifacts={artifacts}
          activeId={activeArtifact?.id}
          onSelect={onSelectArtifact}
          onCreate={onCreateArtifact}
          onUseTemplate={onUseTemplate}
          onImportStrategy={onImportStrategy}
          onImportPlugin={onImportPlugin}
          onUninstallPlugin={onUninstallPlugin}
          onImportPineMany={onImportPineMany}
          launchedBatch={launchedBatch}
          onLaunchedBatchConsumed={onLaunchedBatchConsumed}
        />
        <div className={`strategy-authoring${activeArtifact?.pine ? " has-pine-source" : ""}`}>
          {activeArtifact?.pine && <PineSourceComparison locale={locale} pine={activeArtifact.pine} />}
          <div className="blockly-shell">
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
          optProgress={research.optProgress}
          walkForwardOn={research.walkForwardOn}
          onToggleWalkForward={research.setWalkForwardOn}
          optFolds={research.optFolds}
          onFoldsChange={research.setOptFolds}
          walkForwardMode={research.walkForwardMode}
          onWalkForwardModeChange={research.setWalkForwardMode}
          optimizeResult={research.optimizeResult}
          walkForwardResult={research.walkForwardResult}
          onApplyCombo={research.applyCombo}
          errors={errors}
          diagnostics={diagnostics}
          onDiagnosticSelect={workspace.focusDiagnostic}
          result={research.result}
          portfolioResult={research.portfolioResult}
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
