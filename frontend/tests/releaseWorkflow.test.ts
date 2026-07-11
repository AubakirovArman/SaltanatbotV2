import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const packager = path.join(root, "scripts/package-release.mjs");

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
  });
});
