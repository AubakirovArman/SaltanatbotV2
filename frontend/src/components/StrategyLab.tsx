import { useEffect, useState } from "react";
import type { PineImport } from "../strategy/pine";
import { buildShareUrl } from "../strategy/share";
import type { BacktestResult, PlotSeries, ShapeOverlays } from "../strategy/backtest";
import type { StrategyArtifact, StrategyArtifactKind } from "../strategy/library";
import type { StrategyTemplate } from "../strategy/templates";
import type { CatalogResponse, DataExchange, Timeframe } from "../types";
import { StrategyLibrary } from "../strategy/components/StrategyLibrary";
import { StrategyExecutionPanel } from "../strategy/components/StrategyExecutionPanel";
import { useStrategyResearch } from "../strategy/useStrategyResearch";
import { useStrategyWorkspace } from "../strategy/useStrategyWorkspace";

interface StrategyLabProps {
  artifacts: StrategyArtifact[];
  activeArtifactId: string;
  onSelectArtifact: (id: string) => void;
  onCreateArtifact: (kind: StrategyArtifactKind) => void;
  onSaveArtifact: (artifact: StrategyArtifact) => void;
  onUseTemplate: (template: StrategyTemplate) => void;
  onImportStrategy: (input: { name: string; description: string; xml: string }) => void;
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

export function StrategyLab({
  artifacts,
  activeArtifactId,
  onSelectArtifact,
  onCreateArtifact,
  onSaveArtifact,
  onUseTemplate,
  onImportStrategy,
  onImportPineMany,
  catalog,
  initialSymbol,
  initialTimeframe,
  exchange = "binance",
  theme = "dark",
  onApplyResult,
  onShowOnChart
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
          artifacts={artifacts}
          activeId={activeArtifact?.id}
          onSelect={onSelectArtifact}
          onCreate={onCreateArtifact}
          onUseTemplate={onUseTemplate}
          onImportStrategy={onImportStrategy}
          onImportPineMany={onImportPineMany}
        />
        <div className="blockly-shell">
          <div className="blockly-host" ref={workspace.containerRef} />
          {workspace.initError && (
            <div className="strategy-error" role="alert">
              <strong>Strategy editor did not start</strong>
              <span>{workspace.initError}</span>
            </div>
          )}
        </div>
        <StrategyExecutionPanel
          activeArtifact={activeArtifact}
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
          errors={errors}
          result={research.result}
          decimals={instrument?.decimals ?? 2}
          onShowOnChart={onShowOnChart ? () => onShowOnChart(research.symbol, research.timeframe) : undefined}
          jsonSize={workspace.jsonSize}
          preview={workspace.preview}
          savedAt={workspace.savedAt}
        />
      </div>
    </section>
  );
}
