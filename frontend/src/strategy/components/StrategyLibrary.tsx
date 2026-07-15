import { Boxes, Dna, Download, FileCode2, LayoutGrid, PackageOpen, PackagePlus, Plus, ShieldAlert, Upload, WandSparkles, X } from "lucide-react";
import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { PineImportDialog } from "../../components/PineImportDialog";
import type { PineImport } from "../pine";
import type { StrategyArtifact, StrategyArtifactKind } from "../library";
import { strategyTemplates, type StrategyTemplate, type TemplateCategory } from "../templates";
import { downloadStrategyFile, type PortableStrategyArtifact } from "../strategyFile";
import type { Locale } from "../../i18n";
import { strategyCategory, strategyText } from "../../i18n/strategy";
import { StrategyWizard } from "./StrategyWizard";
import { useModalFocus } from "../../hooks/useModalFocus";
import type { VerifiedPlugin } from "@saltanatbotv2/plugin-core";
import { PluginImportReviewDialog } from "./PluginImportReviewDialog";
import { PluginExportDialog } from "./PluginExportDialog";
import { PluginCatalogDialog } from "./PluginCatalogDialog";
import { analyzePluginImport, installedPlugins } from "../pluginCatalog";
import { trustPluginKey } from "../pluginTrust";
import type { PwaFileLaunchBatch } from "../../pwa/fileLaunch";
import { useImportReviewQueue } from "../useImportReviewQueue";
import { StrategyFileReviewDialog } from "./StrategyFileReviewDialog";

const GeneratorPanel = lazy(() => import("./GeneratorPanel").then((module) => ({ default: module.GeneratorPanel })));
const generatorEntryMessages = {
  en: { open: "Generator", openHelp: "Generate editable strategies with bounded algorithms and structural mutations", loading: "Loading strategy generator…" },
  ru: { open: "Генератор", openHelp: "Создавать редактируемые стратегии ограниченными алгоритмами и структурными мутациями", loading: "Загрузка генератора стратегий…" },
  kk: { open: "Генератор", openHelp: "Шектелген алгоритмдер және құрылымдық мутациялар арқылы өңделетін стратегиялар жасау", loading: "Стратегия генераторы жүктелуде…" }
} as const;

