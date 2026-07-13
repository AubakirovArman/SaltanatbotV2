import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const packager = path.join(root, "scripts/package-release.mjs");
const rollbackDrill = path.join(root, "scripts/release-rollback-drill.mjs");

describe("release supply chain", () => {
  it("accepts channel-shaped versions and records immutable source identity", () => {
    const run = spawnSync(process.execPath, [packager, "--channel", "beta", "--version", "v1.2.3-rc.2", "--print-metadata"], { cwd: root, encoding: "utf8" });
    expect(run.status).toBe(0);
    const metadata = JSON.parse(run.stdout);
    expect(metadata).toMatchObject({ channel: "beta", version: "v1.2.3-rc.2" });
    expect(typeof metadata.dirty).toBe("boolean");
    expect(metadata.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(metadata.sourceDateEpoch).toBeGreaterThan(0);
  });

  it("rejects mismatched or unsafe release versions", () => {
    expect(spawnSync(process.execPath, [packager, "--channel", "stable", "--version", "v1.2.3-beta.1", "--print-metadata"], { cwd: root }).status).not.toBe(0);
    expect(spawnSync(process.execPath, [packager, "--channel", "nightly", "--version", "../../escape", "--print-metadata"], { cwd: root }).status).not.toBe(0);
  });

  it("requires checksums, SPDX SBOM and GitHub/Sigstore attestations", () => {
    const workflow = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
    expect(workflow).toContain("anchore/sbom-action@v0");
    expect(workflow.match(/actions\/attest@v4/g)).toHaveLength(2);
    expect(workflow).toContain("subject-checksums: release/SHA256SUMS");
    expect(workflow).toContain("sbom-path: release/${{ steps.release.outputs.name }}.spdx.json");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("attestations: write");
    expect(workflow).toContain("release:rollback-drill");
    expect(workflow).toContain("*.distribution-manifest.json *.rollback-drill.json");
  });

  it("detects changed, extra and symbolic-link files in an extracted distribution", async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "saltanat-distribution-test-"));
    try {
      const fixture = createDistributionFixture(temporary);
      const { writeDistributionManifest, verifyDistributionManifest } = await import("../../scripts/lib/distribution-manifest.mjs");
      writeDistributionManifest(fixture, releaseIdentity());
      expect(verifyDistributionManifest(fixture).manifest.files.map((entry: { path: string }) => entry.path)).toContain("frontend/dist/index.html");
      writeFileSync(path.join(fixture, "frontend/dist/index.html"), "tampered");
      expect(() => verifyDistributionManifest(fixture)).toThrow(/mismatch/i);

      const extraFixture = createDistributionFixture(path.join(temporary, "extra"));
      writeDistributionManifest(extraFixture, releaseIdentity());
      writeFileSync(path.join(extraFixture, "unexpected.txt"), "extra");
      expect(() => verifyDistributionManifest(extraFixture)).toThrow(/count mismatch|unmanifested/i);

      const missingFixture = createDistributionFixture(path.join(temporary, "missing"));
      writeDistributionManifest(missingFixture, releaseIdentity());
      rmSync(path.join(missingFixture, "backend/dist/server.js"));
      expect(() => verifyDistributionManifest(missingFixture)).toThrow(/count mismatch|missing/i);

      const identityFixture = createDistributionFixture(path.join(temporary, "identity"));
      writeDistributionManifest(identityFixture, releaseIdentity());
      writeFileSync(path.join(identityFixture, "release-info.json"), `${JSON.stringify({ ...releaseIdentity(), commit: "b".repeat(40), dirty: false }, null, 2)}\n`);
      expect(() => verifyDistributionManifest(identityFixture)).toThrow(/identity mismatch/i);

      const linkFixture = createDistributionFixture(path.join(temporary, "link"));
      symlinkSync("release-info.json", path.join(linkFixture, "release-link.json"));
      expect(() => writeDistributionManifest(linkFixture, releaseIdentity())).toThrow(/symbolic links/i);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("exercises controlled corruption and restores a verified immutable slot", async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "saltanat-rollback-test-"));
    try {
      const fixture = createDistributionFixture(temporary);
      const { writeDistributionManifest } = await import("../../scripts/lib/distribution-manifest.mjs");
      writeDistributionManifest(fixture, releaseIdentity());
      const output = path.join(temporary, "rollback-evidence.json");
      const run = spawnSync(process.execPath, [rollbackDrill, "--distribution", fixture, "--output", output], { cwd: root, encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
        format: "saltanatbotv2-release-rollback-drill",
        scenario: "controlled-active-frontend-tamper",
        runtimeDataTouched: false,
        result: "pass"
      });
      expect(readFileSync(path.join(fixture, "frontend/dist/index.html"), "utf8")).toBe("healthy shell");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

function createDistributionFixture(parent: string) {
  const fixture = path.join(parent, `distribution-${Math.random().toString(16).slice(2)}`);
  mkdirSync(path.join(fixture, "frontend/dist"), { recursive: true });
  mkdirSync(path.join(fixture, "backend/dist"), { recursive: true });
  writeFileSync(path.join(fixture, "frontend/dist/index.html"), "healthy shell");
  writeFileSync(path.join(fixture, "backend/dist/server.js"), "export {};\n");
  writeFileSync(path.join(fixture, "release-info.json"), `${JSON.stringify({ ...releaseIdentity(), dirty: false }, null, 2)}\n`);
  return fixture;
}

function releaseIdentity() {
  return { name: "saltanatbotv2-v1.2.3", version: "v1.2.3", channel: "stable", commit: "a".repeat(40), sourceDateEpoch: 1_700_000_000 };
}
