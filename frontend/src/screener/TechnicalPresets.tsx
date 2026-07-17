import { Archive, Download, Save } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ScreenerDefinitionV1, ScreenerPresetV1 } from "@saltanatbotv2/contracts";
import { localeTag, type Locale } from "../i18n";
import { screenerText } from "../i18n/screener";
import { archiveScreenerPreset, createScreenerPreset, listScreenerPresets } from "./client";

interface Props {
  locale: Locale;
  ownerId: string;
  disabled: boolean;
  buildDefinition(): ScreenerDefinitionV1 | undefined;
  onApply(definition: ScreenerDefinitionV1): void;
}

type PresetsState = { status: "loading" | "error"; presets: ScreenerPresetV1[] } | { status: "ready"; presets: ScreenerPresetV1[] };

export function TechnicalPresets({ locale, ownerId, disabled, buildDefinition, onApply }: Props) {
  const [state, setState] = useState<PresetsState>({ status: "loading", presets: [] });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string>();
  const controllerRef = useRef<AbortController>();

  const refresh = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const list = await listScreenerPresets(ownerId, controller.signal);
      if (!controller.signal.aborted) setState({ status: "ready", presets: list.presets.filter((preset) => preset.archivedAt === undefined) });
    } catch {
      if (!controller.signal.aborted) setState((current) => ({ status: "error", presets: current.presets }));
    }
  }, [ownerId]);

  useEffect(() => {
    void refresh();
    return () => controllerRef.current?.abort();
  }, [refresh]);

  const save = async () => {
    const definition = buildDefinition();
    if (!definition) {
      setNotice(screenerText(locale, "invalidDefinition"));
      return;
    }
    setSaving(true);
    setNotice(undefined);
    try {
      await createScreenerPreset(ownerId, { clientId: createPresetClientId(), definition });
      setNotice(screenerText(locale, "presetSaved"));
      await refresh();
    } catch {
      setNotice(screenerText(locale, "presetSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const archive = async (preset: ScreenerPresetV1) => {
    setNotice(undefined);
    try {
      await archiveScreenerPreset(ownerId, preset.id, preset.revision);
      setNotice(screenerText(locale, "presetArchived"));
      await refresh();
    } catch {
      setNotice(screenerText(locale, "presetArchiveFailed"));
    }
  };

  return (
    <section className="tech-screener-presets" aria-labelledby="tech-screener-presets-title">
      <header>
        <strong id="tech-screener-presets-title">{screenerText(locale, "presets")}</strong>
        <p>{screenerText(locale, "presetsHint")}</p>
      </header>
      <div className="tech-screener-preset-actions">
        <button type="button" className="arb-refresh" disabled={disabled || saving} onClick={() => void save()}>
          <Save size={15} aria-hidden="true" />
          {screenerText(locale, saving ? "savingPreset" : "savePreset")}
        </button>
        {notice && (
          <span role="status">
            {notice}
            <button type="button" aria-label={screenerText(locale, "dismissNotice")} title={screenerText(locale, "dismissNotice")} onClick={() => setNotice(undefined)}>
              ×
            </button>
          </span>
        )}
      </div>
      {state.status === "error" && (
        <p className="tech-screener-preset-error" role="status">
          {screenerText(locale, "presetsUnavailable")}
        </p>
      )}
      {state.status === "ready" && state.presets.length === 0 && <p className="tech-screener-preset-empty">{screenerText(locale, "noPresets")}</p>}
      {state.presets.length > 0 && (
        <ul className="tech-screener-preset-list">
          {state.presets.map((preset) => (
            <li key={preset.id}>
              <span className="tech-screener-preset-name">
                <strong>{preset.definition.name}</strong>
                <small>
                  {screenerText(locale, "presetRevision", { revision: String(preset.revision) })} · {screenerText(locale, "presetUpdated", { time: new Date(preset.updatedAt).toLocaleString(localeTag(locale)) })}
                </small>
              </span>
              <span className="arb-row-actions">
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={screenerText(locale, "applyPreset", { name: preset.definition.name })}
                  title={screenerText(locale, "applyPreset", { name: preset.definition.name })}
                  onClick={() => {
                    onApply(preset.definition);
                    setNotice(screenerText(locale, "presetApplied"));
                  }}
                >
                  <Download size={14} aria-hidden="true" />
                </button>
                <button type="button" disabled={disabled} aria-label={screenerText(locale, "archivePreset", { name: preset.definition.name })} title={screenerText(locale, "archivePreset", { name: preset.definition.name })} onClick={() => void archive(preset)}>
                  <Archive size={14} aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function createPresetClientId(): string {
  const time = Date.now().toString(36);
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `tech-${time}-${random}`;
}