export function StrategyLibrary({
  locale,
  artifacts,
  activeId,
  onSelect,
  onCreate,
  onUseTemplate,
  onImportStrategy,
  onImportPlugin,
  onUninstallPlugin,
  onImportPineMany,
  launchedBatch,
  onLaunchedBatchConsumed
}: {
  locale: Locale;
  artifacts: StrategyArtifact[];
  activeId?: string;
  onSelect: (id: string) => void;
  onCreate: (kind: StrategyArtifactKind) => void;
  onUseTemplate: (template: StrategyTemplate) => void;
  onImportStrategy: (input: PortableStrategyArtifact) => void;
  onImportPlugin: (input: VerifiedPlugin) => void;
  onUninstallPlugin: (key: string) => boolean;
  onImportPineMany: (inputs: PineImport[]) => void;
  launchedBatch?: PwaFileLaunchBatch;
  onLaunchedBatchConsumed?: () => void;
}) {
  const indicators = artifacts.filter((artifact) => artifact.kind === "indicator");
  const strategies = artifacts.filter((artifact) => artifact.kind === "strategy");
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [pineOpen, setPineOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [pluginExportOpen, setPluginExportOpen] = useState(false);
  const [pluginCatalogOpen, setPluginCatalogOpen] = useState(false);
  const imports = useImportReviewQueue(locale);
  const { importError, importStatus, pendingPlugin, pendingStrategy, pendingPine } = imports;
  const importReviewActive = Boolean(launchedBatch || pendingPlugin || pendingStrategy || pendingPine.length);
  const installedPluginCount = installedPlugins(artifacts).length;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pluginInputRef = useRef<HTMLInputElement | null>(null);
  const preparingBatchId = useRef<number>();
  const pluginInputId = useId();

  useEffect(() => {
    if (!launchedBatch || preparingBatchId.current === launchedBatch.id) return;
    preparingBatchId.current = launchedBatch.id;
    void imports.prepareLaunchedBatch(launchedBatch).finally(() => onLaunchedBatchConsumed?.());
  }, [launchedBatch?.id]);

  return (
    <aside className="strategy-library">
      <div className="strategy-library-actions">
        <button type="button" onClick={() => onCreate("indicator")}>
          <Plus size={14} aria-hidden="true" /> {strategyText(locale, "indicator")}
        </button>
        <button type="button" onClick={() => onCreate("strategy")}>
          <Plus size={14} aria-hidden="true" /> {strategyText(locale, "strategy")}
        </button>
        <button type="button" onClick={() => setGalleryOpen(true)} title={strategyText(locale, "browseTemplates")}>
          <LayoutGrid size={14} aria-hidden="true" /> {strategyText(locale, "gallery")}
        </button>
        <button type="button" onClick={() => setWizardOpen(true)} title={strategyText(locale, "strategyWizard")}>
          <WandSparkles size={14} aria-hidden="true" /> {strategyText(locale, "wizard")}
        </button>
        <button type="button" onClick={() => setGeneratorOpen(true)} title={generatorEntryMessages[locale].openHelp}>
          <Dna size={14} aria-hidden="true" /> {generatorEntryMessages[locale].open}
        </button>
        <button type="button" onClick={() => fileInputRef.current?.click()} title={strategyText(locale, "importStrategy")}>
          <Upload size={14} aria-hidden="true" /> {strategyText(locale, "import")}
        </button>
        <button type="button" onClick={() => pluginInputRef.current?.click()} title={strategyText(locale, "importPluginHelp")}>
          <PackagePlus size={14} aria-hidden="true" /> {strategyText(locale, "plugin")}
        </button>
        <button type="button" onClick={() => setPluginExportOpen(true)} title={strategyText(locale, "exportPluginHelp")}>
          <PackageOpen size={14} aria-hidden="true" /> {strategyText(locale, "buildPlugin")}
        </button>
        <button type="button" onClick={() => setPineOpen(true)} title={strategyText(locale, "convertPine")}>
          <FileCode2 size={14} aria-hidden="true" /> {strategyText(locale, "pine")}
        </button>
        <button type="button" className="plugin-catalog-trigger" onClick={() => setPluginCatalogOpen(true)} title={strategyText(locale, "installedPluginsHelp")}>
          <Boxes size={14} aria-hidden="true" /> {strategyText(locale, "installedPlugins")} <span>{installedPluginCount}</span>
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".strategy,.json,application/json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void imports.prepareStrategyFile(file);
          event.target.value = "";
        }}
      />
      <label className="visually-hidden" htmlFor={pluginInputId}>{strategyText(locale, "importPlugin")}</label>
      <input
        ref={pluginInputRef}
        id={pluginInputId}
        className="visually-hidden"
        tabIndex={-1}
        name="strategy-plugin-file"
        type="file"
        accept=".saltanat-plugin,.json,application/json"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void imports.preparePluginFile(file);
          event.target.value = "";
        }}
      />
      <div className="strategy-library-messages">
        <p className="plugin-safety-note"><ShieldAlert size={13} aria-hidden="true" />{strategyText(locale, "pluginSafety")}</p>
        {importError && <div className="import-error" role="alert">{importError}</div>}
        {importStatus && <div className="import-status" role="status">{importStatus}</div>}
      </div>
      <div className="strategy-library-groups">
        <LibraryGroup locale={locale} title={strategyText(locale, "indicators")} items={indicators} activeId={activeId} onSelect={onSelect} />
        <LibraryGroup locale={locale} title={strategyText(locale, "strategies")} items={strategies} activeId={activeId} onSelect={onSelect} />
      </div>
      {!importReviewActive && pineOpen && (
        <PineImportDialog
          locale={locale}
          onClose={() => setPineOpen(false)}
          onImportMany={(results) => {
            setPineOpen(false);
            onImportPineMany(results);
          }}
        />
      )}
      {!importReviewActive && wizardOpen && (
        <StrategyWizard
          locale={locale}
          onClose={() => setWizardOpen(false)}
          onCreate={(artifact) => {
            onImportStrategy(artifact);
            setWizardOpen(false);
          }}
        />
      )}
      {!importReviewActive && generatorOpen && (
        <Suspense fallback={<p className="empty-note" role="status">{generatorEntryMessages[locale].loading}</p>}>
          <GeneratorPanel
            locale={locale}
            onClose={() => setGeneratorOpen(false)}
            onImport={(artifact) => {
              onImportStrategy(artifact);
              setGeneratorOpen(false);
            }}
          />
        </Suspense>
      )}
      {!importReviewActive && galleryOpen && (
        <TemplateGallery
          locale={locale}
          onClose={() => setGalleryOpen(false)}
          onUse={(template) => {
            onUseTemplate(template);
            setGalleryOpen(false);
          }}
        />
      )}
      {!launchedBatch && pendingPlugin && (
        <PluginImportReviewDialog
          locale={locale}
          plugin={pendingPlugin}
          analysis={analyzePluginImport(artifacts, pendingPlugin)}
          onClose={imports.shiftPlugin}
          onConfirm={(plugin, trustSigner) => {
            if (trustSigner && plugin.signature) trustPluginKey(plugin.signature.keyFingerprint, plugin.manifest.publisher.name);
            onImportPlugin(plugin);
            imports.setImportStatus(`${strategyText(locale, "pluginImported")}: ${plugin.manifest.name} · ${plugin.manifest.artifacts.length} ${strategyText(locale, "artifacts")}`);
            imports.shiftPlugin();
          }}
        />
      )}
      {!launchedBatch && !pendingPlugin && pendingStrategy && (
        <StrategyFileReviewDialog
          locale={locale}
          pending={pendingStrategy}
          onClose={imports.shiftStrategy}
          onConfirm={() => {
            onImportStrategy(pendingStrategy.artifact);
            imports.setImportStatus(`${strategyText(locale, "importReviewedStrategy")}: ${pendingStrategy.artifact.name}`);
            imports.shiftStrategy();
          }}
        />
      )}
      {!launchedBatch && !pendingPlugin && !pendingStrategy && pendingPine.length > 0 && (
        <PineImportDialog
          key={`pwa-pine-${pendingPine.map((file) => file.name).join("-")}`}
          locale={locale}
          initialFiles={pendingPine}
          onClose={imports.clearPendingPine}
          onImportMany={(results) => {
            imports.clearPendingPine();
            onImportPineMany(results);
          }}
        />
      )}
      {!importReviewActive && pluginExportOpen && (
        <PluginExportDialog
          locale={locale}
          artifacts={artifacts}
          activeId={activeId}
          onClose={() => setPluginExportOpen(false)}
          onExport={(manifest) => imports.setImportStatus(`${strategyText(locale, "pluginExported")}: ${manifest.name}`)}
        />
      )}
      {!importReviewActive && pluginCatalogOpen && (
        <PluginCatalogDialog
          locale={locale}
          artifacts={artifacts}
          onClose={() => setPluginCatalogOpen(false)}
          onRemove={(key) => {
            const removed = onUninstallPlugin(key);
            if (removed) imports.setImportStatus(strategyText(locale, "pluginRemoved"));
            return removed;
          }}
        />
      )}
    </aside>
  );
}
function LibraryGroup({
  locale,
  title,
  items,
  activeId,
  onSelect
}: {
  locale: Locale;
  title: string;
  items: StrategyArtifact[];
  activeId?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="library-group">
      <div className="panel-header">
        <strong>{title}</strong>
        <span>{items.length}</span>
      </div>
      <div className="library-items">
        {items.map((item) => (
          <div key={item.id} className={`library-item ${item.id === activeId ? "active" : ""}`}>
            <button type="button" className="library-item-main" onClick={() => onSelect(item.id)}>
              <strong>{item.name}</strong>
              <span>{item.description}</span>
            </button>
            <button
              type="button"
              className="library-item-export"
              title={strategyText(locale, "exportStrategy")}
              aria-label={`${strategyText(locale, "exportStrategy")}: ${item.name}`}
              onClick={(event) => {
                event.stopPropagation();
                void downloadStrategyFile(item);
              }}
            >
              <Download size={13} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
const TEMPLATE_CATEGORIES: TemplateCategory[] = ["Trend", "Mean reversion", "Breakout", "Momentum"];

function TemplateGallery({
  locale,
  onClose,
  onUse
}: {
  locale: Locale;
  onClose: () => void;
  onUse: (template: StrategyTemplate) => void;
}) {
  const modal = useModalFocus<HTMLDivElement>(onClose, "button");

  const categories = TEMPLATE_CATEGORIES.map((category) => ({
    category,
    items: strategyTemplates.filter((template) => template.category === category)
  })).filter((group) => group.items.length > 0);

  return (
    <div ref={modal.dialogRef} tabIndex={-1} className="gallery-backdrop" role="dialog" aria-modal="true" aria-label={strategyText(locale, "galleryLabel")} onKeyDown={modal.onKeyDown} onClick={onClose}>
      <div className="gallery-modal" onClick={(event) => event.stopPropagation()}>
        <div className="gallery-head">
          <strong>
            <LayoutGrid size={15} aria-hidden="true" /> {strategyText(locale, "strategyGallery")}
          </strong>
          <button type="button" className="icon-button" onClick={onClose} title={strategyText(locale, "close")} aria-label={strategyText(locale, "closeGallery")}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="gallery-body">
          {categories.map((group) => (
            <section key={group.category} className="gallery-group">
              <div className="panel-header">
                <strong>{strategyCategory(locale, group.category)}</strong>
                <span>{group.items.length}</span>
              </div>
              <div className="gallery-cards">
                {group.items.map((template) => (
                  <article key={template.id} className="gallery-card">
                    <strong>{template.name}</strong>
                    <p>{template.description}</p>
                    <div className="gallery-tags">
                      {template.tags.map((tag) => (
                        <span key={tag} className="gallery-tag">
                          {tag}
                        </span>
                      ))}
                    </div>
                    <button type="button" className="gallery-use" onClick={() => onUse(template)}>
                      {strategyText(locale, "use")}
                    </button>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
