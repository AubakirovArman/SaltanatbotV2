import { Eye, EyeOff, Lock, Redo2, Save, Trash2, Undo2, Unlock, X } from "lucide-react";
import { useId, useState } from "react";
import type { DrawingObject } from "../chart/drawings";
import { loadDrawingTemplates, removeDrawingTemplate, saveDrawingTemplate, type DrawingTemplate } from "../chart/drawingTemplates";
import { MOBILE_SHELL_MEDIA_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import type { Locale } from "../i18n";
import { shellText } from "../i18n/shell";
import { drawingToolLabelKey } from "./chartCanvas/drawingToolCatalog";
import { MobilePanelDialog } from "./MobilePanelDialog";

interface DrawingObjectsPanelProps {
  locale: Locale;
  drawings: DrawingObject[];
  selectedId?: string;
  canUndo: boolean;
  canRedo: boolean;
  onSelect: (id: string) => void;
  onToggleHidden: (id: string) => void;
  onToggleLocked: (id: string) => void;
  onDelete: (id: string) => void;
  onApplyTemplate: (template: DrawingTemplate) => void;
  onUndo: () => void;
  onRedo: () => void;
  onClose: () => void;
  storageOwnerId?: string;
}

export function DrawingObjectsPanel({ locale, drawings, selectedId, canUndo, canRedo, onSelect, onToggleHidden, onToggleLocked, onDelete, onApplyTemplate, onUndo, onRedo, onClose, storageOwnerId }: DrawingObjectsPanelProps) {
  const t = (key: Parameters<typeof shellText>[1]) => shellText(locale, key);
  const [templates, setTemplates] = useState(() => loadDrawingTemplates(storageOwnerId));
  const selected = drawings.find((drawing) => drawing.id === selectedId);
  const mobile = useMediaQuery(MOBILE_SHELL_MEDIA_QUERY);
  const dialogId = useId();

  const saveTemplate = () => {
    if (!selected) return;
    const name = window.prompt(t("drawingTemplateName"), `${t(drawingToolLabelKey(selected.tool))} style`)?.trim();
    if (!name) return;
    setTemplates(saveDrawingTemplate({ id: `drawing-template-${Date.now()}`, name, tool: selected.tool, style: { ...selected.style }, createdAt: Date.now() }, storageOwnerId));
  };

  const content = (insideMobileSheet: boolean) => (
    <>
      <header>
        <strong>{t("drawingObjects")}</strong>
        <div>
          <button type="button" disabled={!canUndo} onClick={onUndo} aria-label={t("undoDrawing")} title={t("undoDrawing")}>
            <Undo2 size={16} aria-hidden="true" />
          </button>
          <button type="button" disabled={!canRedo} onClick={onRedo} aria-label={t("redoDrawing")} title={t("redoDrawing")}>
            <Redo2 size={16} aria-hidden="true" />
          </button>
          <button type="button" disabled={!selected} onClick={saveTemplate} aria-label={t("saveDrawingTemplate")} title={t("saveDrawingTemplate")}>
            <Save size={16} aria-hidden="true" />
          </button>
          {!insideMobileSheet && (
            <button type="button" onClick={onClose} aria-label={t("closeDrawingObjects")}>
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      </header>
      <ul className="drawing-object-list">
        {drawings.map((drawing, index) => {
          const name = t(drawingToolLabelKey(drawing.tool));
          const number = index + 1;
          return (
            <li key={drawing.id} className={drawing.id === selectedId ? "active" : ""}>
              <button type="button" className="drawing-object-name" aria-pressed={drawing.id === selectedId} onClick={() => onSelect(drawing.id)}>
                <span>{name}</span>
                <small>#{number}</small>
              </button>
              <button type="button" onClick={() => onToggleHidden(drawing.id)} aria-label={`${drawing.hidden ? t("showDrawing") : t("hideDrawing")} · ${name} #${number}`}>
                {drawing.hidden ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
              </button>
              <button type="button" onClick={() => onToggleLocked(drawing.id)} aria-label={`${drawing.locked ? t("unlockDrawing") : t("lockDrawing")} · ${name} #${number}`}>
                {drawing.locked ? <Lock size={16} aria-hidden="true" /> : <Unlock size={16} aria-hidden="true" />}
              </button>
              <button type="button" onClick={() => onDelete(drawing.id)} aria-label={`${t("deleteDrawing")} · ${name} #${number}`}>
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </li>
          );
        })}
        {drawings.length === 0 && <li className="drawing-objects-empty">{t("noDrawingObjects")}</li>}
      </ul>
      {templates.length > 0 && (
        <section className="drawing-template-list" aria-label={t("drawingTemplates")}>
          <strong>{t("drawingTemplates")}</strong>
          {templates.map((template) => (
            <div key={template.id}>
              <button type="button" disabled={!selected || selected.tool !== template.tool} onClick={() => onApplyTemplate(template)}>
                {template.name} · {t(drawingToolLabelKey(template.tool))}
              </button>
              <button type="button" aria-label={`${t("remove")} ${template.name}`} onClick={() => setTemplates(removeDrawingTemplate(template.id, storageOwnerId))}>
                <X size={15} aria-hidden="true" />
              </button>
            </div>
          ))}
        </section>
      )}
    </>
  );

  if (mobile) {
    return (
      <MobilePanelDialog id={dialogId} open label={t("drawingObjects")} closeLabel={t("closeDrawingObjects")} initialFocus={selected ? ".drawing-object-name[aria-pressed='true']" : drawings.length > 0 ? ".drawing-object-name" : ".mobile-panel-close"} onClose={onClose}>
        <section className="drawing-objects-content mobile-drawing-objects">{content(true)}</section>
      </MobilePanelDialog>
    );
  }

  return (
    <aside className="drawing-objects-panel drawing-objects-content" aria-label={t("drawingObjects")}>
      {content(false)}
    </aside>
  );
}
