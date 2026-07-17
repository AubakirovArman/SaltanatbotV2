import { chmodSync, linkSync, mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRecoveryStatusReceipt, RECOVERY_STATUS_RECEIPT_MAX_BYTES } from "../src/operations/recoveryStatus.js";

const receipt = {
  version: 1,
  generationId: "11111111-1111-4111-8111-111111111111",
  verifiedAt: "2026-07-16T20:00:00.000Z",
  releaseCommit: "a".repeat(40),
  schemaVersion: 11,
  captureSpanMs: 12_345,
  sourceGeneration: "20260716T200000Z"
} as const;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("recovery status receipt reader", () => {
  it("reads one bounded owner-only receipt through a nofollow descriptor", () => {
    const directory = temporaryDirectory();
    const statusFile = path.resolve(directory, "recovery-status.json");
    writeReceipt(statusFile, `${JSON.stringify(receipt)}\n`);

    expect(readRecoveryStatusReceipt(statusFile)).toEqual(receipt);
  });

  it("returns the latest complete receipt after an interrupted journal append", () => {
    const directory = temporaryDirectory();
    const statusFile = path.resolve(directory, "recovery-status.json");
    const latest = {
      ...receipt,
      generationId: "33333333-3333-4333-8333-333333333333",
      sourceGeneration: "generation-latest"
    };
    writeReceipt(statusFile, `${JSON.stringify(receipt)}\n${JSON.stringify(latest)}\n{"version":`);

    expect(readRecoveryStatusReceipt(statusFile)).toEqual(latest);
  });

  it("requires committed framing and rejects malformed interior records", () => {
    const directory = temporaryDirectory();
    const statusFile = path.resolve(directory, "recovery-status.json");
    writeReceipt(statusFile, JSON.stringify(receipt));
    expect(readRecoveryStatusReceipt(statusFile)).toBeNull();

    writeFileSync(statusFile, `${JSON.stringify(receipt)}\nGARBAGE\n${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    expect(readRecoveryStatusReceipt(statusFile)).toBeNull();
  });

  it("rejects invalid UTF-8 instead of decoding replacement characters", () => {
    const directory = temporaryDirectory();
    const statusFile = path.resolve(directory, "recovery-status.json");
    const corrupted = Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
    const valuePrefix = Buffer.from('"sourceGeneration":"', "utf8");
    const sourceOffset = corrupted.indexOf(valuePrefix) + valuePrefix.byteLength;
    expect(sourceOffset).toBeGreaterThan(valuePrefix.byteLength);
    corrupted[sourceOffset] = 0xff;
    writeReceipt(statusFile, corrupted);

    expect(readRecoveryStatusReceipt(statusFile)).toBeNull();
  });

  it("fails closed for missing, malformed, oversized or overexposed files", () => {
    const directory = temporaryDirectory();
    const statusFile = path.resolve(directory, "recovery-status.json");
    expect(readRecoveryStatusReceipt(statusFile)).toBeNull();

    writeReceipt(statusFile, '{"version":1}\n');
    expect(readRecoveryStatusReceipt(statusFile)).toBeNull();

    writeFileSync(statusFile, `${JSON.stringify({ ...receipt, database: "must-not-be-accepted" })}\n`, { mode: 0o600 });
    expect(readRecoveryStatusReceipt(statusFile)).toBeNull();

    writeFileSync(statusFile, Buffer.alloc(RECOVERY_STATUS_RECEIPT_MAX_BYTES + 1, 0x20), { mode: 0o600 });
    expect(readRecoveryStatusReceipt(statusFile)).toBeNull();

    writeFileSync(statusFile, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    chmodSync(statusFile, 0o644);
    expect(readRecoveryStatusReceipt(statusFile)).toBeNull();
  });

  it("rejects final, intermediate and hard-link path aliases", () => {
    const directory = temporaryDirectory();
    const realDirectory = path.resolve(directory, "real");
    mkdirSync(realDirectory, { mode: 0o700 });
    const realFile = path.resolve(realDirectory, "receipt.json");
    writeFileSync(realFile, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });

    const finalLink = path.resolve(directory, "final-link.json");
    symlinkSync(realFile, finalLink);
    expect(readRecoveryStatusReceipt(finalLink)).toBeNull();

    const directoryLink = path.resolve(directory, "directory-link");
    symlinkSync(realDirectory, directoryLink);
    expect(readRecoveryStatusReceipt(path.resolve(directoryLink, "receipt.json"))).toBeNull();

    const hardLink = path.resolve(directory, "hard-link.json");
    linkSync(realFile, hardLink);
    expect(readRecoveryStatusReceipt(realFile)).toBeNull();
    expect(readRecoveryStatusReceipt(hardLink)).toBeNull();
  });

  it("rejects an inode replacement between metadata review and nofollow open", () => {
    const directory = temporaryDirectory();
    const statusFile = path.resolve(directory, "recovery-status.json");
    const reviewedFile = path.resolve(directory, "reviewed-status.json");
    writeReceipt(statusFile, `${JSON.stringify(receipt)}\n`);

    const replacement = {
      ...receipt,
      generationId: "33333333-3333-4333-8333-333333333333"
    };
    expect(
      readRecoveryStatusReceipt(statusFile, {
        beforeOpen: () => {
          renameSync(statusFile, reviewedFile);
          writeFileSync(statusFile, `${JSON.stringify(replacement)}\n`, {
            mode: 0o600
          });
        }
      })
    ).toBeNull();
  });

  it("rejects a receipt below a group/world-writable status parent", () => {
    const directory = temporaryDirectory();
    const statusFile = path.resolve(directory, "recovery-status.json");
    writeReceipt(statusFile, `${JSON.stringify(receipt)}\n`);
    chmodSync(directory, 0o777);

    expect(readRecoveryStatusReceipt(statusFile)).toBeNull();
  });
});

function writeReceipt(statusFile: string, contents: string | Buffer): void {
  writeFileSync(statusFile, contents, { mode: 0o600 });
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "saltanat-recovery-status-"));
  temporaryDirectories.push(directory);
  return directory;
}
