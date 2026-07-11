import { Download, FileCode2, LayoutGrid, Plus, Upload, WandSparkles, X } from "lucide-react";
import { useRef, useState } from "react";
import { PineImportDialog } from "../../components/PineImportDialog";
import type { PineImport } from "../pine";
import type { StrategyArtifact, StrategyArtifactKind } from "../library";
import { strategyTemplates, type StrategyTemplate, type TemplateCategory } from "../templates";
import { downloadStrategyFile, parseStrategyFile, type PortableStrategyArtifact } from "../strategyFile";
import type { Locale } from "../../i18n";
import { strategyCategory, strategyText } from "../../i18n/strategy";
import { StrategyWizard } from "./StrategyWizard";
import { useModalFocus } from "../../hooks/useModalFocus";

export function StrategyLibrary({
  locale,
  artifacts,
  activeId,
  onSelect,
  onCreate,
  onUseTemplate,
  onImportStrategy,
  onImportPineMany
}: {
  locale: Locale;
  artifacts: StrategyArtifact[];
  activeId?: string;
  onSelect: (id: string) => void;
  onCreate: (kind: StrategyArtifactKind) => void;
  onUseTemplate: (template: StrategyTemplate) => void;
  onImportStrategy: (input: PortableStrategyArtifact) => void;
  onImportPineMany: (inputs: PineImport[]) => void;
}) {
  const indicators = artifacts.filter((artifact) => artifact.kind === "indicator");
  const strategies = artifacts.filter((artifact) => artifact.kind === "strategy");
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [importError, setImportError] = useState<string>();
  const [pineOpen, setPineOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const importFile = async (file: File) => {
    setImportError(undefined);
    try {
      const parsed = await parseStrategyFile(await file.text());
      if (!parsed) {
        setImportError(strategyText(locale, "invalidStrategy"));
        return;
      }
      onImportStrategy(parsed);
    } catch {
      setImportError(strategyText(locale, "unreadableFile"));
    }
  };

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
        <button type="button" onClick={() => fileInputRef.current?.click()} title={strategyText(locale, "importStrategy")}>
          <Upload size={14} aria-hidden="true" /> {strategyText(locale, "import")}
        </button>
        <button type="button" onClick={() => setPineOpen(true)} title={strategyText(locale, "convertPine")}>
          <FileCode2 size={14} aria-hidden="true" /> {strategyText(locale, "pine")}
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".strategy,.json,application/json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importFile(file);
          event.target.value = "";
        }}
      />
      {importError && (
        <div className="import-error" role="alert">
          {importError}
        </div>
      )}
      <LibraryGroup locale={locale} title={strategyText(locale, "indicators")} items={indicators} activeId={activeId} onSelect={onSelect} />
      <LibraryGroup locale={locale} title={strategyText(locale, "strategies")} items={strategies} activeId={activeId} onSelect={onSelect} />
      {pineOpen && (
        <PineImportDialog
          locale={locale}
          onClose={() => setPineOpen(false)}
          onImportMany={(results) => {
            setPineOpen(false);
            onImportPineMany(results);
          }}
        />
      )}
      {wizardOpen && (
        <StrategyWizard
          locale={locale}
          onClose={() => setWizardOpen(false)}
          onCreate={(artifact) => {
            onImportStrategy(artifact);
            setWizardOpen(false);
          }}
        />
      )}
      {galleryOpen && (
        <TemplateGallery
          locale={locale}
          onClose={() => setGalleryOpen(false)}
          onUse={(template) => {
            onUseTemplate(template);
            setGalleryOpen(false);
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
