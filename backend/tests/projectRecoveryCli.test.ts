import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRecoveryStatusReceipt } from "../src/operations/recoveryStatus.js";
import { PROJECT_RECOVERY_STATUS_JOURNAL_MAX_BYTES, recoveryStatusReceiptFromVerification, writeProjectRecoveryStatusReceipt } from "../../scripts/lib/project-recovery-status.mjs";

const recoveryMocks = vi.hoisted(() => ({
  verify: vi.fn(),
  backup: vi.fn(),
  restore: vi.fn(),
  drill: vi.fn()
}));

vi.mock("../../scripts/lib/project-recovery.mjs", () => ({
  createProjectRecoveryBackup: recoveryMocks.backup,
  drillProjectRecovery: recoveryMocks.drill,
  restoreProjectRecovery: recoveryMocks.restore,
  verifyProjectRecovery: recoveryMocks.verify
}));

import { main } from "../../scripts/project-recovery.mjs";

const temporaryDirectories: string[] = [];
const generationId = "11111111-1111-4111-8111-111111111111";
const releaseCommit = "a".repeat(40);

beforeEach(() => {
  recoveryMocks.verify.mockReset();
  recoveryMocks.backup.mockReset();
  recoveryMocks.restore.mockReset();
  recoveryMocks.drill.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("project recovery verify CLI receipt", () => {
  it("atomically writes only bounded basename metadata after successful verification", async () => {
    const directory = temporaryDirectory();
    const generationDirectory = path.resolve(directory, "generation-20260716");
    const statusFile = path.resolve(directory, "recovery-status.json");
    recoveryMocks.verify.mockReturnValue(verifiedGeneration(generationDirectory));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main(["verify", generationDirectory, "--status-file", statusFile]);

    const raw = readFileSync(statusFile, "utf8");
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed).sort()).toEqual(["captureSpanMs", "generationId", "releaseCommit", "schemaVersion", "sourceGeneration", "verifiedAt", "version"]);
    expect(parsed).toMatchObject({
      version: 1,
      generationId,
      releaseCommit,
      schemaVersion: 11,
      captureSpanMs: 1_234,
      sourceGeneration: "generation-20260716"
    });
    expect(new Date(parsed.verifiedAt).toISOString()).toBe(parsed.verifiedAt);
    expect(statSync(statusFile).mode & 0o777).toBe(0o600);
    expect(raw).not.toContain(generationDirectory);
    expect(raw).not.toContain("saltanatbotv2_private");
    expect(raw).not.toContain("database-owner");
  });

  it("does not create or replace a receipt when verification fails", async () => {
    const directory = temporaryDirectory();
    const generationDirectory = path.resolve(directory, "generation");
    const statusFile = path.resolve(directory, "recovery-status.json");
    recoveryMocks.verify.mockReturnValue(verifiedGeneration(generationDirectory));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["verify", generationDirectory, "--status-file", statusFile]);
    const accepted = readFileSync(statusFile);

    recoveryMocks.verify.mockImplementation(() => {
      throw new Error("injected verification failure");
    });
    await expect(main(["verify", generationDirectory, "--status-file", statusFile])).rejects.toThrow("injected verification failure");
    expect(readFileSync(statusFile)).toEqual(accepted);

    const absent = path.resolve(directory, "must-not-exist.json");
    await expect(main(["verify", generationDirectory, "--status-file", absent])).rejects.toThrow("injected verification failure");
    expect(existsSync(absent)).toBe(false);
  });

  it("appends a crash-safe single-link receipt journal", async () => {
    const directory = temporaryDirectory();
    const statusFile = path.resolve(directory, "recovery-status.json");
    const firstGeneration = path.resolve(directory, "generation-first");
    const secondGeneration = path.resolve(directory, "generation-second");
    recoveryMocks.verify.mockReturnValue(verifiedGeneration(firstGeneration));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["verify", firstGeneration, "--status-file", statusFile]);

    recoveryMocks.verify.mockReturnValue(verifiedGeneration(secondGeneration, "33333333-3333-4333-8333-333333333333"));
    await main(["verify", secondGeneration, "--status-file", statusFile]);

    expect(readRecoveryStatusReceipt(statusFile)).toMatchObject({
      generationId: "33333333-3333-4333-8333-333333333333",
      sourceGeneration: "generation-second"
    });
    expect(readFileSync(statusFile, "utf8").trim().split("\n")).toHaveLength(2);
    expect(statSync(statusFile).nlink).toBe(1);
    expect(readdirSync(directory).filter((name) => name.startsWith(".recovery-status-anchor-"))).toHaveLength(0);
  });

  it("retains the prior receipt and refuses to race-repair an incomplete append", async () => {
    const directory = temporaryDirectory();
    const statusFile = path.resolve(directory, "recovery-status.json");
    const firstGeneration = path.resolve(directory, "generation-first");
    const secondGeneration = path.resolve(directory, "generation-second");
    recoveryMocks.verify.mockReturnValue(verifiedGeneration(firstGeneration));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await main(["verify", firstGeneration, "--status-file", statusFile]);
    appendFileSync(statusFile, '{"version":');

    recoveryMocks.verify.mockReturnValue(verifiedGeneration(secondGeneration, "33333333-3333-4333-8333-333333333333"));
    await expect(main(["verify", secondGeneration, "--status-file", statusFile])).rejects.toThrow(/incomplete append.*operator repair/i);

    expect(readRecoveryStatusReceipt(statusFile)).toMatchObject({
      generationId
    });
    expect(readFileSync(statusFile, "utf8")).toContain('{"version":');
  });

  it("treats an exact exclusive publication as committed after a post-publication interruption", () => {
    const directory = temporaryDirectory();
    const generationDirectory = path.resolve(directory, "generation");
    const statusFile = path.resolve(directory, "recovery-status.json");
    const value = recoveryStatusReceiptFromVerification(verifiedGeneration(generationDirectory));

    expect(
      writeProjectRecoveryStatusReceipt(statusFile, value, {
        afterPublish: () => {
          throw new Error("injected post-publication interruption");
        }
      })
    ).toEqual(value);
    expect(readRecoveryStatusReceipt(statusFile)).toEqual(value);
  });

  it("never overwrites a file raced into an initially absent status path", () => {
    const directory = temporaryDirectory();
    const generationDirectory = path.resolve(directory, "generation");
    const statusFile = path.resolve(directory, "recovery-status.json");
    const foreign = "foreign-owner-file";

    expect(() =>
      writeProjectRecoveryStatusReceipt(statusFile, recoveryStatusReceiptFromVerification(verifiedGeneration(generationDirectory)), {
        beforePublish: () => {
          writeFileSync(statusFile, foreign, { mode: 0o600 });
        }
      })
    ).toThrow();
    expect(readFileSync(statusFile, "utf8")).toBe(foreign);
  });

  it("never publishes into a replacement raced over the pinned status parent", () => {
    const directory = temporaryDirectory();
    const operationsDirectory = path.resolve(directory, "operations");
    const reviewedDirectory = path.resolve(directory, "reviewed-operations");
    const generationDirectory = path.resolve(directory, "generation");
    const statusFile = path.resolve(operationsDirectory, "recovery-status.json");
    mkdirSync(operationsDirectory, { mode: 0o700 });

    expect(() =>
      writeProjectRecoveryStatusReceipt(statusFile, recoveryStatusReceiptFromVerification(verifiedGeneration(generationDirectory)), {
        beforePublish: () => {
          renameSync(operationsDirectory, reviewedDirectory);
          mkdirSync(operationsDirectory, { mode: 0o700 });
        }
      })
    ).toThrow(/parent changed/i);

    expect(existsSync(statusFile)).toBe(false);
    expect(existsSync(path.resolve(reviewedDirectory, "recovery-status.json"))).toBe(false);
  });

  it("keeps the publication descriptor pinned and never mutates a replacement path", () => {
    const directory = temporaryDirectory();
    const generationDirectory = path.resolve(directory, "generation");
    const statusFile = path.resolve(directory, "recovery-status.json");
    const reviewedFile = path.resolve(directory, "reviewed-status.json");
    const foreign = "foreign-path-content\n";

    expect(() =>
      writeProjectRecoveryStatusReceipt(statusFile, recoveryStatusReceiptFromVerification(verifiedGeneration(generationDirectory)), {
        afterPublish: () => {
          renameSync(statusFile, reviewedFile);
          writeFileSync(statusFile, foreign, { mode: 0o600 });
        }
      })
    ).toThrow(/receipt changed|path changed/i);

    expect(readFileSync(statusFile, "utf8")).toBe(foreign);
    expect(readRecoveryStatusReceipt(reviewedFile)).not.toBeNull();
  });

  it("never reports success after the published receipt payload changes", () => {
    const directory = temporaryDirectory();
    const generationDirectory = path.resolve(directory, "generation");
    const statusFile = path.resolve(directory, "recovery-status.json");

    expect(() =>
      writeProjectRecoveryStatusReceipt(statusFile, recoveryStatusReceiptFromVerification(verifiedGeneration(generationDirectory)), {
        afterPublish: () => {
          writeFileSync(statusFile, "foreign-published-content\n", { mode: 0o600 });
        }
      })
    ).toThrow(/receipt.*changed|content changed/i);

    expect(readRecoveryStatusReceipt(statusFile)).toBeNull();
  });

  it("closes pinned publication descriptors when catch-side path review fails", () => {
    const directory = temporaryDirectory();
    const generationDirectory = path.resolve(directory, "generation");
    const statusFile = path.resolve(directory, "recovery-status.json");
    const descriptorsBefore = readdirSync("/proc/self/fd").length;

    try {
      expect(() =>
        writeProjectRecoveryStatusReceipt(statusFile, recoveryStatusReceiptFromVerification(verifiedGeneration(generationDirectory)), {
          afterPublish: () => {
            chmodSync(directory, 0o000);
            throw new Error("injected inaccessible publication parent");
          }
        })
      ).toThrow();
    } finally {
      chmodSync(directory, 0o700);
    }

    expect(readdirSync("/proc/self/fd")).toHaveLength(descriptorsBefore);
  });

  it("never appends to a replacement raced over a validated receipt", () => {
    const directory = temporaryDirectory();
    const generationDirectory = path.resolve(directory, "generation");
    const statusFile = path.resolve(directory, "recovery-status.json");
    const reviewedFile = path.resolve(directory, "reviewed-status.json");
    const initial = recoveryStatusReceiptFromVerification(verifiedGeneration(generationDirectory));
    writeProjectRecoveryStatusReceipt(statusFile, initial);
    const accepted = readFileSync(statusFile);
    const foreign = "replacement-owner-file";

    expect(() =>
      writeProjectRecoveryStatusReceipt(statusFile, initial, {
        beforeAppend: () => {
          renameSync(statusFile, reviewedFile);
          writeFileSync(statusFile, foreign, { mode: 0o600 });
        }
      })
    ).toThrow(/changed during publication/i);
    expect(readFileSync(statusFile, "utf8")).toBe(foreign);
    expect(readFileSync(reviewedFile)).toEqual(accepted);
  });

  it("never appends after the permanent lock path is replaced", () => {
    const directory = temporaryDirectory();
    const generationDirectory = path.resolve(directory, "generation");
    const statusFile = path.resolve(directory, "recovery-status.json");
    const lockFile = path.resolve(directory, ".recovery-status.lock");
    const reviewedLockFile = path.resolve(directory, "reviewed-recovery-status.lock");
    const initial = recoveryStatusReceiptFromVerification(verifiedGeneration(generationDirectory));
    writeProjectRecoveryStatusReceipt(statusFile, initial);
    const accepted = readFileSync(statusFile);

    expect(() =>
      writeProjectRecoveryStatusReceipt(statusFile, initial, {
        beforeAppend: () => {
          renameSync(lockFile, reviewedLockFile);
          writeFileSync(lockFile, "", { mode: 0o600 });
        }
      })
    ).toThrow(/lock path changed/i);

    expect(readFileSync(statusFile)).toEqual(accepted);
    expect(readRecoveryStatusReceipt(statusFile)).toEqual(initial);
  });

  it("fails closed when a concurrent write changes the journal after append", () => {
    const directory = temporaryDirectory();
    const generationDirectory = path.resolve(directory, "generation");
    const statusFile = path.resolve(directory, "recovery-status.json");
    const initial = recoveryStatusReceiptFromVerification(verifiedGeneration(generationDirectory));
    writeProjectRecoveryStatusReceipt(statusFile, initial);

    expect(() =>
      writeProjectRecoveryStatusReceipt(statusFile, initial, {
        afterAppend: () => appendFileSync(statusFile, "foreign-journal-record\n")
      })
    ).toThrow(/size or link count changed|journal.*changed/i);
    expect(readRecoveryStatusReceipt(statusFile)).toBeNull();
  });

  it("rejects an otherwise valid hard-linked receipt", () => {
    const directory = temporaryDirectory();
    const generationDirectory = path.resolve(directory, "generation");
    const statusFile = path.resolve(directory, "recovery-status.json");
    const hardLink = path.resolve(directory, "recovery-status-copy.json");
    const value = recoveryStatusReceiptFromVerification(verifiedGeneration(generationDirectory));
    writeFileSync(statusFile, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    linkSync(statusFile, hardLink);

    expect(() => writeProjectRecoveryStatusReceipt(statusFile, value)).toThrow(/hard-link count/i);
    expect(readRecoveryStatusReceipt(statusFile)).toBeNull();
  });

  it("rejects a hard-linked permanent writer lock without touching the receipt path", () => {
    const directory = temporaryDirectory();
    const generationDirectory = path.resolve(directory, "generation");
    const statusFile = path.resolve(directory, "recovery-status.json");
    const lockFile = path.resolve(directory, ".recovery-status.lock");
    const lockAlias = path.resolve(directory, "recovery-status-lock-alias");
    const value = recoveryStatusReceiptFromVerification(verifiedGeneration(generationDirectory));
    writeFileSync(lockFile, "", { mode: 0o600 });
    linkSync(lockFile, lockAlias);

    expect(() => writeProjectRecoveryStatusReceipt(statusFile, value)).toThrow(/lock file.*hard link/i);
    expect(existsSync(statusFile)).toBe(false);
  });

  it("rejects invalid UTF-8 in an otherwise valid receipt journal", () => {
    const directory = temporaryDirectory();
    const generationDirectory = path.resolve(directory, "generation");
    const statusFile = path.resolve(directory, "recovery-status.json");
    const value = recoveryStatusReceiptFromVerification(verifiedGeneration(generationDirectory));
    const corrupted = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    const valuePrefix = Buffer.from('"sourceGeneration":"', "utf8");
    const sourceOffset = corrupted.indexOf(valuePrefix) + valuePrefix.byteLength;
    expect(sourceOffset).toBeGreaterThan(valuePrefix.byteLength);
    corrupted[sourceOffset] = 0xff;
    writeFileSync(statusFile, corrupted, { mode: 0o600 });

    expect(readRecoveryStatusReceipt(statusFile)).toBeNull();
    expect(() => writeProjectRecoveryStatusReceipt(statusFile, value)).toThrow(/valid UTF-8/i);
  });

  it("serializes real concurrent writers before near-limit inspection and append", async () => {
    const directory = temporaryDirectory();
    const generationDirectory = path.resolve(directory, "generation");
    const statusFile = path.resolve(directory, "recovery-status.json");
    const lockFile = path.resolve(directory, ".recovery-status.lock");
    const value = recoveryStatusReceiptFromVerification(verifiedGeneration(generationDirectory));
    const line = `${JSON.stringify(value)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    const initialLineCount = Math.floor(PROJECT_RECOVERY_STATUS_JOURNAL_MAX_BYTES / lineBytes) - 1;
    writeFileSync(statusFile, line.repeat(initialLineCount), { mode: 0o600 });
    const initialSize = statSync(statusFile).size;
    const releaseAt = Date.now() + 1_000;

    const outcomes = await Promise.all([runReceiptWriterProcess(statusFile, value, releaseAt), runReceiptWriterProcess(statusFile, value, releaseAt)]);
    expect(outcomes.map(({ code }) => code).sort()).toEqual([0, 1]);
    expect(outcomes.find(({ code }) => code === 1)?.stderr).toMatch(/journal is full/i);
    expect(statSync(statusFile).size).toBe(initialSize + lineBytes);
    expect(statSync(statusFile).size).toBeLessThanOrEqual(PROJECT_RECOVERY_STATUS_JOURNAL_MAX_BYTES);
    expect(readRecoveryStatusReceipt(statusFile)).toEqual(value);
    expect(statSync(lockFile).nlink).toBe(1);
    expect(statSync(lockFile).size).toBe(0);
    expect(statSync(lockFile).mode & 0o777).toBe(0o600);
  }, 10_000);

  it("never overwrites recovery input or an unrelated owner-only file", async () => {
    const directory = temporaryDirectory();
    const generationDirectory = path.resolve(directory, "generation");
    const dumpFile = path.resolve(generationDirectory, "postgres.dump");
    const unrelatedDirectory = path.resolve(directory, "unrelated");
    const unrelatedFile = path.resolve(unrelatedDirectory, "recovery-status.json");
    const brokenLink = path.resolve(directory, "recovery-status.json");
    mkdirSync(generationDirectory, { mode: 0o700 });
    mkdirSync(unrelatedDirectory, { mode: 0o700 });
    writeFileSync(dumpFile, "verified-dump-must-survive", { mode: 0o600 });
    writeFileSync(unrelatedFile, "unrelated-owner-file", { mode: 0o600 });
    symlinkSync(path.resolve(directory, "missing-receipt"), brokenLink);
    recoveryMocks.verify.mockReturnValue(verifiedGeneration(generationDirectory));

    await expect(main(["verify", generationDirectory, "--status-file", dumpFile])).rejects.toThrow(/outside the verified generation/i);
    expect(readFileSync(dumpFile, "utf8")).toBe("verified-dump-must-survive");

    await expect(main(["verify", generationDirectory, "--status-file", unrelatedFile])).rejects.toThrow(/not a valid receipt|no committed receipt|hard-link count/i);
    expect(readFileSync(unrelatedFile, "utf8")).toBe("unrelated-owner-file");

    await expect(main(["verify", generationDirectory, "--status-file", brokenLink])).rejects.toThrow(/regular non-symlink file/i);
    expect(lstatSync(brokenLink).isSymbolicLink()).toBe(true);

    await expect(main(["verify", generationDirectory, "--status-file", path.resolve(directory, ".secret")])).rejects.toThrow(/basename must be recovery-status\.json/i);
  });

  it("requires an explicit normalized absolute status path", async () => {
    const generationDirectory = path.resolve(temporaryDirectory(), "generation");
    recoveryMocks.verify.mockReturnValue(verifiedGeneration(generationDirectory));
    await expect(main(["verify", generationDirectory, "--status-file", "relative-status.json"])).rejects.toThrow(/normalized absolute path/);
  });

  it("rejects status publication for commands other than verify", async () => {
    const directory = temporaryDirectory();
    await expect(main(["backup", "--output", path.resolve(directory, "generation"), "--status-file", path.resolve(directory, "status.json")])).rejects.toThrow(/supported only by recovery:verify/);
    expect(recoveryMocks.backup).not.toHaveBeenCalled();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "saltanat-recovery-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function verifiedGeneration(generationDirectory: string, selectedGenerationId = generationId) {
  return {
    generationDirectory,
    manifest: {
      generationId: selectedGenerationId,
      releaseCommit,
      capture: { spanMs: 1_234 },
      postgres: {
        database: "saltanatbotv2_private",
        owner: "database-owner",
        migrations: Array.from({ length: 11 }, (_, index) => ({
          version: index + 1
        }))
      }
    }
  };
}

function runReceiptWriterProcess(statusFile: string, receipt: ReturnType<typeof recoveryStatusReceiptFromVerification>, releaseAt: number): Promise<{ code: number | null; stderr: string }> {
  const writerModule = new URL("../../scripts/lib/project-recovery-status.mjs", import.meta.url).href;
  const workerSource = `
    import { writeProjectRecoveryStatusReceipt } from ${JSON.stringify(writerModule)};
    const [statusFile, encodedReceipt, releaseAt] = process.argv.slice(1);
    const receipt = JSON.parse(Buffer.from(encodedReceipt, "base64url").toString("utf8"));
    try {
      writeProjectRecoveryStatusReceipt(statusFile, receipt, {
        beforeAppend: () => {
          while (Date.now() < Number(releaseAt)) {}
        }
      });
    } catch (error) {
      process.stderr.write(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  `;
  const encodedReceipt = Buffer.from(JSON.stringify(receipt), "utf8").toString("base64url");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", workerSource, statusFile, encodedReceipt, String(releaseAt)], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
}
