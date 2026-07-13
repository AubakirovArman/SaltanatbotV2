import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { verifyDistributionManifest, writeJsonAtomic } from "./lib/distribution-manifest.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.distribution || !args.output) throw new Error("Usage: release-rollback-drill --distribution <directory> --output <evidence.json>");
const distribution = resolve(args.distribution);
const output = resolve(args.output);
if (existsSync(output)) throw new Error(`Refusing to overwrite rollback evidence: ${output}`);

const source = verifyDistributionManifest(distribution);
const drillRoot = mkdtempSync(resolve(tmpdir(), "saltanat-rollback-drill-"));
const slots = resolve(drillRoot, "slots");
const previous = resolve(slots, "previous");
const candidate = resolve(slots, "candidate");
const pointer = resolve(drillRoot, "active-release.json");
const phases = [];

try {
  mkdirSync(slots, { recursive: true });
  cpSync(distribution, previous, { recursive: true, errorOnExist: true, force: false });
  cpSync(distribution, candidate, { recursive: true, errorOnExist: true, force: false });
  const previousVerification = verifyDistributionManifest(previous);
  const candidateVerification = verifyDistributionManifest(candidate);
  phases.push({ phase: "immutable_slots_verified", result: "pass" });

  activate(pointer, "candidate");
  assertActive(pointer, "candidate");
  phases.push({ phase: "candidate_activated", result: "pass" });

  appendFileSync(resolve(candidate, "frontend/dist/index.html"), "\n<!-- controlled rollback drill incident -->\n");
  phases.push({ phase: "controlled_incident_injected", result: "pass", target: "frontend/dist/index.html" });

  let detection;
  try {
    verifyDistributionManifest(candidate);
  } catch (error) {
    detection = error instanceof Error ? error.message : String(error);
  }
  if (!detection || !/mismatch/i.test(detection)) throw new Error("Controlled distribution corruption was not detected; rollback drill failed closed.");
  phases.push({ phase: "integrity_gate_blocked_candidate", result: "pass", reason: detection.replaceAll(candidate, "<candidate>") });

  activate(pointer, "previous");
  assertActive(pointer, "previous");
  const restored = verifyDistributionManifest(previous);
  if (restored.sha256 !== source.sha256 || restored.sha256 !== previousVerification.sha256 || candidateVerification.sha256 !== source.sha256) throw new Error("Rollback target does not match the verified source manifest.");
  verifyDistributionManifest(distribution);
  phases.push({ phase: "verified_previous_slot_restored", result: "pass" });

  const evidence = {
    format: "saltanatbotv2-release-rollback-drill",
    version: 1,
    executedAt: new Date().toISOString(),
    scenario: "controlled-active-frontend-tamper",
    release: source.manifest.release,
    sourceManifestSha256: source.sha256,
    activationMechanism: "same-directory atomic pointer rename",
    runtimeDataTouched: false,
    phases,
    result: "pass"
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644, flag: "wx" });
  console.log(`Rollback drill passed for ${source.manifest.release.name}; evidence: ${output}`);
} finally {
  rmSync(drillRoot, { recursive: true, force: true });
}

function activate(pointerPath, slot) {
  const { temporary, destination } = writeJsonAtomic(pointerPath, { slot });
  renameSync(temporary, destination);
}

function assertActive(pointerPath, expected) {
  let pointerValue;
  try { pointerValue = JSON.parse(readFileSync(pointerPath, "utf8")); } catch { throw new Error("Active release pointer is unreadable."); }
  if (pointerValue?.slot !== expected) throw new Error(`Active release pointer mismatch: expected ${expected}.`);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value !== "--distribution" && value !== "--output") throw new Error(`Unexpected argument: ${value}`);
    const next = values[++index];
    if (!next) throw new Error(`Missing value for ${value}`);
    parsed[value.slice(2)] = next;
  }
  return parsed;
}
