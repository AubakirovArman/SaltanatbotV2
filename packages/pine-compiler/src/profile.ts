import type { PineDiagnostic } from "./diagnostics";
import { PineConvertError } from "./errors";

export type PineVersion = 4 | 5 | 6;
export type PineProfileName = `v${PineVersion}`;

export interface PineLanguageProfile {
  declaredVersion?: number;
  effectiveVersion: PineVersion;
  profile: PineProfileName;
}

export interface PineProfileResolution {
  language: PineLanguageProfile;
  diagnostics: PineDiagnostic[];
}

const VERSION_PRAGMA = /^\s*\/\/\s*@version\s*=\s*(\d+)\s*$/m;

/** Resolves the language grammar/API profile before comments are discarded by lexing. */
export function resolvePineProfile(source: string): PineProfileResolution {
  const match = VERSION_PRAGMA.exec(source);
  if (!match) {
    return {
      language: { effectiveVersion: 6, profile: "v6" },
      diagnostics: [warning(
        "PINE_VERSION_MISSING",
        "No //@version pragma was found; Pine v6 compatibility rules were used.",
        "Add //@version=4, //@version=5 or //@version=6 as the first line for reproducible conversion."
      )]
    };
  }

  const declaredVersion = Number(match[1]);
  if (declaredVersion !== 4 && declaredVersion !== 5 && declaredVersion !== 6) {
    const message = `Pine version ${declaredVersion} is not supported; supported versions are 4, 5 and 6.`;
    throw new PineConvertError(message, {
      severity: "error",
      code: "PINE_UNSUPPORTED_VERSION",
      message,
      remediation: "Migrate the script in TradingView to Pine v4, v5 or v6, then import it again.",
      span: { start: { line: source.slice(0, match.index).split("\n").length, column: 1 }, end: { line: source.slice(0, match.index).split("\n").length, column: match[0].length + 1 } }
    });
  }

  const version = declaredVersion as PineVersion;
  const diagnostics = profileCompatibilityDiagnostics(source, version);
  return {
    language: { declaredVersion, effectiveVersion: version, profile: `v${version}` },
    diagnostics
  };
}

function profileCompatibilityDiagnostics(source: string, version: PineVersion): PineDiagnostic[] {
  const code = stripCommentsAndStrings(source);
  const diagnostics: PineDiagnostic[] = [];
  if (version === 4 && /\b(?:indicator|request\.security)\s*\(/.test(code)) {
    diagnostics.push(warning(
      "PINE_PROFILE_API_MISMATCH",
      "The script declares Pine v4 but uses a v5+ namespaced declaration or request API; compatibility aliases were applied.",
      "Use study()/security() for a native v4 script, or migrate the script and update //@version."
    ));
  }
  if (version >= 5 && /(?:\bstudy|(?:^|[^.A-Za-z0-9_])security)\s*\(/m.test(code)) {
    diagnostics.push(warning(
      "PINE_PROFILE_API_MISMATCH",
      `The script declares Pine v${version} but uses a legacy v4 study()/security() API; compatibility aliases were applied.`,
      "Use indicator()/request.security() for native Pine v5/v6 syntax."
    ));
  }
  return diagnostics;
}

function warning(code: string, message: string, remediation: string): PineDiagnostic {
  return { severity: "warning", code, message, remediation };
}

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
}
