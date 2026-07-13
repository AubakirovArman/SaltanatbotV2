import { GitCompare, History, Network, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import type { Locale } from "../../i18n";
import { strategyText } from "../../i18n/strategy";
import { canAddDependency, buildArtifactDependencyGraph } from "../dependencyGraph";
import { diffArtifactVersions } from "../artifactLibraryModel";
import type { StrategyArtifact } from "../library";

export function ArtifactVersionPanel({ locale, artifact, artifacts, onRollback, onDependenciesChange }: {
  locale: Locale;
  artifact: StrategyArtifact;
  artifacts: StrategyArtifact[];
  onRollback: (version: number) => void;
  onDependenciesChange: (dependencies: string[]) => void;
}) {
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
  const [compareVersion, setCompareVersion] = useState<number>();
  const graph = useMemo(() => buildArtifactDependencyGraph(artifacts), [artifacts]);
  const diff = compareVersion === undefined ? undefined : diffArtifactVersions(artifact, compareVersion);
  const dependencies = new Set(artifact.dependencies ?? []);
  const candidates = artifacts.filter((item) => item.id !== artifact.id && item.kind === "indicator");
  return (
    <details className="artifact-version-panel">
      <summary><History size={13} aria-hidden="true" /> {t("artifactVersions")} · {artifact.semanticVersion ?? "0.1.0"}</summary>
      <div className="artifact-version-meta">
        <span>{t("schemaVersion")} {artifact.schemaVersion ?? 1}</span>
        <span>{t("contentHash")} {artifact.hash ?? "—"}</span>
        <span>IR {artifact.irHash ?? "—"}</span>
        <span>{t("provenance")} {artifact.provenance?.source ?? "local"}</span>
        {artifact.provenance?.source === "plugin" && <>
          <span>{t("pluginPackage")} {artifact.provenance.pluginId}@{artifact.provenance.pluginVersion}</span>
          <span>{t("publisher")} {artifact.provenance.publisher}</span>
          <span>{t("manifestChecksum")} {artifact.provenance.manifestHash?.slice(0, 16)}…</span>
        </>}
        {artifact.migration && <span>{t("migratedFrom")} v{artifact.migration.fromSchema}</span>}
      </div>
      <section>
        <strong><Network size={12} aria-hidden="true" /> {t("dependencies")}</strong>
        {candidates.length === 0 ? <p>{t("noIndicatorDependencies")}</p> : candidates.map((candidate) => {
          const checked = dependencies.has(candidate.id);
          const allowed = checked || canAddDependency(artifacts, artifact.id, candidate.id);
          return (
            <label key={candidate.id} title={!allowed ? t("dependencyCycle") : undefined}>
              <input
                type="checkbox"
                checked={checked}
                disabled={!allowed}
                onChange={(event) => onDependenciesChange(event.target.checked
                  ? [...dependencies, candidate.id]
                  : [...dependencies].filter((id) => id !== candidate.id))}
              />
              {candidate.name} <code>{candidate.hash ?? "draft"}</code>
            </label>
          );
        })}
        {graph.missing.filter((edge) => edge.from === artifact.id).map((edge) => <p className="dependency-warning" key={edge.to}>{t("missingDependency")}: {edge.to}</p>)}
      </section>
      {(artifact.history?.length ?? 0) > 0 && (
        <section>
          <strong><GitCompare size={12} aria-hidden="true" /> {t("historyAndDiff")}</strong>
          <div className="artifact-history-list">
            {artifact.history?.slice().reverse().map((revision) => (
              <div key={`${revision.version}-${revision.hash}`}>
                <button type="button" onClick={() => setCompareVersion(revision.version)} className={compareVersion === revision.version ? "active" : ""}>
                  v{revision.semanticVersion} · {revision.hash}
                </button>
                <button type="button" onClick={() => onRollback(revision.version)} aria-label={`${t("rollbackTo")} ${revision.semanticVersion}`} title={t("rollbackTo")}>
                  <RotateCcw size={12} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
          {diff && (
            <div className="artifact-diff" aria-label={t("artifactDiff")}>
              <span>+{diff.added.length} / −{diff.removed.length}</span>
              {diff.metadataChanged.length > 0 && <span>{t("metadataChanged")}: {diff.metadataChanged.join(", ")}</span>}
              {diff.removed.slice(0, 4).map((line, index) => <code className="removed" key={`r-${index}`}>− {line}</code>)}
              {diff.added.slice(0, 4).map((line, index) => <code className="added" key={`a-${index}`}>+ {line}</code>)}
            </div>
          )}
        </section>
      )}
    </details>
  );
}
