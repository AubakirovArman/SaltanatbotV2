import { useState } from "react";
import { parsePluginFile, type PluginParseErrorCode, type VerifiedPlugin } from "@saltanatbotv2/plugin-core";
import type { Locale } from "../i18n";
import { strategyText } from "../i18n/strategy";
import type { PwaFileLaunchBatch } from "../pwa/fileLaunch";
import { parseStrategyFile, type PortableStrategyArtifact } from "./strategyFile";

export interface PineSourceFile {
  name: string;
  text: string;
}

export interface PendingStrategyFile {
  fileName: string;
  artifact: PortableStrategyArtifact;
}

export function useImportReviewQueue(locale: Locale) {
  const [importError, setImportError] = useState<string>();
  const [importStatus, setImportStatus] = useState<string>();
  const [pendingStrategies, setPendingStrategies] = useState<PendingStrategyFile[]>([]);
  const [pendingPlugins, setPendingPlugins] = useState<VerifiedPlugin[]>([]);
  const [pendingPine, setPendingPine] = useState<PineSourceFile[]>([]);

  const prepareStrategyFile = async (file: File) => {
    setImportError(undefined);
    setImportStatus(undefined);
    try {
      const parsed = await parseStrategyFile(await file.text());
      if (!parsed) {
        setImportError(strategyText(locale, "invalidStrategy"));
        return;
      }
      setPendingStrategies((current) => [...current, { fileName: file.name, artifact: parsed }]);
    } catch {
      setImportError(strategyText(locale, "unreadableFile"));
    }
  };

  const preparePluginFile = async (file: File) => {
    setImportError(undefined);
    setImportStatus(undefined);
    try {
      const parsed = await parsePluginFile(await file.text(), { appVersion: "0.1.0", maxArtifactSchemaVersion: 2 });
      if (!parsed.ok) {
        setImportError(pluginError(locale, parsed.code));
        return;
      }
      setPendingPlugins((current) => [...current, parsed]);
    } catch {
      setImportError(strategyText(locale, "unreadableFile"));
    }
  };

  /** Parse locally after the user accepted the outer PWA launch review. No artifacts mutate here. */
  const prepareLaunchedBatch = async (batch: PwaFileLaunchBatch) => {
    setImportError(undefined);
    setImportStatus(undefined);
    const settled = await Promise.allSettled(batch.files.map(async ({ file, kind, name }) => {
      const raw = await file.text();
      if (kind === "pine") {
        return { kind, value: { name: stripExtension(name), text: raw } satisfies PineSourceFile } as const;
      }
      if (kind === "strategy") {
        const artifact = await parseStrategyFile(raw);
        if (!artifact) throw new Error("invalid_strategy");
        return { kind, value: { fileName: name, artifact } satisfies PendingStrategyFile } as const;
      }
      const plugin = await parsePluginFile(raw, { appVersion: "0.1.0", maxArtifactSchemaVersion: 2 });
      if (!plugin.ok) throw new Error(plugin.code);
      return { kind, value: plugin } as const;
    }));

    const strategies: PendingStrategyFile[] = [];
    const plugins: VerifiedPlugin[] = [];
    const pine: PineSourceFile[] = [];
    let rejected = batch.rejected.length;
    for (const result of settled) {
      if (result.status === "rejected") {
        rejected += 1;
        continue;
      }
      if (result.value.kind === "pine") pine.push(result.value.value);
      else if (result.value.kind === "strategy") strategies.push(result.value.value);
      else plugins.push(result.value.value);
    }

    if (strategies.length) setPendingStrategies((current) => [...current, ...strategies]);
    if (plugins.length) setPendingPlugins((current) => [...current, ...plugins]);
    if (pine.length) setPendingPine((current) => [...current, ...pine].slice(0, 25));
    const ready = strategies.length + plugins.length + pine.length;
    if (ready) setImportStatus(`${ready} ${strategyText(locale, "filesReadyForReview")}`);
    if (rejected) setImportError(`${rejected} ${strategyText(locale, "filesRejectedDuringReview")}`);
  };

  return {
    importError,
    importStatus,
    setImportStatus,
    pendingStrategy: pendingStrategies[0],
    pendingPlugin: pendingPlugins[0],
    pendingPine,
    prepareStrategyFile,
    preparePluginFile,
    prepareLaunchedBatch,
    shiftStrategy: () => setPendingStrategies((current) => current.slice(1)),
    shiftPlugin: () => setPendingPlugins((current) => current.slice(1)),
    clearPendingPine: () => setPendingPine([])
  };
}

function pluginError(locale: Locale, code: PluginParseErrorCode) {
  const keys: Partial<Record<PluginParseErrorCode, Parameters<typeof strategyText>[1]>> = {
    too_large: "pluginTooLarge",
    checksum_mismatch: "pluginChecksumMismatch",
    invalid_signature: "pluginSignatureInvalid",
    incompatible_app: "pluginIncompatible",
    unsupported_permission: "pluginPermissionRejected",
    dependency_error: "pluginDependencyRejected"
  };
  return strategyText(locale, keys[code] ?? "invalidPlugin");
}

function stripExtension(name: string) {
  return name.replace(/\.[^.]+$/, "") || "Pine Script";
}
