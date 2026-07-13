// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  classifyPwaLaunchFile,
  collectPwaLaunchFiles,
  pwaLaunchFileLimit,
  registerPwaFileLaunch,
  type PwaLaunchParams
} from "../src/pwa/fileLaunch";

describe("installed PWA file launches", () => {
  it("accepts only the three exact local research extensions", () => {
    expect(classifyPwaLaunchFile("Study.PINE")).toBe("pine");
    expect(classifyPwaLaunchFile("breakout.strategy")).toBe("strategy");
    expect(classifyPwaLaunchFile("tools.saltanat-plugin")).toBe("plugin");
    expect(classifyPwaLaunchFile("strategy.json")).toBeUndefined();
    expect(classifyPwaLaunchFile("orders.csv")).toBeUndefined();
    expect(classifyPwaLaunchFile("fake.strategy.exe")).toBeUndefined();
  });

  it("collects bounded file metadata without reading contents", async () => {
    const file = new File(["//@version=6"], "local.pine", { type: "text/plain" });
    const text = vi.fn(async () => "//@version=6");
    Object.defineProperty(file, "text", { value: text });
    const batch = await collectPwaLaunchFiles([{ name: file.name, getFile: async () => file }]);

    expect(batch.files).toEqual([{ kind: "pine", name: "local.pine", file }]);
    expect(batch.rejected).toEqual([]);
    expect(text).not.toHaveBeenCalled();
  });

  it("rejects spoofed, oversized, unreadable and excess handles", async () => {
    const valid = new File(["x"], "valid.strategy");
    const spoofed = new File(["x"], "changed.json");
    const tooLarge = new File([new Uint8Array(pwaLaunchFileLimit("pine") + 1)], "large.pine");
    const handles = [
      { name: valid.name, getFile: async () => valid },
      { name: "claimed.strategy", getFile: async () => spoofed },
      { name: tooLarge.name, getFile: async () => tooLarge },
      { name: "broken.pine", getFile: async () => { throw new Error("denied"); } },
      { name: "generic.json", getFile: async () => new File(["{}"], "generic.json") },
      ...Array.from({ length: 7 }, (_, index) => ({
        name: `extra-${index}.pine`,
        getFile: async () => new File(["x"], `extra-${index}.pine`)
      }))
    ];

    const batch = await collectPwaLaunchFiles(handles);
    expect(batch.files.map((item) => item.file.name)).toEqual(["valid.strategy", ...Array.from({ length: 5 }, (_, index) => `extra-${index}.pine`)]);
    expect(batch.rejected.map((item) => item.reason)).toEqual(expect.arrayContaining(["too_many", "unsupported", "too_large", "unreadable"]));
  });

  it("feature-detects launchQueue and delivers every non-empty launch", async () => {
    let consumer: ((params: PwaLaunchParams) => void) | undefined;
    const received = vi.fn();
    expect(registerPwaFileLaunch({}, received)).toBe(false);
    expect(registerPwaFileLaunch({ launchQueue: { setConsumer: () => { throw new Error("blocked"); } } }, received)).toBe(false);
    expect(registerPwaFileLaunch({ launchQueue: { setConsumer: (next) => { consumer = next; } } }, received)).toBe(true);

    consumer?.({ files: [] });
    expect(received).not.toHaveBeenCalled();
    const file = new File(["x"], "one.pine");
    consumer?.({ files: [{ name: file.name, getFile: async () => file }] });
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(1));
    expect(received.mock.calls[0]?.[0].files[0]).toMatchObject({ kind: "pine", name: "one.pine" });
  });
});
